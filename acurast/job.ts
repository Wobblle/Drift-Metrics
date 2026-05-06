// ============================================================================
// job.ts — DriftMetrics Acurast TEE worker entry
// ----------------------------------------------------------------------------
// Run-once invocation pattern. Acurast's scheduler invokes this entry point
// on each processor on a regular interval (configured in acurast.json).
// Each invocation:
//
//   1. Calls claim_next_job RPC on Supabase to grab one pending row.
//   2. If a row was returned, runs the siphon scan against the keyword.
//   3. POSTs the resulting Displacement Report to /rest/v1/reports.
//   4. DELETEs the queue row (keeps the table near zero on free tier).
//
// If no row was available, exits cleanly with no work performed.
//
// The TEE decrypts SUPABASE_SERVICE_KEY only inside the enclave. The
// processor operator cannot read it. Acurast's attestation guarantees this.
//
// Required environment (set via Acurast secrets):
//   SUPABASE_SERVICE_KEY   service_role JWT
//
// Required environment (set via Acurast env, non-secret):
//   SUPABASE_URL           https://<project>.supabase.co
//
// Optional:
//   WORKER_ID              defaults to "acurast-<random>"
//   SIPHON_TIMEOUT_MS      defaults to 180000 (3 minutes)
// ============================================================================

import { runScan } from "./siphon.ts";

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_KEY");
const WORKER_ID    = Deno.env.get("WORKER_ID") ||
  `acurast-${crypto.randomUUID().slice(0, 8)}`;
const SIPHON_TIMEOUT_MS = Number(
  Deno.env.get("SIPHON_TIMEOUT_MS") || "180000",
);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  Deno.exit(1);
}

const URL_BASE = SUPABASE_URL.replace(/\/+$/, "");

const H: Record<string, string> = {
  "apikey":        SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type":  "application/json",
};

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${WORKER_ID} ${msg}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | undefined;
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
// SUPABASE CALLS
// ----------------------------------------------------------------------------

interface JobRow {
  id: string;
  request_id: string;
  keyword: string;
  status: string;
  // ... other columns we don't care about here
}

async function claim(): Promise<JobRow | null> {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/claim_next_job`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ p_worker_id: WORKER_ID }),
  });
  if (!r.ok) throw new Error(`claim failed: HTTP ${r.status}`);
  const body = await r.json();
  if (!body || !body.id) return null;
  return body as JobRow;
}

async function postReport(
  requestId: string, keyword: string, payload: unknown,
): Promise<void> {
  const r = await fetch(`${URL_BASE}/rest/v1/reports`, {
    method: "POST",
    headers: { ...H, "Prefer": "return=minimal" },
    body: JSON.stringify({
      request_id: requestId,
      keyword,
      payload,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`post_report failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
  }
}

async function deleteJob(jobId: string): Promise<void> {
  const r = await fetch(
    `${URL_BASE}/rest/v1/query_queue?id=eq.${encodeURIComponent(jobId)}`,
    { method: "DELETE", headers: { ...H, "Prefer": "return=minimal" } },
  );
  if (!r.ok) {
    throw new Error(`delete_job failed: HTTP ${r.status}`);
  }
}

async function markFailed(jobId: string): Promise<void> {
  // Best-effort. If this fails, the stale-job sweeper will requeue it
  // after 5 minutes via requeue_stale_jobs().
  try {
    await fetch(
      `${URL_BASE}/rest/v1/query_queue?id=eq.${encodeURIComponent(jobId)}`,
      {
        method: "PATCH",
        headers: { ...H, "Prefer": "return=minimal" },
        body: JSON.stringify({ status: "failed" }),
      },
    );
  } catch (_e) { /* swallow */ }
}

// ----------------------------------------------------------------------------
// MAIN — single invocation. Acurast schedules repeated invocations.
// ----------------------------------------------------------------------------

async function runOnce(): Promise<number> {
  // ---------------------------------------------------------------------
  // STARTUP JITTER (CRITICAL)
  // ---------------------------------------------------------------------
  // Acurast's scheduler may trigger many processors at the exact same
  // scheduled instant. Without this jitter, the fleet hits Bing/Yahoo/DDG
  // simultaneously and looks like a coordinated bot — fastest known way
  // to get every IP in the fleet captcha-walled at once.
  //
  // 0-45s random delay distributes outbound requests across the window.
  // Combined with a 30-60s scheduling interval, no two processors should
  // ever issue an outbound scrape within the same second.
  // ---------------------------------------------------------------------
  const jitterMs = Math.floor(Math.random() * 45_000);
  log(`online; siphon timeout ${SIPHON_TIMEOUT_MS}ms; jitter ${jitterMs}ms`);
  await new Promise((r) => setTimeout(r, jitterMs));

  // 1. Claim
  let job: JobRow | null;
  try {
    job = await withTimeout(claim(), 20_000, "claim");
  } catch (e) {
    log(`claim error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!job) {
    log("no work");
    return 0;
  }
  const jobShort = job.id.slice(0, 8);
  log(`claimed ${jobShort} keyword=${JSON.stringify(job.keyword)}`);

  // 2. Run siphon
  const t0 = performance.now();
  let payload: unknown;
  try {
    payload = await withTimeout(runScan(job.keyword), SIPHON_TIMEOUT_MS, "siphon");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`siphon FAIL ${jobShort}: ${msg}`);
    await markFailed(job.id);
    return 2;
  }
  const dur = ((performance.now() - t0) / 1000).toFixed(1);

  // 3. Publish + cleanup
  try {
    await withTimeout(
      postReport(job.request_id, job.keyword, payload),
      30_000, "post_report",
    );
    await withTimeout(deleteJob(job.id), 20_000, "delete_job");
    const drift = (payload as { drift?: number })?.drift;
    const conf  = (payload as { confidence?: number })?.confidence;
    log(`done ${jobShort} drift=${drift} conf=${conf} t=${dur}s`);
    return 0;
  } catch (e) {
    // Don't mark failed — leave it as 'processing' so requeue_stale_jobs
    // picks it up after 5 minutes. Avoids losing work on transient blips.
    log(`publish error ${jobShort}: ${e instanceof Error ? e.message : e}; sweeper will retry`);
    return 3;
  }
}

// ----------------------------------------------------------------------------
// ENTRY
// ----------------------------------------------------------------------------

if (import.meta.main) {
  const code = await runOnce();
  Deno.exit(code);
}

// Also exported so the bundler keeps it accessible if Acurast invokes a
// named export instead of running the top-level. Verify against current
// Acurast runtime — most versions run main, some require a default export.
export default runOnce;
