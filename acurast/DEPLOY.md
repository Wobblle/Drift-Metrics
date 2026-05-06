# DriftMetrics // Acurast Deploy Reference

`v0.1.0` — TEE-native deployment for the Acurast Root Image fleet

This is the **active** fleet deployment path. The previous
`FLEET_DEPLOYMENT.md` covered Termux self-host, which the Root Image does
not support.

---

## ⚡ QUICK START — Deploy via Acurast Console UI

If you have the Acurast Developer Console open right now, **skip the CLI.**
The Console handles the manifest schema, secret encryption, processor
selection, and scheduling through a UI that's always in sync with the
current network — no field-name guessing required. Use the CLI later for
automation if you want; for the first deploy, the UI is faster and safer.

### Steps

1. **Bundle the job locally** — produces a single self-contained `.js` file:

   ```bash
   cd "G:\Projects\AlgoParallax\Algorithm Parallax\acurast"

   # Deno 2.x (current):
   deno run -A npm:esbuild job.ts \
     --bundle --format=esm --target=es2022 \
     --outfile=dist/job.bundle.js
   ```

   The output `dist/job.bundle.js` should be 150–300 KB (linkedom is the
   bulk of it).

2. **Open the Console** → **Deployments** → **Create Deployment**.

3. **Paste the bundle.** Copy the entire contents of `dist/job.bundle.js`
   into the script field.

4. **Set the environment variables** (use the Console's secret/env section):

   | Name | Type | Value |
   |---|---|---|
   | `SUPABASE_URL` | env (plain) | `https://ojrcarvjtzsynchcexmb.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | **secret** | your service-role JWT |
   | `SIPHON_TIMEOUT_MS` | env (plain) | `180000` |

   The Console encrypts secrets at rest and only injects them into the
   TEE at execution. Don't paste the service-role JWT into the plain-env
   slot.

5. **Configure the schedule.** Use the Console's interval/cron field:

   | Setting | Value | Why |
   |---|---|---|
   | Execution interval | **5–10 minutes** | Frequent enough that user submits get picked up quickly; rare enough to keep Bing happy. The startup jitter inside `job.ts` (0–45s) further spreads requests within each window. |
   | Max executions | unlimited (or omit) | Lets the job run perpetually until paused. |

6. **Network egress allowlist.** In the Console's network/permissions
   section, add these hosts:

   ```
   www.bing.com
   search.yahoo.com
   html.duckduckgo.com
   duckduckgo.com
   en.wikipedia.org
   ojrcarvjtzsynchcexmb.supabase.co
   ```

7. **Processor selection.** Choose **"my own processors"** (or whatever
   the Console calls "private fleet" in your version). Do **not** push
   this to the public network — your service-role key would be exposed
   to processors you don't own.

8. **CRITICAL — start with 5 processors, NOT 30.** When the Console asks
   how many of your processors to assign, pick **5**. Save the deployment.
   Watch the queue/reports tables for an hour. Only scale up after you've
   confirmed:
   - Reports are flowing in
   - No "siphon FAIL" entries dominating the logs
   - Bing isn't returning captchas
   - `_debug.enclosure_tokens` in reports is non-zero (proves scrapes worked)

   Then bump to 10. Watch another hour. Then 15. Then 20. Then full 30.

   The reason: if any of those checks fail, the cause is almost always
   detection by Bing/DDG. With 5 processors, you can fix and redeploy
   without burning the IP reputation of the other 25 in your pool.

9. **Save & deploy.** The Console returns a deployment ID. Copy it.

### Verify it's working

In the Console, open the deployment → **Logs** tab. You should see lines
like:

```
[2026-05-06T...] acurast-7a3f9b online; siphon timeout 180000ms; jitter 18324ms
[2026-05-06T...] acurast-7a3f9b no work
[2026-05-06T...] acurast-c8e21d online; siphon timeout 180000ms; jitter 6011ms
[2026-05-06T...] acurast-c8e21d claimed 9301-7f4a keyword="ai coding assistants"
[2026-05-06T...] acurast-c8e21d done 9301-7f4a drift=0.794 conf=0.91 t=21.3s
```

Most lines will be `no work` — that's correct, the queue is usually empty.
Submit a query from the frontend and watch a `claimed` line appear within
the next 5–10 minute scheduling window.

In the Supabase SQL editor:

```sql
select count(*), max(created_at) from reports
 where created_at > now() - interval '15 minutes';
```

Non-zero count + recent timestamp = fleet is healthy.

### Gradual rollout decision tree

```
Deploy to 5 processors
   ↓
Wait 1 hour, check logs and reports table
   ↓
   ├─ Reports flowing, no failures   → scale to 10
   ├─ Some 'siphon FAIL' but reports → investigate FAIL root cause first
   └─ Zero reports / all FAIL        → DO NOT SCALE; debug
   ↓
After 10 healthy processors for 1 hour → scale to 15
   ↓
After 15 healthy for 1 hour → scale to 20
   ↓
... continue to 30
```

If at any point you see a sudden spike in failures, the most likely cause
is IP-pool detection — pause the deployment, wait an hour, re-deploy at
half the previous count.

---

## CLI / Manifest Path (for automation later)

If you prefer scripted deployment over the Console UI, the rest of this
document covers the CLI workflow. **For the first deploy of a new fleet,
use the Console.** Come back here once the architecture is proven and
you want CI/CD around redeploys.

---

## 0 // What this deploys

Three files in `acurast/`:

| File | Role |
|---|---|
| `siphon.ts` | The scraping engine. Pure-TS port of `siphon.py`. |
| `job.ts` | Acurast job entry. One claim → siphon → post → delete cycle per invocation. Exits cleanly when no work. |
| `acurast.json` | Deployment manifest: schedule, network allowlist, secrets, processor selection. |

The architecture mirrors the Termux worker pattern exactly. The only
differences: TypeScript instead of Python, Deno fetch instead of requests,
linkedom instead of BeautifulSoup, run-once invocation instead of a loop.

```
[Frontend] →[Edge Function: submit] →[Postgres queue]
                                           ↓
                       [Acurast schedules job every 30s × 30 processors]
                                           ↓
[TEE: claim_next_job → siphon → post_report → delete_job] →[reports table]
                                                                    ↓
                                                              [Frontend polls]
```

---

## 1 // BEFORE YOU READ FURTHER — verify the manifest

Before running any deploy command, **diff `acurast/acurast.json` against
the current Acurast docs**. The manifest schema and CLI commands evolve.

Open https://docs.acurast.com and confirm:

```
[ ] Top-level field names in acurast.json match the current schema
[ ] Network allowlist field name and value format (hostname vs URL)
[ ] Processor selection mode names (by_owner, by_attestation, by_device_ids)
[ ] Schedule format (interval, cron, one-shot)
[ ] Secret declaration syntax
[ ] Whether 'consumers.fund_address' is required for owned-fleet jobs
```

If any of those don't match, edit `acurast.json` to fit the current schema
**before** deploying. The structural intent is right; only field names
should drift.

The CLI commands in this doc (`acurast deploy`, `acurast secrets set`)
likewise need verification. The Acurast CLI has been called
`acurast`, `acurast-cli`, `@acurast/cli`, and `pnpm acurast` in
different releases. Confirm the binary name from the docs and substitute.

---

## 2 // ONE-TIME SETUP

### 2.1 Install Deno (for bundling)

```bash
# Windows PowerShell:
irm https://deno.land/install.ps1 | iex

# macOS / Linux:
curl -fsSL https://deno.land/install.sh | sh
```

### 2.2 Install the Acurast CLI

```bash
# Verify the package name against current docs first.
npm i -g @acurast/cli
acurast --version
acurast login        # walks you through wallet linking
```

### 2.3 Confirm your wallet address

Find your Acurast wallet/owner address (Polkadot SS58 format). You'll need
this to fill `processors.owner_address` and `consumers.fund_address` in
`acurast.json`.

```bash
acurast whoami       # exact command may differ; verify
```

### 2.4 Replace placeholders in `acurast.json`

```
[ ] REPLACE_WITH_YOUR_ACURAST_WALLET_ADDRESS  (in 2 places)
[ ] Confirm SUPABASE_URL matches your project
[ ] Delete the _NOTE_TO_OPERATOR block at the top
[ ] Delete every "_comment" / "_comment_*" key (some validators reject)
```

---

## 3 // BUNDLE THE JOB

The TEE runtime executes a single self-contained JS file. Bundle
`job.ts` (which imports `siphon.ts` and the `linkedom` npm package) into
one file:

```bash
cd "G:\Projects\AlgoParallax\Algorithm Parallax\acurast"

# Old Deno (1.x): deno bundle is the standard tool.
deno bundle --no-check job.ts dist/job.bundle.js

# Newer Deno (2.x): deno bundle was removed; use deno_emit or esbuild.
# Option A — npm esbuild via deno run:
deno run -A npm:esbuild job.ts \
  --bundle --format=esm --target=es2022 \
  --outfile=dist/job.bundle.js

# Option B — deno_emit (pure Deno, no esbuild):
deno run -A https://deno.land/x/emit/cli.ts \
  --output dist/job.bundle.js job.ts
```

**Verify the bundle:**

```bash
# Should be a single file, ~150-300 KB (linkedom is the bulk).
ls -lh dist/job.bundle.js

# Sanity-run locally (you'll need SUPABASE_* env vars set).
SUPABASE_URL="..." SUPABASE_SERVICE_KEY="..." \
  deno run --allow-net --allow-env dist/job.bundle.js
```

If the local sanity run pulls a queue row, posts a report, and exits
clean, the bundle is correct. Move on to deploy.

---

## 4 // SET SECRETS

The service-role key must NEVER be committed to git or stored in plain
config. Push it as an Acurast secret — the TEE decrypts it only inside
the enclave; processor operators cannot read it.

```bash
acurast secrets set SUPABASE_SERVICE_KEY "eyJ...your-service-role-jwt..."

# Confirm it's stored (the value should be redacted in output)
acurast secrets list
```

If your CLI version uses a different command (`acurast env`,
`acurast set-secret`, etc.), substitute. The destination is the same.

---

## 5 // DEPLOY

```bash
cd "G:\Projects\AlgoParallax\Algorithm Parallax\acurast"

# Validates manifest against schema, uploads bundle, registers job.
acurast deploy --manifest acurast.json
```

Watch the output for:

```
✓ manifest valid
✓ bundle uploaded (job.bundle.js, NNN KB)
✓ job registered (id: <job-id>)
✓ assigned to N processors
```

The job is now scheduled. Each of your processors will invoke it on the
30-second cadence configured in `acurast.json`.

---

## 6 // VERIFY THE FLEET IS WORKING

### 6.1 Tail processor logs

```bash
# Per-job log stream from the Acurast network.
acurast logs --job <job-id> --tail
```

You should see lines like:

```
[2026-05-06T13:42:11Z] acurast-7a3f9b online; siphon timeout 180000ms
[2026-05-06T13:42:11Z] acurast-7a3f9b no work
[2026-05-06T13:42:41Z] acurast-c8e21d online; siphon timeout 180000ms
[2026-05-06T13:42:41Z] acurast-c8e21d claimed 9301-7f4a keyword="ai coding assistants"
[2026-05-06T13:43:02Z] acurast-c8e21d done 9301-7f4a drift=0.794 conf=0.91 t=21.3s
```

If you see only `no work` lines, the fleet is healthy and just waiting
for queue input. Submit a query from the frontend to verify the loop.

If you see `siphon FAIL` lines: most likely cause is a host not in the
egress allowlist. Check the manifest, redeploy.

If you see `claim error: HTTP 401`: SUPABASE_SERVICE_KEY isn't set in
secrets, or it's wrong. Re-set it.

If processors connect but never invoke: `processors.selection` is wrong
in the manifest. Verify your owner address.

### 6.2 SQL-side verification

In the Supabase SQL editor:

```sql
-- Reports flowing in?
select count(*), max(created_at)
  from reports
 where created_at > now() - interval '15 minutes';

-- Queue draining?
select status, count(*) from query_queue group by status;

-- Stale 'processing' rows? (sweeper handles them, but spike means
-- workers are dying mid-job.)
select id, claimed_by, claimed_at, now() - claimed_at as age
  from query_queue
 where status = 'processing'
   and claimed_at < now() - interval '2 minutes';
```

### 6.3 End-to-end smoke test

1. Open the frontend `index.html`.
2. Submit a fresh keyword (one not in the last hour's reports).
3. Watch `acurast logs --tail` — should see a `claimed` line within 30s.
4. Watch the frontend — should render the displacement report before the
   45s polling timeout.

If steps 3 happens but step 4 doesn't: the report POST is failing inside
the TEE. Check logs for `post_report failed` and verify the Supabase
egress allowlist entry matches your project URL exactly.

---

## 7 // OPERATIONS

### Updating the job

After any change to `siphon.ts`, `job.ts`, or `acurast.json`:

```bash
# Re-bundle
deno run -A npm:esbuild job.ts --bundle --format=esm --target=es2022 \
  --outfile=dist/job.bundle.js

# Re-deploy. Most CLIs treat this as an update, not a duplicate.
acurast deploy --manifest acurast.json
```

Old job invocations finish cleanly (run-once pattern); new invocations
pick up the new bundle on the next 30-second tick.

### Pausing the fleet

```bash
acurast job pause <job-id>
# or
acurast job stop <job-id>
```

Stops further scheduled invocations. In-flight jobs finish.

### Scaling

For more throughput, **don't** lower the 30-second interval (you'll
hammer the Supabase free tier's connection pool). Instead, add more
processors to your fleet. Each processor handles ~1 job every 30 seconds
or so; with 30 processors you have ~60 jobs/minute capacity.

If you hit Supabase free-tier limits, the bottleneck is egress, not the
fleet. See `STEP3_SECURITY_NOTES.md` §4 for the math.

### Tightening security further

Two upgrades worth doing once basics work:

1. **Drop service-role key, use a scoped Postgres role.** Create a
   `dm_worker` role with EXECUTE on `claim_next_job`, INSERT on
   `reports`, DELETE-by-id on `query_queue`, and nothing else. Issue a
   long-lived JWT for that role. Replace `SUPABASE_SERVICE_KEY` in the
   secret with `SUPABASE_DM_WORKER_KEY`. Result: a compromised TEE
   bundle can't dump all reports or escalate.

2. **Verify processor attestation server-side.** Add a Supabase Edge
   Function `fleet-ingest` that wraps the report POST. The function
   verifies the request's Acurast attestation token before forwarding
   to the database. Result: even a leaked dm_worker JWT can't be used
   from outside the TEE network.

Both are nice-to-haves; defer until the basic loop is in production.

---

## 8 // WHAT TO DO IF DEPLOYMENT FAILS

| Symptom | Likely cause | Fix |
|---|---|---|
| `acurast deploy` errors on schema validation | Manifest field names drifted from current schema | Diff `acurast.json` against docs.acurast.com, rename fields |
| Bundle is >5 MB | linkedom + tree-shake didn't happen | Use esbuild path with `--minify`, or swap linkedom for `deno_dom` |
| TEE invocation crashes immediately | npm import (`linkedom`) not resolving inside TEE | Bundle to a pure JS file with no remote imports; check that `--bundle` actually inlined linkedom |
| No processors pick up the job | `processors.owner_address` doesn't match wallet | Re-run `acurast whoami`, copy address verbatim |
| `claim_next_job` returns 404 | The RPC function isn't installed in your Supabase project | Re-run `schema.sql` and `codes.sql` from the SQL editor |
| Reports POST returns 403 | RLS is blocking — service-role key wrong, or the JWT isn't service-role | Confirm key is from Settings → API → `service_role` (NOT `anon`) |
| Reports POST hangs / times out | Supabase host not in egress allowlist | Add it to `acurast.json`, redeploy |

---

## 9 // CHECKLIST

```
[ ] Diffed acurast.json against current docs.acurast.com schema
[ ] Replaced REPLACE_WITH_YOUR_ACURAST_WALLET_ADDRESS in 2 places
[ ] Stripped _NOTE_TO_OPERATOR and _comment keys from acurast.json
[ ] Confirmed CLI binary name (acurast / acurast-cli / @acurast/cli)
[ ] Confirmed CLI commands (deploy / secrets set) match current docs
[ ] schema.sql and codes.sql executed in Supabase SQL editor
[ ] Bundle produced: dist/job.bundle.js exists and is <5 MB
[ ] Local sanity run: bundle ran end-to-end against staging keyword
[ ] SUPABASE_SERVICE_KEY set as Acurast secret
[ ] Deploy succeeded: job ID returned
[ ] acurast logs --tail shows processors checking in
[ ] Frontend submit → log shows 'claimed' within 30s → report renders
```

When every box ticks, you're in production on the Acurast fleet.
