# Asleepius Standardized Codes (ASC)

**Spec version 0.1 — DriftMetrics phase 4**
**Authority document: this file. Implementations must conform.**

ASC is a code grammar shared across Asleepius products. A code is a small,
sharable, deterministic string that may grant access, modify behavior, or
unlock content depending on which product reads it.

This spec extends the pattern established in
`G:\Projects\theVibez\underground\crawler\codes.js`. Underground was the
first implementation; everything below is upward-compatible with it.

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

## 2 // The two layers

ASC has two layers. Every code participates in Layer 1. Codes that meter
real-world resources (compute, fleet time, paid features) also have
Layer 2 state.

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
they grant the same effect every run forever) or in both layers
(DriftMetrics access codes have a balance that decrements on use).

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
4. **Layer 2 is local to the issuing product.** A code with balance in
   DriftMetrics has no balance in Underground; Underground reads it via
   Layer 1 only.
5. **Codes are sharable by design.** Implementations MUST NOT bind a
   code to an account, IP, or device unless the code's metadata
   explicitly says otherwise (e.g., a `bound_to` field). Anyone holding
   a code is entitled to use it.

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

A coded fresh scrape produces a report whose `payload._coded = true`.
If the code's hash hidden_flag is true (Bonus), the resulting report's
cache TTL is extended from 1 hour to 24 hours — the user's compute
becomes a community gift for the day. This is the Layer 1 hidden
mechanic in DriftMetrics.

---

## 7 // Reference implementations

- **Layer 1 (canonical):** `G:\Projects\theVibez\underground\crawler\codes.js`
  — FNV-1a, deterministic parse, slot validation.
- **Layer 2 (this product):** `codes.sql` in this repo. Table schema,
  redemption RPC, trigger bypass flag.
- **Frontend hook:** `bridge.js` (next phase). Accepts a code in the
  search rig, sends it to the Edge Function, displays remaining balance.

Future tools that need Layer 2 should copy `codes.sql` verbatim and
register their product-specific prefix in §3 of this document.

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
