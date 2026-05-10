# DriftMetrics — Operations Runbook

Daily-ops reference for the live deployment. Pairs with `HANDOFF.md` (project
context) and `acurast/DEPLOY.md` (Acurast specifics). When in doubt, this file
is the source of truth for "what command do I run."

---

## 1. Stack at a glance

| Layer       | Where                                                            | Owner     |
|-------------|------------------------------------------------------------------|-----------|
| Frontend    | Static HTML/JS in this repo → GitHub Pages → Cloudflare DNS      | GitHub+CF |
| Domain      | `drift-metrics.com` (Cloudflare DNS, HTTPS via Cloudflare)       | Cloudflare|
| CAPTCHA     | Cloudflare Turnstile (configured for this domain)                | Cloudflare|
| Backend     | Supabase Postgres (`schema.sql`, `codes.sql`, `sad.sql`)         | Supabase  |
| Edge fns    | `supabase/functions/{submit,sad_advance}/index.ts`               | Supabase  |
| Workers     | Acurast TEE jobs (`acurast/job.ts` + `acurast/siphon.ts`)        | Acurast   |
| Identity    | URL `?code=` + Ctrl+K panel + localStorage (no accounts)         | Client    |
| Bureau game | `bureau.html` + `sad.sql` + `sad_advance` Edge Function          | Client+DB |

**Deploy flow for frontend:** push to the GitHub repo → GitHub Pages rebuilds
→ Cloudflare serves the new content. No build step. No staging environment.
Hard-refresh the browser if you see stale assets.

---

## 2. First-time deploy / fresh-database bootstrap

Run these in order in the Supabase SQL Editor:

```
1. schema.sql        -- core tables, queue, RLS, shadowban trigger
2. codes.sql         -- codes table, mint_code RPC, peek_code RPC
3. sad.sql           -- SAD ledger stub, sad_advance/sad_force_advance/credit_code
```

Then deploy the Edge Functions (Docker not required; falls back to remote
bundling automatically):

```bash
npx supabase functions deploy submit       --no-verify-jwt
npx supabase functions deploy sad_advance  --no-verify-jwt
```

Acurast deployment is documented separately in `acurast/DEPLOY.md`. The TL;DR:

```bash
cd acurast
deno run -A build.ts                          # bundle job.ts -> job.bundle.js
npx acurast deploy                            # accept the proposed price
npx acurast devtools "Acurast:<addr>:<id>"    # tail logs
```

---

## 3. Re-deploy after code changes

### 3.1 Frontend-only changes (HTML/JS)

Just re-publish the static files. Hard-refresh (Ctrl+Shift+R) to defeat the
service worker / browser cache. No DB or function changes needed.

### 3.2 SQL changes (`schema.sql`, `codes.sql`, `sad.sql`)

Re-run the affected file in the Supabase SQL Editor. All three files are
idempotent — they use `create table if not exists`, `create or replace
function`, and guarded `do $$ ... $$` blocks for migrations. Re-running is
safe.

### 3.3 Edge Function changes

```bash
npx supabase functions deploy submit       --no-verify-jwt
npx supabase functions deploy sad_advance  --no-verify-jwt
```

If you see `unexpected deploy status 400: ... requires parens when mixing
with logical operators` or similar parser errors, that's Deno's strict TS
parser running in the remote bundler — fix the source and redeploy. No need
to install Docker just for that.

### 3.4 Acurast worker changes

Rebuild the bundle, optionally clean up the prior deployment, redeploy:

```bash
cd acurast
deno run -A build.ts
npx acurast deployments <prev_id> --cleanup    # optional: free escrow
npx acurast deploy                              # accept proposed price (don't lower)
```

After deploy, verify in DevTools:

```bash
npx acurast devtools "Acurast:<your_addr>:<deployment_id>"
```

You're looking for `JobStarted` followed by `Heartbeat` events. If you see
`ExecutionFailure: require() cannot be used on an ESM graph with top-level
await`, regenerate the bundle — the build step refactored that out, but a
stale `job.bundle.js` will still ship the old code.

---

## 4. Minting access codes

Codes are universal across the Asleepius ecosystem. Possession-based, no
accounts. The `mint_code()` RPC is the single source of truth.

**Format:** `XXX-YYYY-ZZZZ` where `XXX` is a 3-letter prefix that determines
the default category and balance.

| Prefix | Default balance | Default expiry | Use                                      |
|--------|-----------------|----------------|------------------------------------------|
| `DRF`  | 10              | none           | DriftMetrics-specific drops              |
| `ASL`  | 10              | none           | Universal Asleepius codes                |
| `EVT`  | 5               | 30 days        | Event / conference / one-shot drops      |
| `PRO`  | 30              | none           | Pack codes (pre-paid bundles)            |
| `ESO`  | 0 (override)    | none           | Esoterica — narrative-only, no scrapes   |

You can override balance, expiry, and notes per code.

### 4.1 Demo codes for hand-out (try-it-and-see)

```sql
-- 5-scrape demo codes. Use for cold outreach, screenshots, social media.
select mint_code('DRF-DEMO-001', 5, null, 'demo drop — public hand-out');
select mint_code('DRF-DEMO-002', 5, null, 'demo drop — public hand-out');
select mint_code('DRF-DEMO-003', 5, null, 'demo drop — public hand-out');
select mint_code('DRF-DEMO-004', 5, null, 'demo drop — public hand-out');
select mint_code('DRF-DEMO-005', 5, null, 'demo drop — public hand-out');
```

### 4.2 Trusted-friend codes (long-running)

```sql
-- 50-scrape codes for friends, beta testers, collaborators.
select mint_code('ASL-FRIEND-ALEX',   50, null, 'beta — Alex');
select mint_code('ASL-FRIEND-DANA',   50, null, 'beta — Dana');
select mint_code('ASL-FRIEND-MORGAN', 50, null, 'beta — Morgan');
```

### 4.3 Event codes (auto-expiring)

```sql
-- 5 scrapes, expires in 30 days. Useful for short campaigns.
select mint_code('EVT-LAUNCH-A', 5, '30 days', 'launch week — twitter handout');
select mint_code('EVT-LAUNCH-B', 5, '30 days', 'launch week — discord handout');
```

### 4.4 Bulk-generation pattern

```sql
-- 20 demo codes named DRF-LAUNCH-A001 .. DRF-LAUNCH-A020, each with 5 scrapes.
do $$
declare i int;
begin
  for i in 1..20 loop
    perform mint_code(
      'DRF-LAUNCH-A' || lpad(i::text, 3, '0'),
      5, null, 'launch week bulk drop'
    );
  end loop;
end $$;
```

### 4.5 Auditing what's out there

```sql
-- Active codes by category, with usage stats.
select
  category,
  count(*)                     as total,
  sum(use_count)               as total_burned,
  sum(balance)                 as remaining_total,
  count(*) filter (where balance = 0) as depleted,
  count(*) filter (where expires_at is not null and expires_at < now()) as expired
from codes
group by category
order by total desc;

-- Top 20 most-used codes (find power users / abuse).
select code, balance, use_count, last_used_at, notes
from codes
order by use_count desc
limit 20;

-- Codes that have never been used.
select code, balance, created_at, notes
from codes
where use_count = 0
order by created_at desc;
```

### 4.6 Adjusting an existing code

`mint_code()` upserts on conflict — if you call it again with the same code,
it updates balance / expiry / notes. To topup a code, just re-mint it:

```sql
-- Reset DRF-DEMO-001 to 10 balance.
select mint_code('DRF-DEMO-001', 10, null, 'topped up after launch event');
```

To **revoke** a code (soft-kill — use very sparingly, breaks the
"possession is identity" contract; only do this for confirmed abuse):

```sql
update codes set balance = 0, expires_at = now() where code = 'DRF-XYZ-...';
```

---

## 5. Sharing codes with users

Two paths:

1. **Direct copy/paste:** Just hand them the code string. They press Ctrl+K
   on `index.html` (or click `04 // SCAN` from the onboarding strip), paste,
   and apply.

2. **URL link:** Append `?code=DRF-WHATEVER-1234` to any frontend URL. The
   bridge reads the query string on load, applies the code, and shows a
   one-time toast confirming it stuck. Works on `index.html`, `asc.html`,
   `bureau.html`, etc.

   ```
   https://your-host/index.html?code=DRF-DEMO-001
   https://your-host/bureau.html?code=ASL-FRIEND-ALEX
   ```

   Best for: tweets, DMs, QR codes on physical media, deep-linked launch
   posts. The `asc.html` page has a `[SHARE]` button that builds the URL
   for the currently-stored code.

---

## 6. Common diagnostic queries

### 6.1 Recent queries that haven't completed

```sql
select id, keyword, status, created_at, processor_address
from queries
where status in ('pending', 'processing')
  and created_at < now() - interval '15 minutes'
order by created_at;
```

If something's stuck > 15 min, the worker probably crashed. Check Acurast
DevTools for `ExecutionFailure`.

### 6.2 Per-day query volume

```sql
select date_trunc('day', created_at) as day,
       count(*)                       as queries,
       count(*) filter (where status = 'complete') as completed,
       count(*) filter (where code is not null)    as coded
from queries
where created_at > now() - interval '14 days'
group by 1
order by 1 desc;
```

### 6.3 Bureau ledger health

```sql
-- How many distinct chains are filing? (one row per active chain)
select count(distinct (code_hash, chain_nonce))         as distinct_chains,
       count(*)                                          as total_chain_rows,
       count(*) filter (where chain_nonce = repeat('0', 32)) as legacy_chains,
       count(*) filter (where cdx_hash is not null)      as v3_chains,
       sum(event_count)                                  as total_events_filed
from sad_ledger_stub;
```

---

## 7. Things that have bitten us (and how to fix them)

| Symptom                                                | Fix                                                      |
|--------------------------------------------------------|----------------------------------------------------------|
| Acurast `estimate-fee` ZodError on intervals           | `maxExecutionTimeInMs` must be `<` `intervalInMs`        |
| `npx acurast deploy` hangs after submit                | Whitelist contains offline phones; redo whitelist        |
| `ExecutionFailure: top-level await ... esm graph`      | Refactor TLA in `job.ts` to `.then()` chain, rebuild     |
| Frontend shows "scan timed out" but Acurast succeeded  | Frontend `POLL_TIMEOUT_MS` too short — currently 6 min   |
| Edge Function deploy 400: parens with `??`             | Deno strict parser. Add explicit parens: `(a ?? (b \|\| c))` |
| Codex desync after manual archive edit                 | By design — `ARCHIVE CORRUPTION DETECTED` rejects import |
| Stuck queue backpressure                               | `select count(*) from queries where status='pending'`; bump worker count if > 50 |

---

## 8. Pre-public-launch checklist (current status)

- [x] DriftMetrics core query loop end-to-end working
- [x] Code-gated scrapes with live balance display
- [x] Code sharing via `?code=` URL
- [x] Bureau game v0.3a (codex, parallel chains, weight, trust)
- [x] Public-friendly docs (no leaked implementation details)
- [x] Cross-page navigation
- [x] First-time onboarding strip on INDEX
- [x] Bureau premise card for first-time visitors
- [x] Hosting live (GitHub Pages → Cloudflare → `drift-metrics.com`)
- [x] HTTPS + custom domain
- [x] Cloudflare Turnstile configured
- [ ] **Mint hand-out codes** — see §4 above
- [ ] **First public post draft**
- [ ] CSP / SRI hardening pass — nice-to-have, not blocking
- [ ] Stress-test Turnstile rate limits under real load — discover at launch

---

## 9. Emergency contacts (for future-you)

- **Supabase project:** check `bridge.js` for `DM_SUPABASE_URL`
- **Acurast deployment:** `acurast/acurast.json` lists current whitelist + price
- **CLI funded address:** `npx acurast wallet` from `acurast/` dir
- **Project Discord / community channel:** _TODO add when launched_
