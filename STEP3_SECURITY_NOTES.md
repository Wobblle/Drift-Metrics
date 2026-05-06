# DriftMetrics // Step 3 — Security Notes & Hardening Roadmap

This is the doc that pairs with `schema.sql`, `worker.py`, and `bridge.js`.
It explains *why* certain choices were made, the limits of the silent
shadowban model, and a layered hardening roadmap you can roll out
incrementally as you start seeing real abuse.

---

## 0 // The threat model in one paragraph

Anyone can View Source on `index.html`, copy the `anon` key, and start
hitting `POST /rest/v1/query_queue` directly. The `anon` key is **not**
a secret — Supabase's security model assumes it will be exposed, and
relies on RLS + database constraints to enforce policy. Our entire
defense is therefore **server-side, in the database**, in two layers:

1. **RLS** prevents the anon role from doing anything except inserting
   into the queue and reading reports. No `UPDATE`, no `DELETE`, no
   `SELECT` on the queue.
2. **The shadowban trigger** mutates the inserted row's `status` to
   `shadowbanned` for abusive traffic. Workers filter on `status =
   'pending'`, so shadowbanned rows are just dead weight — they exist,
   they take a few hundred bytes, the cleanup function deletes them
   after an hour.

The attacker can **never tell** they've been banned, because:

- They get HTTP 201 every time.
- They can't `SELECT` from `query_queue` to see the status.
- They have no way to correlate "did my request actually run?" except
  by polling `reports`, which times out identically to a non-banned
  request that the fleet just hasn't gotten to.

This is the whole game. Every other suggestion below either tightens
those two layers or adds a third.

---

## 1 // What the shipped trigger does

| Gate | Trigger condition | Effect |
|---|---|---|
| Keyword shape | `len(kw) < 2 or len(kw) > 128` | Silent ban |
| Honeypot | `honeypot` field non-empty | Silent ban |
| Per-IP rolling | > 3 inserts / 10 min from same IP | Silent ban |
| Per-IP daily | > 50 inserts / 24 h from same IP | Silent ban |
| Global backpressure | > 200 rows in `pending` | Silent ban |
| `ip_address` column | Server-set via `dm_client_ip()` | Client cannot forge |

The two per-IP gates work in tandem: the 10-minute window catches a
flood, the 24-hour window catches a slow drip that would slip under
the rolling window (3 every 11 minutes = 392/day, but 50/day kills it).

---

## 2 // Known limitations of this design

These are real and you should know about them:

**1. CGNAT / shared IPs.** Cellular carriers and corporate networks
NAT thousands of users behind one IP. The 3/10min limit is shared
across all of them. A coffee shop with 12 users hitting the demo at
once will see 9 of them shadowbanned. Mitigations in §3.

**2. IP rotation costs the attacker $0–$2/mo.** Free residential
proxy lists are bad but exist; cheap rotating proxy services start
at $5/mo. Per-IP limits alone won't stop a determined attacker, only
the casual ones. Mitigations in §3 (proof-of-work, Turnstile).

**3. The `anon` key is in the page.** It always will be on a static
deployment. An attacker can spin up 1000 anon clients with the same
key from 1000 different IPs and saturate the queue. The 200-pending
global backpressure caps the damage but also DoSes legitimate users
during a flood. Mitigations in §4 (separate per-source caps, edge
rate limiting).

**4. The trigger reads `query_queue` on every insert.** Cost is a
single index seek per gate. Free tier handles this fine up to
~1k inserts/min. If you ever blow past that, move the rate-check
into a separate `request_log` table sized for the rolling window.

**5. Workers use `service_role` directly.** That key has full DB
access. If a worker phone is compromised, the attacker can read all
reports and delete data. Mitigations in §6 (scoped role + JWT).

---

## 3 // Hardening roadmap, ordered by ROI

**Tier 1 — already shipped in `schema.sql` + `bridge.js`:**
- Silent IP rate limit (rolling + daily)
- Global pending backpressure
- Honeypot field
- Keyword shape validation
- 1-hour client-side cache pre-flight

**Tier 2 — drop-in additions (low effort, high impact):**

- **Cloudflare Turnstile.** Free, invisible captcha, no end-user friction.
  Frontend obtains a token before submit; the queue gets a `turnstile_token`
  column; the trigger validates the token via `pg_net` HTTP call to
  Cloudflare's siteverify. ~30 lines of SQL, ~10 lines of JS. This
  single change defeats the API-direct attacker class because the token
  must be obtained via a browser-side challenge.

- **CORS lockdown.** Supabase Dashboard → Settings → API → "API URL"
  → restrict to your deployed origin only. Prevents trivial JS-based
  abuse from third-party sites. Browser-only enforcement; doesn't stop
  curl, but cleans up the noise floor.

- **Disable Realtime + Storage** if you're not using them. Reduces
  attack surface and free-tier consumption. Dashboard → Database →
  Replication → toggle off the schemas you don't need.

**Tier 3 — for when you start seeing motivated attackers:**

- **Proof-of-work submission token.** Frontend computes a SHA-256 nonce
  where the hash starts with N leading zero bits. Server-side trigger
  verifies. Difficulty 16 bits = ~50ms on a phone, ~5ms on a desktop,
  unsurvivable to a Python script flooding 100 req/s. Implementation:
  pure JS subtle.crypto on the client, pure SQL `digest()` on the server.
  No infra changes.

- **Per-keyword global cap.** Add a 4th trigger gate: if the same
  `keyword` has been submitted N times in the last hour (across all
  IPs), shadowban further inserts. Forces attackers to vary keyword
  text, which makes the abuse less useful to them.

- **Anon-key versioning.** Ship a build-time-injected nonce in the
  HTML page; trigger requires it match a current value stored in a
  `config` table you rotate weekly via cron. Stale clients (= scraped
  page content) silently fail. Doesn't stop a freshly-scraped client,
  but raises the cost of automation.

**Tier 4 — only if you go genuinely viral or get targeted:**

- **Edge rate limit (Cloudflare Worker in front of Supabase).** Lets
  you reject before traffic ever touches your DB connection pool.
  Requires moving the API endpoint behind a custom domain. ~$0/mo on
  Cloudflare's free tier.

- **Browser fingerprint as second rate axis.** Canvas hash + UA hash
  combined gives you a per-browser identity that survives IP rotation.
  Add as a column, count in trigger. Privacy implication: this is
  fingerprinting; document it in your privacy policy or skip it.

- **Decoupled worker DB role.** Create a `dm_worker` Postgres role
  with `EXECUTE` only on the three RPCs (claim, post, delete by id)
  and no other access. Issue per-worker JWTs that map to that role.
  Means a compromised phone can't dump all reports.

---

## 4 // Free-tier budget math

Supabase free tier in 2025:
- 500 MB database
- 2 GB egress / month
- 50K monthly active users (irrelevant; we use anon)
- 500K function invocations / month (not used here — pure REST)
- ~5 concurrent connections at the pgbouncer

What this means in practice:

| Metric | Per request | Daily ceiling |
|---|---|---|
| `query_queue` insert | ~400 B | ~1.25M before disk pressure |
| `reports` row | ~3 KB (typical payload) | ~165K before disk pressure |
| Egress per polled report | ~3 KB | ~700K reads/mo at 2GB cap |

The TTL cleanup keeps the queue at near zero and reports at <24h.
Realistic worst case: 10K reports stored at any moment = 30 MB. Safe.

The bottleneck on free tier is **egress**, not storage. A hostile
poller hitting `/rest/v1/reports?request_id=eq.<uuid>` every 100ms
for 10 hours costs you ~360K queries × ~200B response = 70 MB. One
attacker per day burns 3.5% of monthly egress. That's why the
client-side timeout caps polling at 45s — bound the cost per session.

---

## 5 // Operational checklist before going live

```
[ ] schema.sql executed in Supabase SQL editor
[ ] pg_cron extension enabled (Database → Extensions → pg_cron)
[ ] cron jobs scheduled (uncomment lines at bottom of schema.sql)
[ ] CORS restricted to your deployed origin (Dashboard → Settings → API)
[ ] anon key copied into bridge.js
[ ] DM_SUPABASE_URL set in bridge.js
[ ] Honeypot input added inside the search rig in index.html
[ ] runQuery() and renderReport() patched per bridge.js header comment
[ ] Service-role key NEVER committed to git or shipped in HTML
[ ] Service-role key set as env var on each Termux node
[ ] worker.py running under tmux/screen on at least one node
[ ] One end-to-end smoke test: submit "test query" → see report render
[ ] One shadowban smoke test: submit 5 rapid requests from same IP
    → 4th and 5th should silently time out
```

---

## 6 // Incident response: what to do if you're being attacked

Symptoms you'd see in the Supabase dashboard:
- `query_queue` row count climbing despite worker fleet healthy
- Same `ip_address` appearing repeatedly with `status = 'shadowbanned'`
- Disk usage climbing faster than expected (cleanup function running?)
- Egress spiking — usually polling abuse rather than insert abuse

Triage order:

1. **Verify cleanup is running.** `select count(*) from query_queue`
   should be near zero outside an active flood. If it's deep, check
   pg_cron via `select * from cron.job;` — the schedules may not be
   enabled.

2. **Inspect attacker IPs.** From SQL editor (you have direct access
   even when anon doesn't):
   ```sql
   select ip_address, count(*), max(created_at)
   from query_queue
   where created_at > now() - interval '1 hour'
   group by ip_address
   order by 2 desc
   limit 20;
   ```
   If one IP has hundreds of rows even though they're all shadowbanned,
   the silent shadowban is doing its job — the attacker is wasting
   bandwidth getting nothing back. Let it ride.

3. **If multiple IPs are coordinating** (botnet pattern), enable
   Cloudflare Turnstile (Tier 2 §3). 30 minutes of work, end of
   problem for that attacker class.

4. **If global pending stays >200 from legitimate traffic spikes**
   (e.g., HN frontpage), that's not abuse — that's success. Lift the
   global cap to 500, scale the fleet, and consider opening a paid
   tier or moving the queue to a dedicated DB role with higher
   connection caps.

5. **Nuclear option.** Rotate the anon key (Dashboard → Settings →
   API → Generate new anon key). Old key dies, all in-flight clients
   need to reload. Use only when something has gone very wrong.

---

## 7 // Why we chose this architecture over the alternatives

| Alternative | Why we didn't | What changes if you adopt it |
|---|---|---|
| Supabase Edge Functions in front of inserts | Costs the free 500K/mo invocation budget; adds latency | Cleaner abstraction, easier to add complex auth logic |
| Standalone Flask/FastAPI middleware | Requires a host (no longer "serverless"), and is the obvious target | More flexibility, real auth, real metrics |
| Supabase Realtime for results | More elegant than polling but doubles connection cost | Frontend doesn't need to poll; replace pollOnce with subscribe |
| Acurast TEE jobs as workers | Can't run `siphon.py` (Deno-only sandbox) | Would require porting the engine entirely |

The chosen architecture is "minimum infrastructure that satisfies the
requirement." It will scale to ~10K daily users on free tier with the
fleet sized to ~10 phones. Past that, you'd want to revisit Edge
Functions for the insert path and Realtime for the result path.
