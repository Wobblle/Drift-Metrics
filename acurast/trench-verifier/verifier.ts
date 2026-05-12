// ============================================================================
// verifier.ts — Telemetry Trench audit worker (Acurast TEE)
// ----------------------------------------------------------------------------
// Pulls a batch of `trench_runs` rows in audit_status='pending', re-runs the
// pure-deterministic combat engine against each row's frozen inputs on TEE
// hardware, and writes back audit_status='verified' (byte-match) or
// 'mismatch' (drift) via trench_finish_audit RPC.
//
// Runs entirely in NodeJSWithBundle. No filesystem, no spawn, no native deps.
// The engine and items catalog are bundled at build time.
//
// Required env (declared in acurast.json includeEnvironmentVariables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY      (service role — bypasses RLS; service-only RPC)
// Optional:
//   AUDIT_BATCH_SIZE          default 10
//   AUDIT_TIMEOUT_MS          default 60000 (per-batch RPC timeout)
//   WORKER_ID                 default trench-audit-<random>
// ============================================================================

import { simulate, ENGINE_VERSION } from "../../combat_engine.js";
import catalog from "../../trench_items.json" with { type: "json" };

// ----------------------------------------------------------------------------
// ENV
// ----------------------------------------------------------------------------
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
const SUPABASE_URL    = env.SUPABASE_URL;
const SERVICE_KEY     = env.SUPABASE_SERVICE_KEY;
const BATCH_SIZE      = Number(env.AUDIT_BATCH_SIZE || "10");
const TIMEOUT_MS      = Number(env.AUDIT_TIMEOUT_MS || "60000");
const WORKER_ID       = env.WORKER_ID ||
  `trench-audit-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 8)}`;

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

// ----------------------------------------------------------------------------
// CATALOG NORMALIZATION
// ----------------------------------------------------------------------------
// trench_items.json ships as {version, items:[...]}; simulate() wants
// {id: item, ...}. Build the lookup once at bundle init.
// ----------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
const ITEMS_BY_ID: Record<string, any> = {};
// deno-lint-ignore no-explicit-any
for (const it of (catalog as any).items || []) ITEMS_BY_ID[it.id] = it;

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
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

// Stable JSON serialization for byte-exact comparison. Sorts object keys
// recursively. Used because the database may re-serialise jsonb with a
// different key ordering than the engine emits.
// deno-lint-ignore no-explicit-any
function canonicalize(v: any): any {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
  return out;
}
// deno-lint-ignore no-explicit-any
function stableStringify(v: any): string {
  return JSON.stringify(canonicalize(v));
}

// ----------------------------------------------------------------------------
// SUPABASE CALLS
// ----------------------------------------------------------------------------
interface TrenchRunRow {
  run_id: string;
  code: string;
  seed: string;
  drift_score: number | string;
  round_number: number;
  player_board: unknown[];
  ghost_board: unknown[];
  player_starting_state: { phantom_pool?: number; lane_integrity?: number[] } | null;
  winner: string;
  final_state: unknown;
  engine_version: string | null;
}

async function claimBatch(): Promise<TrenchRunRow[]> {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/trench_claim_audit_batch`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ p_limit: BATCH_SIZE, p_worker_id: WORKER_ID }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`claim_audit_batch failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
  }
  const body = await r.json();
  if (!Array.isArray(body)) return [];
  return body as TrenchRunRow[];
}

async function finishAudit(runId: string, status: "verified" | "mismatch" | "error", notes?: string): Promise<void> {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/trench_finish_audit`, {
    method: "POST",
    headers: { ...H, "Prefer": "return=minimal" },
    body: JSON.stringify({ p_run_id: runId, p_status: status, p_notes: notes || null }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`finish_audit failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
  }
}

// ----------------------------------------------------------------------------
// VERIFY ONE
// ----------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function verifyOne(row: TrenchRunRow): { ok: boolean; reason: string; replay?: any } {
  if (!row.seed || typeof row.seed !== "string") {
    return { ok: false, reason: "missing seed in row" };
  }
  // Engine reads drift_score as a number; pg numeric can land as string.
  const drift = typeof row.drift_score === "string" ? Number(row.drift_score) : row.drift_score;
  if (!Number.isFinite(drift)) {
    return { ok: false, reason: "invalid drift_score" };
  }
  let replay;
  try {
    replay = simulate({
      player_board: row.player_board,
      ghost_board:  row.ghost_board,
      drift_score:  drift,
      seed:         row.seed,
      round_number: row.round_number,
      items_catalog: ITEMS_BY_ID,
      player_starting_state: row.player_starting_state || undefined,
    });
  } catch (e) {
    return { ok: false, reason: "engine threw: " + ((e as Error).message || String(e)) };
  }

  if (replay.winner !== row.winner) {
    return {
      ok: false,
      reason: `winner mismatch (recorded=${row.winner} replay=${replay.winner})`,
      replay,
    };
  }
  const recordedFinal = stableStringify(row.final_state);
  const replayFinal   = stableStringify(replay.final_state);
  if (recordedFinal !== replayFinal) {
    return {
      ok: false,
      reason: "final_state mismatch",
      replay,
    };
  }
  if (row.engine_version && row.engine_version !== ENGINE_VERSION) {
    // Not a hard fail — the engine version drift is itself a data point.
    return {
      ok: true,
      reason: `verified (engine version drift: recorded=${row.engine_version} verifier=${ENGINE_VERSION})`,
    };
  }
  return { ok: true, reason: "verified" };
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
async function runOnce(): Promise<number> {
  log(`online; engine ${ENGINE_VERSION}; batch ${BATCH_SIZE}; items ${Object.keys(ITEMS_BY_ID).length}`);

  let batch: TrenchRunRow[];
  try {
    batch = await withTimeout(claimBatch(), TIMEOUT_MS, "claim_batch");
  } catch (e) {
    log(`claim error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (batch.length === 0) {
    log("no work");
    return 0;
  }
  log(`claimed ${batch.length} run(s) for audit`);

  let verified = 0, mismatch = 0, errored = 0;
  for (const row of batch) {
    const short = row.run_id.slice(0, 8);
    const res = verifyOne(row);
    try {
      if (res.ok) {
        await withTimeout(finishAudit(row.run_id, "verified", res.reason), 15_000, `finish ${short}`);
        verified++;
        log(`verified ${short} (${res.reason})`);
      } else {
        // Differentiate engine errors from substantive mismatches.
        const status = res.reason.startsWith("engine threw") || res.reason.startsWith("missing seed") || res.reason.startsWith("invalid drift")
          ? "error" as const
          : "mismatch" as const;
        await withTimeout(finishAudit(row.run_id, status, res.reason), 15_000, `finish ${short}`);
        if (status === "mismatch") {
          mismatch++;
          log(`MISMATCH ${short}: ${res.reason}`);
        } else {
          errored++;
          log(`ERROR ${short}: ${res.reason}`);
        }
      }
    } catch (e) {
      log(`finish_audit network error for ${short}: ${e instanceof Error ? e.message : String(e)}`);
      // Row stays in audit_status='auditing' until the next sweep — operator
      // can manually reset to 'pending' if needed (run_id stuck >5 min).
    }
  }

  log(`done batch: verified=${verified} mismatch=${mismatch} error=${errored}`);
  return mismatch > 0 ? 2 : 0;
}

// Entry point. The Acurast TEE invokes this bundle as a script; the top-level
// await is fine in ESM. We swallow exit codes — Acurast doesn't inspect them.
try {
  await runOnce();
} catch (e) {
  console.error(`fatal: ${e instanceof Error ? e.message : String(e)}`);
}
