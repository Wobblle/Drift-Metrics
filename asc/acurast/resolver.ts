// ============================================================================
// resolver.ts — ASC v0.2 Raid Resolver  (Acurast TEE worker)
// ----------------------------------------------------------------------------
// Per-invocation work for any Asleepius product running Layer 3 raids
// (canonically: Sky Scaffold dataome uplink). On each Acurast schedule tick:
//
//   1. Sweep any 'open' raids past deadline → 'burnt_deadline'
//      (calls scan_raids_for_deadlines() — pure SQL, idempotent).
//   2. Find raids with status='ready_to_resolve' (pool fully filled).
//   3. For each, generate cryptographic randomness inside the TEE,
//      call resolve_raid(raid_id, dice). The TEE attestation is what
//      makes the dice trustworthy — operator cannot tamper mid-run.
//   4. Log outcomes.
//
// RUNTIME:
//   Same as ../acurast/job.ts — Acurast NodeJSWithBundle. Env via _STD_.env.
//   Bundle via esbuild (mirror ../acurast/build.ts).
//
// REQUIRED ENV (declared in your acurast.json includeEnvironmentVariables,
//               value supplied via .env at deploy time):
//   SUPABASE_URL           https://<scaffold-ledger>.supabase.co
//   SUPABASE_SERVICE_KEY   service_role JWT
//
// OPTIONAL ENV:
//   WORKER_ID              defaults to "raid-resolver-<random>"
//   MAX_RAIDS_PER_TICK     defaults to 5 (caps work per invocation)
//
// THIS FILE IS NOT YET DEPLOYED. It lives in asc/acurast/ as a master copy.
// To deploy: copy into your product's acurast/ folder, set up build.ts +
// acurast.json mirroring Drift's pattern, and `npx acurast deploy`.
// See ../README.md and ../../HANDOFF.md for the deployment context.
// ============================================================================

declare const _STD_: { env: Record<string, string | undefined> } | undefined;
declare const process: { env: Record<string, string | undefined> } | undefined;

function getEnv(): Record<string, string | undefined> {
  // deno-lint-ignore no-explicit-any
  const std = (globalThis as any)._STD_;
  if (std && std.env) return std.env;
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process;
  if (proc && proc.env) return proc.env;
  return {};
}

const env = getEnv();

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY  = env.SUPABASE_SERVICE_KEY;
const WORKER_ID    = env.WORKER_ID ||
  `raid-resolver-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 8)}`;
const MAX_RAIDS_PER_TICK = Math.max(1, Number(env.MAX_RAIDS_PER_TICK || "5"));

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error(
    "FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set " +
    "(check acurast.json includeEnvironmentVariables and .env)",
  );
}

const URL_BASE = SUPABASE_URL.replace(/\/+$/, "");

const H: Record<string, string> = {
  "apikey":        SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type":  "application/json",
};

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${WORKER_ID} ${msg}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// VERIFIABLE RANDOMNESS
// ----------------------------------------------------------------------------
// We use crypto.getRandomValues (Web Crypto) inside the TEE. The Acurast
// attestation chain is what makes this trustworthy: the operator cannot
// inject a chosen dice value because the attested image runs the same
// code on every processor and the TEE sealed-execution prevents
// post-deploy tampering.
//
// For higher-stakes raids you can swap this for a commit-reveal scheme
// (commit hash on-chain at mint time, reveal at resolve) or a VRF.
// The signature below stays the same; only `randomUnitInterval()` changes.
// ----------------------------------------------------------------------------

function randomUnitInterval(): number {
  // 53 bits of randomness → uniform [0, 1)
  const buf = new Uint32Array(2);
  // deno-lint-ignore no-explicit-any
  const c = (globalThis as any).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    // No crypto — refuse to proceed. We must NOT silently fall back to
    // Math.random(); the whole point of TEE resolution is verifiable RNG.
    throw new Error("crypto.getRandomValues unavailable; refusing weak RNG");
  }
  c.getRandomValues(buf);
  // Combine: top 21 bits + 32 bits → 53 bits, divide by 2^53
  const hi = (buf[0] >>> (32 - 21));            // 21 bits
  const lo = buf[1] >>> 0;                      // 32 bits
  return (hi * 0x100000000 + lo) / Math.pow(2, 53);
}

// ----------------------------------------------------------------------------
// SUPABASE CALLS
// ----------------------------------------------------------------------------

interface ReadyRaid {
  raid_id: string;
  code: string;
  target_resources: number;
  status: string;
  created_at: string;
}

async function sweepDeadlines(): Promise<number> {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/scan_raids_for_deadlines`, {
    method: "POST", headers: H, body: "{}",
  });
  if (!r.ok) throw new Error(`sweep failed: HTTP ${r.status}`);
  const body = await r.json();
  return Number(body || 0);
}

async function findReadyRaids(limit: number): Promise<ReadyRaid[]> {
  const url = `${URL_BASE}/rest/v1/raids` +
    `?status=eq.ready_to_resolve` +
    `&select=raid_id,code,target_resources,status,created_at` +
    `&order=created_at.asc` +
    `&limit=${limit}`;
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`find_ready failed: HTTP ${r.status}`);
  return await r.json() as ReadyRaid[];
}

async function resolveOne(raidId: string, dice: number): Promise<unknown> {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/resolve_raid`, {
    method: "POST", headers: H,
    body: JSON.stringify({ p_raid_id: raidId, p_dice: dice }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`resolve failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
  }
  return await r.json();
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

async function runOnce(): Promise<number> {
  // Mild jitter to avoid every TEE in the fleet hammering at the same
  // wall-clock instant. Not as critical as siphon (no captcha risk),
  // but still good behavior for shared Supabase free-tier load.
  const jitterMs = Math.floor(Math.random() * 5_000);
  log(`online; max ${MAX_RAIDS_PER_TICK} raids/tick; jitter ${jitterMs}ms`);
  await new Promise((r) => setTimeout(r, jitterMs));

  // 1. Sweep deadlines
  let burnt = 0;
  try {
    burnt = await withTimeout(sweepDeadlines(), 20_000, "sweep");
    if (burnt > 0) log(`swept ${burnt} deadline burns`);
  } catch (e) {
    log(`sweep error: ${e instanceof Error ? e.message : String(e)}`);
    // continue anyway — sweep failure shouldn't block resolution
  }

  // 2. Find ready raids
  let ready: ReadyRaid[] = [];
  try {
    ready = await withTimeout(findReadyRaids(MAX_RAIDS_PER_TICK), 15_000, "find_ready");
  } catch (e) {
    log(`find_ready error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (ready.length === 0) {
    log("no ready raids");
    return 0;
  }
  log(`found ${ready.length} ready raids to resolve`);

  // 3. Resolve each
  let success = 0;
  for (const raid of ready) {
    const short = raid.raid_id.slice(0, 8);
    const dice = randomUnitInterval();
    try {
      const result = await withTimeout(
        resolveOne(raid.raid_id, dice), 20_000, `resolve(${short})`,
      );
      const r = result as {
        ok?: boolean; raid_status?: string; p_fail?: number;
        eligible_count?: number; share_per_winner?: number;
      };
      if (r.ok) {
        log(
          `resolved ${short} code=${raid.code} status=${r.raid_status} ` +
          `dice=${dice.toFixed(4)} p_fail=${r.p_fail} ` +
          `eligible=${r.eligible_count ?? '-'} share=${r.share_per_winner ?? '-'}`,
        );
        success++;
      } else {
        log(`resolve ${short} returned not-ok: ${JSON.stringify(result)}`);
      }
    } catch (e) {
      log(`resolve error ${short}: ${e instanceof Error ? e.message : String(e)}`);
      // Do NOT mark the raid failed. Leave at 'ready_to_resolve' so the
      // next worker tick retries. resolve_raid is atomic; partial state
      // cannot leak.
    }
  }

  log(`tick complete: ${success}/${ready.length} resolved, ${burnt} deadline-burnt`);
  return success === ready.length ? 0 : 4;
}

// ----------------------------------------------------------------------------
// ENTRY
// ----------------------------------------------------------------------------

runOnce()
  .then((code) => {
    if (code !== 0) {
      throw new Error(`runOnce returned non-zero exit code: ${code}`);
    }
  })
  .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[fatal] runOnce: ${msg}`);
    throw e;
  });

export default runOnce;
