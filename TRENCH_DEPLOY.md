# Telemetry Trench — Deploy + Smoke Test

**Last Updated:** 2026-05-12
**ASC version:** v0.2.1 (TRN prefix registered)
**Companion:** `trench.sql`, `trench_practice.html`, `acurast/trench-verifier/`

End-to-end checklist for landing the trench layer in `drift` and running the
first live Bureau-mode submission. Follow top-to-bottom; each phase has a
verifiable smoke step.

---

## 0. Prereqs

- `codes.sql` already deployed in `drift` (it is — that's how `peek_code` and
  `redeem_code` exist).
- The `gen_random_bytes` / `gen_random_uuid` functions exist (default in
  Supabase via `pgcrypto`; verify with `select gen_random_uuid();`).
- Local: `node >= 18`, `deno`, `acurast` CLI (only needed for the verifier).

---

## 1. Land the schema

Run from `psql` on the drift project (or paste into the SQL editor in
Supabase Studio):

```sql
\i G:/Projects/AlgoParallax/Drift-Metrics/trench.sql
```

Expected output ends with:

```
NOTICE:  trench.sql installed cleanly
```

If you see `relation "codes" does not exist`, the root `codes.sql` was never
applied. Apply it first.

**What landed:**

- `trench_runs` table — every Bureau submission lands here verbatim.
- `trench_terminated_pool` table — final boards of R4+ deaths, opt-in opposition.
- RPCs:
  - `trench_peek_code(text)` — anon — validate, no side effects.
  - `trench_start_run(...)` — anon — insert pending run, return server seed.
  - `trench_complete_run(...)` — anon — decrement code, stamp result.
  - `trench_pull_ghost(int)` — anon — random opposition near a round.
  - `trench_claim_audit_batch(int, text)` — service_role — verifier intake.
  - `trench_finish_audit(uuid, text, text)` — service_role — verifier output.
- RLS enabled on both tables. Anon can ONLY touch them through the RPCs.

**Smoke (still in psql):**

```sql
-- Both tables present
select table_name from information_schema.tables
 where table_name in ('trench_runs', 'trench_terminated_pool')
 order by table_name;

-- All RPCs registered
select routine_name from information_schema.routines
 where routine_name like 'trench_%'
 order by routine_name;

-- TRN prefix recognised in mint_code()
select mint_code('TRN-SMOKE-001', 1, '7 days', 'deploy smoke; safe to burn');
-- => returns a row with category='trench_submission', balance=1, expires_at ~ now()+7d

-- Peek it
select trench_peek_code('TRN-SMOKE-001');
-- => {"ok":true,"code":"TRN-SMOKE-001","balance":1,"tier":..,"hidden":..,...}
```

If all four queries succeed, the schema is live.

---

## 2. Mint a real launch code

Two paths — pick one:

### 2a. Via psql (fast, no UI)

```sql
select mint_code(
  'TRN-2026-MAY-A',   -- canonical string; anything matching ^TRN-[A-Z0-9\-]+$
  1,                  -- one run
  '30 days',          -- expiry
  'first live bureau test, May 2026'
);
```

### 2b. Via `ops.local.html` (recommended; visible inventory)

1. Open `G:\Projects\AlgoParallax\Drift-Metrics\ops.local.html` in Chrome
   (file:// or via `python -m http.server`).
2. Confirm the **drift** profile is configured in Settings.
3. Open the **Mint** tab. Prefix dropdown: `TRN`. Suffix: `2026-MAY-A`.
4. Click *mint single*. The row should appear immediately in the **Codes**
   tab.

Either way, you now have one valid `TRN-2026-MAY-A` code in drift with
`balance=1`.

---

## 3. Deploy `trench_practice.html`

The frontend is currently committed alongside `index.html`, `asc.html`, etc.,
and is served from `drift-metrics.com` via GitHub Pages.

```sh
cd G:\Projects\AlgoParallax\Drift-Metrics
git add trench.sql trench_practice.html combat_engine.js combat_engine_runner.js trench_items.json smoke.js ASC_SPEC.md
git add acurast/trench-verifier/
git commit -m "trench: TRN prefix + Bureau mode + Acurast verifier"
git push origin main
```

GitHub Pages will deploy in ~30 seconds. Hit
`https://drift-metrics.com/trench_practice.html` to confirm.

> **Note:** `trench_practice.html` is fully self-contained — the inlined combat
> engine and items catalog mean it works offline. The drift wiring kicks in
> only in **Bureau mode**.

**Local smoke (before pushing):**

```sh
cd G:\Projects\AlgoParallax\Drift-Metrics
node smoke.js
```

Expected: engine prints version, winner, determinism check passes. If this
fails, do NOT push — the engine itself is broken.

---

## 4. First Bureau submission

1. Open `https://drift-metrics.com/trench_practice.html`.
2. Click **BUREAU** in the mode toggle.
3. Click **CONFIGURE DRIFT URL + ANON KEY**.
   - URL: `https://<drift-project-ref>.supabase.co`
   - Anon key: the public anon JWT (NOT service role). Find it in Supabase
     Studio → Project Settings → API → `anon` `public`.
   - Hit **SAVE + TEST**. The status line should turn green with
     "connection OK — saved."
4. Enter `TRN-2026-MAY-A` in the submission code field. Press **CHECK** (or
   Enter).
   - Code status flips to `OK • bal 1 • T<tier>`.
5. Build a board: pick items from the catalog, place them on the grid.
6. Click **SUBMIT TURN**.
   - Log lines will appear:
     - `LODGING SUBMISSION WITH BUREAU...`
     - `BUREAU ACCEPTED // RUN xxxxxxxx... // SEED xxxxxxxxxxxx...`
     - `CODE BALANCE BEFORE: 1`
   - Combat animation plays. Result banner appears.
   - Final log line: `BUREAU LODGED RESULT — balance after: 0`.
7. Code status reverts to "unvalidated" (balance is now 0; you can't reuse).

**Verify in psql (drift):**

```sql
-- The run is recorded
select run_id, code, winner, terminated, completed_at, audit_status
  from trench_runs
 order by started_at desc
 limit 5;

-- Code balance is now zero
select code, balance, use_count, last_used_at from codes where code = 'TRN-2026-MAY-A';
```

You should see `audit_status='pending'` — the Acurast verifier will flip
that to `verified` next.

---

## 5. (Optional) Try the terminated pool

1. Mint another code: `TRN-2026-MAY-B`, balance 1.
2. In Bureau mode, set round to 4 by switching to SANDBOX briefly, sliding to
   round 4, then switching back to BUREAU. (TODO: bureau-mode round input.)
3. Validate the code, build a deliberately weak board, submit.
4. Lose the run. Banner shows "TERMINATED."
5. Verify the pool:

```sql
select pool_id, source_run_id, round_number, jsonb_array_length(board) as item_count, drift_score
  from trench_terminated_pool
 order by added_at desc
 limit 5;
```

6. Mint `TRN-2026-MAY-C`, switch to BUREAU mode, tick **pull opposition from
   terminated pool when available**, submit. The opposition source line
   should read `pool:<uuid>` instead of `synthetic_*`.

---

## 6. Deploy the Acurast verifier

Independent — doesn't block player testing.

```sh
cd G:\Projects\AlgoParallax\Drift-Metrics\acurast\trench-verifier

# Build the ESM bundle (engine + items catalog inlined)
deno run -A build.ts
# => emits dist/trench_verifier.bundle.js

# Sanity-test the bundle locally before deploying to TEE
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_KEY=eyJ... \
node dist/trench_verifier.bundle.js
# => should claim the pending run, audit it, log "verified <runid>"

# Verify audit_status flipped in psql:
#   select run_id, audit_status, audit_notes, audit_worker_id from trench_runs limit 5;

# Deploy to Acurast
acurast deploy   # uses acurast.json in this directory
```

Default schedule: every 15 minutes, single replica. Plenty for the launch
window. Bump `numberOfReplicas` and lower `intervalInMs` if backlog grows.

**Smoke (after Acurast deploy):**

Run the first Bureau submission again with a fresh code. Within 15-20
minutes, `audit_status` should flip from `pending` → `verified` and
`audit_worker_id` should contain the TEE worker's short id.

---

## 7. Watch the pipeline

From the operator console (`ops.local.html`):

- Bridge tab → drift profile activity should now show recent code activity
  from `codes.use_count` bumps.
- Codes tab → `TRN-` rows visible alongside everything else.
- A future **Trench** tab will surface `trench_runs` directly; not yet wired.

For now, use psql for trench visibility:

```sql
-- Recent activity, all statuses
select substr(run_id::text, 1, 8) as run, code, round_number, winner,
       terminated, audit_status,
       to_char(completed_at, 'HH24:MI:SS') as completed
  from trench_runs
 order by started_at desc
 limit 20;

-- Pool growth
select count(*) as pool_size,
       min(round_number) as min_round, max(round_number) as max_round
  from trench_terminated_pool;

-- Audit health
select audit_status, count(*) from trench_runs group by 1;
```

---

## 8. Failure modes & recovery

### "wrong_prefix" from peek/start
Code minted with a non-TRN prefix. Mint a fresh one as TRN-… and retry.

### "active_run_exists"
A prior submission with the same code started but never completed (network
hiccup mid-submit, tab closed before commit). Wait 15 minutes — the active
window expires — or manually clear:
```sql
update trench_runs set completed_at = now(), winner = 'draw', audit_notes = 'manual_clear'
 where code = 'TRN-...' and completed_at is null;
```

### "HTTP 401" from Bureau actions
Anon key wrong, expired, or you accidentally pasted a service-role key (which
would also work but is dangerous in a browser). Open settings, paste the
correct anon key.

### audit_status stuck at `auditing`
A verifier claimed the row, then crashed mid-batch. Manual reset:
```sql
update trench_runs set audit_status = 'pending', audit_worker_id = null
 where audit_status = 'auditing' and audit_at < now() - interval '10 minutes';
```

### Mismatch flagged
`audit_status='mismatch'` indicates the client's recorded result diverged
from a TEE replay. Inspect:
```sql
select run_id, audit_notes, winner, audit_at, engine_version
  from trench_runs
 where audit_status = 'mismatch'
 order by audit_at desc;
```
Most common cause: client running an older `engine_version`. If notes say
`final_state mismatch` with matching versions, treat as a real anomaly.

---

## 9. What's deferred (Phase B)

- **Ops console Trench tab** — list runs with audit status, pool stats, drill
  into a specific run's tick_log. Schema is ready; UI is not.
- **Bureau-mode round selector** — currently the round is inherited from the
  Progress/Sandbox state at mode-switch time. Should be its own input.
- **Code-surface artifact** — a `.txt` postcard template for TRN drops, so
  community-facing codes ship with a hand-authored flavour quote.
- **Cross-mint with Sky Scaffold** — TRN-prefix codes that simultaneously
  unlock something in-game. Waits on Steam-ticket auth (see
  `STEAM_CLOUD_AUTH_NOTES.md`).
- **Anonymous "n other operators recently lodged" counter** — surface
  ambient activity to give Bureau mode a sense of population without
  exposing identifying data.
