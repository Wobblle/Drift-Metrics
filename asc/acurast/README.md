# asc/acurast/ — portable Acurast TEE resolver bundle

Reference implementation of the ASC v0.2 Layer 3 raid resolver for Acurast
TEE deployment. Copy into any Asleepius product's `acurast/` folder when
you're ready to deploy raid resolution.

## What's here

- `resolver.ts` — the worker entry point. Per invocation:
  1. Sweeps `open` raids past their deadline → `burnt_deadline`
     (calls `scan_raids_for_deadlines()` SQL function).
  2. Finds raids with `status='ready_to_resolve'` (pool filled).
  3. For each, generates cryptographic randomness inside the TEE,
     calls `resolve_raid(raid_id, dice)` to atomically dice-roll and
     distribute loot.

## What's missing (deliberately)

- `build.ts` — bundle script. Copy `../../acurast/build.ts` and adjust
  the entry from `job.ts` to `resolver.ts`.
- `acurast.json` — deployment manifest. Copy `../../acurast/acurast.json`
  and adjust schedule (recommend 60–120s tick) + processor whitelist.
- `.env` — service key + Supabase URL for the target product.

These three are deployment-specific and cannot be portable. The reference
to copy from is Drift's working deployment in
`G:\Projects\AlgoParallax\Drift-Metrics\acurast\`.

## Why a separate bundle from Drift's job.ts?

- Drift's `job.ts` is a SCRAPER worker (claims a queue row, runs siphon,
  posts a report). Sky Scaffold raids do not scrape.
- Cleaner separation: the raid resolver only needs `raids.sql` RPCs,
  not Drift's `query_queue` schema.
- Different cadence: scrapers run every 30–60s under load; raid resolver
  only needs to wake when raids are filling, so a 60–120s tick is fine.
- Different attestation profile: raid resolution involves money/items;
  the audit chain matters more, so a small focused bundle is easier to
  review.

## Trust model

The TEE attestation is what makes the dice roll trustworthy. The
operator (you) cannot inject a chosen dice value because:

1. The bundle is built from this source code and bundled deterministically.
2. The Acurast image is attested — the TEE refuses to run a tampered
   binary.
3. `crypto.getRandomValues` runs inside the sealed enclave. The host OS
   cannot observe or replace the result.
4. The resolve_raid RPC is `security definer` and only callable with the
   service_role key, which lives in the TEE env. The key is never written
   to a process accessible from outside the enclave.

For higher-stakes raids, swap `randomUnitInterval()` for a commit-reveal
scheme or a verifiable random function (VRF). The signature stays the
same.

## NOT YET DEPLOYED

This bundle is a master copy. It is not running against scaffold-ledger
or any other Supabase project. To deploy:

1. Confirm scaffold-ledger has absorbed `../codes.sql` and `../raids.sql`.
2. Copy this folder into scaffold-ledger's repo (or a new repo for the
   resolver alone).
3. Follow `../../acurast/DEPLOY.md` for the bundle + deploy procedure.
