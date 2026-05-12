# Telemetry Trench — Acurast Verifier

Pulls `trench_runs` rows in `audit_status='pending'`, re-runs the deterministic
combat engine against the frozen inputs on TEE hardware, and stamps
`audit_status='verified'` (byte-match) or `'mismatch'` (drift detected) via
the `trench_finish_audit` RPC.

**This is NOT in the player critical path.** The client (`trench_practice.html`
in Bureau mode) writes results to drift directly. This worker runs
independently on a 15-minute interval and provides after-the-fact audit.

## Why audit, not resolve?

The combat engine is deterministic. Same inputs ⇒ same outputs, byte-for-byte.
Storing inputs + outputs in `trench_runs` and re-running them later on TEE
hardware gives the same security guarantee as routing the player through the
TEE in the first place, **without** the player having to wait on a TEE
roundtrip. Mismatches surface tampering after the fact.

## File map

```
verifier.ts        — Acurast TEE entry point. Imports combat_engine.js and
                     trench_items.json (bundled at build time).
build.ts           — esbuild bundler. Outputs dist/trench_verifier.bundle.js.
deno.json          — Deno import map (esbuild + plugin).
acurast.json       — Acurast deployment config. Interval: 15 min.
README.md          — This file.
```

## Build

From `acurast/trench-verifier/`:

```sh
deno run -A build.ts
```

Produces `dist/trench_verifier.bundle.js`.

## Deploy

From `acurast/trench-verifier/`:

```sh
# First-time deploy
acurast deploy

# Update later (mutability is "Mutable")
acurast deploy
```

Environment variables (set via `.env` in this directory or in the Acurast deploy):

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_KEY=eyJ...   # service role — bypasses RLS, calls audit RPCs
AUDIT_BATCH_SIZE=10           # optional, default 10
AUDIT_TIMEOUT_MS=60000        # optional, default 60s
```

## Smoke test locally (no Acurast)

You can run the bundle as a plain Node script for sanity:

```sh
# After deno run -A build.ts produces the bundle:
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_KEY=eyJ... \
node dist/trench_verifier.bundle.js
```

Single invocation. Claims a batch, audits, exits.

## What gets compared

For each `trench_runs` row:
- `winner` exactly matches the replay.
- `final_state` (canonicalised with stable key ordering) matches byte-for-byte.

Either disagreement ⇒ `audit_status='mismatch'`, with the mismatch reason in
`audit_notes`. Operator should investigate any mismatch — it indicates either:
1. Client tampering (most likely if isolated).
2. Engine version drift (recorded `engine_version` differs from verifier's;
   audited as `verified` but flagged in notes).
3. Inputs that no longer round-trip through Postgres jsonb cleanly (unlikely
   since we use stable JSON sort).

## Backpressure

`trench_claim_audit_batch` uses `SELECT … FOR UPDATE SKIP LOCKED`, so multiple
verifier replicas can run safely in parallel without claiming the same row.
The job runs once every 15 minutes with `numberOfReplicas: 1` by default —
plenty of throughput for a manual-mint launch window. Bump replicas if the
backlog grows.
