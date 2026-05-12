# asc/ — Asleepius Standardized Code portable artifacts

This folder is the **portable kit** for ASC v0.2. Anything in here is
designed to be copied into another Asleepius product's repo without
forking the spec.

The authoritative spec is one directory up:
[`../ASC_SPEC.md`](../ASC_SPEC.md). Everything here implements it.

## Inventory

| File                    | What it is                                             | Drop into                                 |
|-------------------------|--------------------------------------------------------|-------------------------------------------|
| `codes.sql`             | Layer 2 codes table + `mint_code` / `peek_code` / `redeem_code` RPCs. Spec-conformant. | Any Supabase project that wants Layer 2 codes. |
| `raids.sql`             | Layer 3 raid coordination tables + RPCs. Math from ASC §3 plan-doc + spec §2 Layer 3. | scaffold-ledger Supabase, when ready. Depends on `codes.sql` being installed first. |
| `acurast/resolver.ts`   | Acurast TEE worker that resolves a raid (dice roll + payout). | Any Acurast deployment for a Layer 3 product. Mirrors the bundle pattern at `../acurast/job.ts`. |
| `code-surface/`         | Example `.txt` artifacts in the §9 standard format.    | Drop into your domain's `/c/` path as static files. |

## Why "portable"

Each Asleepius product owns its own backend. There is no central code
registry. To make `ASL-FOUNDERS-001` work in Drift, scaffold-ledger,
and any future product, the operator runs a copy of `codes.sql` in
each product's database and mints the same canonical string in each
(see ASC_SPEC §4 Cross-product mint pattern).

The files here are the master copy. They are NOT live-deployed against
anything from this folder. The deployment lives in each product's repo.

## Drop-in procedure (for a new product)

1. Copy `codes.sql` into your product's repo (or your product's SQL
   migration folder).
2. If you want Layer 3 (multi-player coordination, raids, lobbies):
   copy `raids.sql` too. It depends on `codes.sql`.
3. Register your product-specific prefix in ASC_SPEC §3.
4. Set product-specific defaults at the top of your copy of `codes.sql`
   (the `mint_code` defaults block is parameterized — see comment).
5. If you want TEE resolution: copy `acurast/resolver.ts`, set up the
   bundle pipeline like `../acurast/build.ts`, deploy.

## What this folder is NOT

- It is not a SaaS. There is no service. There is no API.
- It is not a sync layer. Per ASC §4, codes do not sync between products.
- It is not a dependency. Products that adopt these files own them
  forever from that point. Update by re-copying when ASC bumps version.
