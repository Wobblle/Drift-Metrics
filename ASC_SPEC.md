# Asleepius Standardized Codes (ASC)

**Spec version 0.2 — ecosystem pass**
**Authority document: this file. Implementations must conform.**

ASC is a code grammar shared across Asleepius products. A code is a small,
sharable, deterministic string that may grant access, modify behavior, or
unlock content depending on which product reads it.

This spec extends the pattern established in
`G:\Projects\theVibez\underground\crawler\codes.js`. Underground was the
first implementation; everything below is upward-compatible with it.

### Spec history

- **v0.1** — initial spec. Two layers (deterministic + stateful balance).
  Underground + DriftMetrics prefix registry.
- **v0.2** — ecosystem pass. Adds Layer 3 (coordination), RAD prefix
  for raid pools, explicit cross-product mint pattern, the standard
  `?code=` URL grammar, the code-drop artifact convention, and the
  Phantom-discipline rule for raw emissions.
- **v0.2.1** — TRN prefix registered for Telemetry Trench Bureau-mode
  submissions. Layer 2 only (no new layer). Establishes the "client
  simulates, drift records, Acurast verifies" pattern for
  deterministic-engine games. See `trench.sql` + `TRENCH_DEPLOY.md`.

---

## 1 // Code grammar

```
CODE = PREFIX "-" BODY
PREFIX = three uppercase ASCII letters
BODY   = one or more characters from [A-Z0-9§\-]
```

Canonical form: uppercase, whitespace stripped. The canonical string is
what gets hashed and stored. Implementations MUST canonicalize before
parsing or comparing.

```
"sch-9301-prime"  →  "SCH-9301-PRIME"
"  ARC-§37-RUNOFF " → "ARC-§37-RUNOFF"
```

Examples (all valid):
```
SCH-9301-PRIME          ARC-§37-RUNOFF       ESO-NIGHTSHIFT-04
PCK-DRYDOCK-X9          DRF-7F4A-BLOOM       ASL-FOUNDERS-001
EVT-2026-MAYDROP-A      EVT-2026-MAYDROP-B
```

---

## 2 // The three layers

ASC has three layers. Every code participates in Layer 1. Codes that meter
real-world resources (compute, fleet time, paid features) also have
Layer 2 state. Codes that identify a shared coordination object (a raid
pool, a lobby, a faction-wide event) additionally have Layer 3 state.

A code may participate in any subset of layers depending on the issuing
product's needs. The same canonical string can be Layer 1 only in one
product, Layer 1+2 in another, and Layer 1+3 in a third — the layers do
not conflict because each product owns its own Layer 2 and Layer 3 state
(see §4 cross-product rules).

### Layer 1 — Deterministic

The canonical string, hashed via **FNV-1a 32-bit**, deterministically
yields a set of properties:

| Property | Bits | Meaning |
|---|---|---|
| `tier` | low byte (0–255) | rarity (1–4, distribution skewed low) |
| `hidden_flag` | second byte | one boolean; product-specific meaning |
| `flavor_seed` | top 16 bits | reserved for product-specific use |

Tier distribution (matches Underground):
```
tier 1: rolls   0–139  (~55%)
tier 2: rolls 140–209  (~27%)
tier 3: rolls 210–244  (~14%)
tier 4: rolls 245–255  (~ 4%)
```

The hidden flag is true when `(hash >> 8) & 0xff < 102` (~40% rate).
What it *means* is per-product. In Underground it's "Currept." In
DriftMetrics it's "Bonus" (a coded request whose result is permanently
cached for everyone, on the house — surfacing community value from
private compute).

Layer 1 has **no server, no database, no network**. Any product can
parse a code completely offline. Same string always parses identically.
Players who share codes share the exact effect.

### Layer 2 — Stateful

Codes that gate metered resources additionally have a row in a `codes`
table on the issuing product's database:

```
code             text primary key
category         text
balance          int
generation       int
expires_at       timestamptz nullable
created_at       timestamptz
last_used_at     timestamptz
use_count        int
notes            text  (internal only)
```

Layer 2 is what enables "burn one unit per fresh scrape." The hash
gives the code its *flavor*; the row gives it its *availability*.

A code may exist in Layer 1 only (Underground codes have no balance —
they grant the same effect every run forever) or in both Layer 1 and
Layer 2 (DriftMetrics access codes have a balance that decrements on
use).

### Layer 3 — Coordination

Codes that identify a shared multi-player pool, lobby, or event have a
row in a coordination table on the issuing product's database. The
canonical example is a raid: many holders of the same code converge on
the same pool, contribute resources, and share the outcome.

Layer 3 state is **not consumed on join**. Anyone holding the code can
join the same coordination object, repeatedly, until the object reaches
a terminal state (filled, resolved, expired, burnt). The code is a
shared address, not a ticket.

Reference shape (Sky Scaffold raids; full schema in `asc/raids.sql`):

```
raid_id           uuid primary key
code              text references codes(code)
target_resources  bigint        -- pool fill goal (T)
min_contribution  bigint        -- floor to join the share list (m)
fail_chance_base  numeric(3,2)  -- 0.05–0.30
deadline_at       timestamptz
status            text          -- 'open' | 'ready_to_resolve'
                                -- | 'resolved_success' | 'resolved_fail'
                                -- | 'burnt_deadline'
created_at        timestamptz

raid_contributions
  raid_id   uuid
  code_hash bigint   -- the contributor's identity code (hash, not raw)
  amount    bigint
  ts        timestamptz
  primary key (raid_id, code_hash, ts)
```

Layer 3 emits **raw rows only** (see §10 Phantom-discipline rule). No
derived "intent" or "faction pressure" fields. Downstream engines
(Phantom) infer; the platform records.

A Layer 3 code MAY also have Layer 2 balance (e.g., a raid code that
costs N scrapes to create, separate from the resources spent inside
the raid). The two states do not interact — Layer 2 is the cost to
USE the code; Layer 3 is the coordination object the code POINTS TO.

---

## 3 // Prefix registry

Prefixes are three-letter category tags. The registry below is
authoritative. New prefixes require updating this document.

### Universal prefixes (every product MUST recognize)

| Prefix | Category | Notes |
|---|---|---|
| `ASL` | asleepius universal | Works in all products. Highest trust level for cross-product Easter eggs. |
| `EVT` | event / drop | Limited-time. Body should encode drop date, e.g. `EVT-2026-05-MAYDROP-A`. |
| `PRO` | promo / pack | Bundles. May grant multiple slot effects in product-specific ways. |

### Underground-specific (legacy, do not reuse)

| Prefix | Category | Owner |
|---|---|---|
| `SCH` | schema | Underground |
| `ARC` | archive | Underground |
| `ESO` | esoterica | Underground |
| `PCK` | pack | Underground |

### DriftMetrics-specific

| Prefix | Category | Notes |
|---|---|---|
| `DRF` | driftmetrics access | Default access codes for DriftMetrics. Layer 2 balance defaults: 10 fresh scrapes. |
| `TRN` | trench submission | Telemetry Trench Bureau-mode submission code. Layer 2 balance defaults: 1 run, 30-day expiry. Burned on completion only — abandoning mid-run does not consume. Hash `tier` is honoured cosmetically (T4 = "high-classification dossier"); hash `hidden_flag` is honoured as an in-game flavour marker. Drift hosts the `trench_runs` and `trench_terminated_pool` tables; see `trench.sql`. |

### Sky Scaffold-specific

| Prefix | Category | Notes |
|---|---|---|
| `RAD` | raid pool | Layer 3 coordination code. Identifies one raid pool. Anyone with the code can join; the code is not consumed on join. Hash tier sets pool target multiplier (T1=baseline, T4=10x). Hash hidden_flag sets "lucky raid" — `fail_chance_base` halved, hidden from UI. Layer 2 balance defaults to 0 (joining a raid does not burn the code). |

### Reserved for future

`MED`, `TXT`, `IMG`, `MAP` — reserved for future Asleepius tools.
Do not mint codes with these prefixes yet.

---

## 4 // Cross-product compatibility rules

1. **Every product MUST accept `ASL`-prefixed codes** as valid input,
   even if the product chooses to do nothing with them.
2. **A product SHOULD parse but ignore** prefixes it doesn't recognize,
   not error. Forward compatibility.
3. **Hash properties (tier, hidden flag) are universal.** A product that
   surfaces tier visually MUST use the distribution in §2.
4. **Layer 2 and Layer 3 are local to the issuing product.** A code with
   balance in DriftMetrics has no balance in Underground; Underground
   reads it via Layer 1 only. A `RAD` code with a raid pool in Sky
   Scaffold has no raid pool in Drift; Drift can recognize the prefix
   for lore consistency but the coordination object lives where it was
   minted.
5. **Codes are sharable by design.** Implementations MUST NOT bind a
   code to an account, IP, or device unless the code's metadata
   explicitly says otherwise (e.g., a `bound_to` field). Anyone holding
   a code is entitled to use it.

### Cross-product mint pattern (the "ecosystem code")

To make a code work in multiple products simultaneously (e.g., an
`ASL-FOUNDERS-001` that grants Drift scrapes AND Sky Scaffold raid
faction-standing AND an Underground Easter egg), the operator mints
the same canonical string in EACH product's database independently:

```sql
-- In Drift's psql (already documented in RUNBOOK §4):
select mint_code('ASL-FOUNDERS-001', 100, null, 'phase 4 launch');

-- In scaffold-ledger psql (when it absorbs asc/codes.sql):
select mint_code('ASL-FOUNDERS-001', 0, null, 'phase 4 launch');
```

Same string. Same FNV-1a hash. Same tier, same hidden_flag. **Separate
balances and separate Layer 3 state per product.** This is intentional,
not a sync gap. It means:

- Burning one product's balance does not affect any other product.
- Recovering / topping up in one product does not require touching
  others.
- A product CAN recognize a prefix without minting at all — Underground
  recognizes `ASL` codes for Layer 1 effects without ever creating a
  Layer 2 row.

There is no central code registry. There is no sync RPC. There is no
"master" product. The canonical string is the only shared state.

### Universal prefix recognition (minimum viable cross-product behavior)

A product that wants to be ecosystem-conformant (not just spec-aware)
SHOULD do at least one of the following when it sees a universal-prefix
code (`ASL`, `EVT`, `PRO`):

- Resolve the Layer 1 effect deterministically from the hash (offline
  is fine — no DB lookup required).
- If the product runs a Layer 2 / Layer 3 backend, attempt to resolve
  the code there too, but fall back gracefully on miss (the code is
  valid even if this product hasn't minted it).
- Display tier visually if the product surfaces tier at all (so a
  player who sees tier in product A sees the same tier in product B).

A product MAY do none of these and still be spec-compliant — but it
forfeits the ecosystem network effect.

---

## 5 // Generation guidance (for minting)

Mint codes by hand from psql until you have reason to automate. Code
strings should:

- Be memorable enough to write on a card and hand to a person
- Avoid visually-confusable characters: `0/O`, `1/I/l`. Bias toward `2-9` and consonants.
- Body length 6–24 chars. Long enough to feel like a key, short enough to type once without error.
- Embed meaning where helpful: `EVT-2026-MAYDROP-A` is better than `EVT-X9F2-Q4`. Lore beats randomness.

A code IS the deliverable. Treat each one as an artifact.

---

## 6 // DriftMetrics defaults

| Layer 1 prefix | Default Layer 2 balance | Default expiry | Notes |
|---|---|---|---|
| `DRF` | 10 fresh scrapes | none | Standard issue. |
| `ASL` | 10 fresh scrapes | none | Universal. Same as DRF for now. |
| `EVT` | 5 fresh scrapes | 30 days from mint | Promotional. |
| `PRO` | 30 fresh scrapes | none | Bundle. Reserved for paid tier. |
| `SCH` `ARC` `ESO` `PCK` | 0 | n/a | Recognized but never burnt — Underground codes don't get DriftMetrics balance unless explicitly minted. |
| `RAD` | 0 | n/a | Recognized but never burnt in Drift — RAD codes are Sky Scaffold Layer 3 coordination codes, not Drift access codes. Drift may surface tier for lore consistency. |

A coded fresh scrape produces a report whose `payload._coded = true`.
If the code's hash hidden_flag is true (Bonus), the resulting report's
cache TTL is extended from 1 hour to 24 hours — the user's compute
becomes a community gift for the day. This is the Layer 1 hidden
mechanic in DriftMetrics.

---

## 7 // Reference implementations

- **Layer 1 (canonical):** `G:\Projects\theVibez\underground\crawler\codes.js`
  — FNV-1a, deterministic parse, slot validation. As of v0.2 this also
  recognizes `ASL`, `EVT`, `PRO`, and `RAD` universal prefixes for
  Layer 1 effects (no network).
- **Layer 2 (this product):** `codes.sql` in this repo. Table schema,
  redemption RPC, trigger bypass flag.
- **Layer 2 + 3 portable artifacts:** `asc/codes.sql` and `asc/raids.sql`
  in this repo. Drop-in spec-conformant SQL for any Asleepius product
  that wants its own backend (e.g., scaffold-ledger). Same canonicalization,
  same hash math, parameterized so the operator can swap project-specific
  defaults without forking the spec.
- **Frontend hook:** `bridge.js` in this repo. Accepts a code in the
  search rig, sends it to the Edge Function, displays remaining balance.
- **Cross-product uplink (offline-first):** the underground shell
  `uplink CODE` command in `G:\Projects\theVibez\underground.html`.
  Side channel from Underground to any Asleepius product's `peek_code`
  RPC. Layer 1 effects work without it; uplink adds Layer 2/3 visibility
  when network is available.

Future tools that need Layer 2 should copy `asc/codes.sql` and register
their product-specific prefix in §3 of this document.

---

## 8 // What this gets us

- **No accounts.** A code IS the account. No email, no password, no
  reset flow, no privacy policy theater.
- **Sharable by default.** A code passed between friends works. A code
  posted publicly burns through its balance and dies. Both behaviors
  are intended.
- **Cross-product ecosystem currency.** The same `ASL-FOUNDERS-001`
  card you handed someone at an indie meetup unlocks DriftMetrics
  scrapes today, hides an Easter egg in Underground when they boot it,
  and works in whatever you ship next year.
- **Manual today, paid later.** The mint path is `INSERT INTO codes`.
  Whether that insert is run by you in psql or by a Ko-fi webhook in
  six months, the product doesn't change.
- **Lore as access control.** A code with a name that means something
  is a piece of brand. A code that's pure entropy is a license key.
  The spec assumes you're minting the former.

---

## 9 // URL grammar (the sharable code surface)

The standard cross-product share format is a query-string parameter on
any product surface that knows how to consume codes:

```
https://drift-metrics.com/index.html?code=DRF-DEMO-001
https://drift-metrics.com/bureau.html?code=ASL-FRIEND-ALEX
https://thevibez.com/underground.html?code=ASL-FOUNDERS-001
https://skyscaffold.example/raid.html?code=RAD-NIGHTSHIFT-04
```

Rules:

1. The parameter name is `code`. Always lowercase. Always exactly that.
2. The value is the canonical code string (uppercase, no whitespace).
   Implementations MUST canonicalize on read regardless.
3. The page MUST apply the code to local storage / session state on
   load and show a one-time confirmation. The user should never have
   to type the code if they got it via URL.
4. If the page can resolve the code (Layer 1 hash, Layer 2 peek, etc.)
   it SHOULD show what the code grants before the user takes any
   action. This is the "what did this stranger just hand me" UX.
5. **No URL shortener.** A third-party shortener IS the friction point
   the Asleepius brand exists to refuse. Domain URLs are short enough.
   The lore drop carries the full URL on the artifact.

### Code drop artifact convention (`/c/<CODE>.txt`)

When a product produces a sharable code at runtime (a raid completion
reward, a Bureau ledger drop, a generated Underground archive code),
it SHOULD also write a static plain-text artifact at the path
`/c/<CODE>.txt` on the product's domain. The artifact format:

```
CODE: RAD-NIGHTSHIFT-04
URL:  https://skyscaffold.example/raid.html?code=RAD-NIGHTSHIFT-04
LORE: the dock's unlit. portsman won't be back till matins.
ASC:  v0.2 / RAD / coordination
```

Four lines. No more. Plain text. No service required to host it — it's
a static file. Anyone with the URL gets the code; anyone with the .txt
file can repost the URL anywhere bytes move (Discord, screenshot,
printed card, Twitter image-with-text, Fabric video description).

The lore line is the only piece of brand voice. Keep it one sentence.
Keep it tonally honest. No marketing.

The product MAY also emit the artifact's URL on its terminal output
when it generates the code, e.g.:

```
> drop  RAD-NIGHTSHIFT-04
  artifact: https://skyscaffold.example/c/RAD-NIGHTSHIFT-04.txt
  lore:     "the dock's unlit. portsman won't be back till matins."
```

This is the "human-compute-distributable surface" — the operator
(Jordan) or a player who earns a code can paste a 50-character URL
into any chat and that's the entire distribution channel.

---

## 10 // Phantom-discipline rule (no engine-shape coupling)

The Phantom Lore Engine is downstream of the platforms, not upstream.
Platforms emit RAW rows only. They do not pre-shape data for an engine
that does not yet exist.

**Forbidden in any platform table:**

- `intent_score`, `faction_pressure`, `lore_weight`, `narrative_arc`
- Any column whose meaning requires the Phantom engine to interpret
- Aggregations that bake in an inference rather than recording an event

**Required in any platform table that emits behavioral signal:**

- An immutable timestamp
- An identity field (code, code_hash, or null for anonymous pre-flight)
- The smallest possible action description (verb + amount, not
  semantic gloss)

Examples (good):

```
raid_contributions(raid_id, code_hash, amount, ts)
uplink_log(code_hash, action, ts)               -- 'peek' | 'join'
sad_ledger_stub(code_hash, chain_nonce, event_count, ts)
```

Examples (forbidden):

```
raid_contributions(raid_id, code_hash, amount, ts, faction_loyalty)
uplink_log(code_hash, intent_drift_delta, ts)
```

**Why:** Phantom does not exist yet. Its schema does not exist yet.
Platform tables that pre-shape for a guess will require migrations
when Phantom actually lands. Raw event rows can be queried by any
shape Phantom needs, indefinitely, with no migration burden.

This rule overrides any contributor's instinct to "make Phantom's
job easier" by enriching at the platform layer. Phantom enriches
itself. The platforms record.
