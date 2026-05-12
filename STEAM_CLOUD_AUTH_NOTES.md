# Steam Cloud Auth — design notes for scaffold-ledger

**Status:** notes only. No SQL, no Edge Functions written yet.
Capture the pattern here so it doesn't get lost while we ship the
ASC tools and Sky Scaffold early access.

**Owner:** Sky Scaffold (consumer). scaffold-ledger is the backend.

---

## Why this exists

Sky Scaffold ships on Steam. Steam requires (or strongly expects)
that any "cloud-saved" data is bound to the player's Steam identity.
The Steam Cloud checkbox on the store page is the user-facing promise.

scaffold-ledger today has 5 tables that hold what would become cloud
state:

- `player_profiles`
- `space_hub_bank`
- `death_ledger`
- `active_strongholds`
- `ledger_receipts`

Supabase lints flag all 5 as **RLS Disabled in Public**. With the
anon key (which ships in any client), anyone can read or write any
row in any of them. That is a critical exposure for game state.

This document defines the path from "wide open" to "Steam-bound,
RLS-enforced" without breaking the existing game.

---

## Why standard Supabase auth doesn't fit

Supabase's built-in auth providers (email, OAuth) want users to
create accounts. The Asleepius/Sky Scaffold philosophy is the
opposite: codes are identity for the public-web side, and Steam is
identity for the game side. Adding email-based accounts on top
violates both.

We need to verify Steam tickets ourselves and mint our own JWTs,
then use those as Supabase's `auth.jwt()` for RLS.

---

## Pattern (the four-step flow)

```
[Sky Scaffold game]
        |
        | 1. Steam SDK: GetAuthSessionTicket(appId)
        v
[Steam Web API]  ← 2. Edge Function calls /ISteamUserAuth/AuthenticateUserTicket
        |
        | returns { steamid, vacbanned, ... }
        v
[Supabase Edge Function: scaffold-issue-jwt]
        |
        | 3. mints PostgREST-compatible JWT with sub = steamid
        |    signs with project's JWT secret
        v
[Sky Scaffold game]
        |
        | 4. uses that JWT as Authorization: Bearer <jwt> on every
        |    REST call to scaffold-ledger
        v
[Supabase / PostgREST + RLS]
        |
        | RLS policies: USING (steam_id = auth.jwt() ->> 'sub')
        v
[only that player's rows are readable/writable]
```

### Step 1 — Get a Steam session ticket

Inside Sky Scaffold's `BackendSyncManager`. Steam SDK call:

```csharp
HAuthTicket h = SteamUser.GetAuthSessionTicket(out byte[] ticket, out uint len);
// ticket buffer → hex string → POST to Edge Function
```

This is the same primitive Steamworks uses for "AuthenticateUserTicket"
verification. Tickets are short-lived (~10 minutes) and bound to an
app id.

### Step 2 — Verify with Steam Web API

In a Supabase Edge Function (`scaffold-issue-jwt`). Hit:

```
GET https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/
  ?key=<STEAM_WEB_API_KEY>
  &appid=<SKY_SCAFFOLD_APPID>
  &ticket=<ticket-hex>
```

Returns either:

```json
{ "response": { "params": {
    "result":  "OK",
    "steamid": "76561198..............",
    "ownersteamid": "...",
    "vacbanned": false,
    "publisherbanned": false
}}}
```

…or an error. If `result != "OK"`, refuse to mint a JWT.

### Step 3 — Mint a Supabase-compatible JWT

The Edge Function signs a JWT with the project's `JWT_SECRET`
(available as `Deno.env.get('SUPABASE_JWT_SECRET')` in Edge Functions).
Payload shape:

```json
{
  "aud":      "authenticated",
  "role":     "authenticated",
  "iss":      "scaffold-issue-jwt",
  "sub":      "76561198..............",
  "steam_id": "76561198..............",
  "iat":      1735689600,
  "exp":      1735693200
}
```

`sub` is the Steam ID. PostgREST's `auth.jwt()` reads from this.
Short expiry (1 hour); the game refreshes by getting a new ticket.

### Step 4 — Use the JWT for all client calls

Sky Scaffold's `BackendSyncManager` puts the JWT in
`Authorization: Bearer <jwt>` and sets `apikey: <project-anon>` for
every REST call to scaffold-ledger.

PostgREST sees the JWT, runs RLS, returns only that player's rows.

---

## RLS policy template (per-player tables)

For every per-player table, the same shape:

```sql
alter table player_profiles enable row level security;

create policy "owner_read_own"
  on player_profiles for select
  using (steam_id = auth.jwt() ->> 'sub');

create policy "owner_write_own"
  on player_profiles for insert
  with check (steam_id = auth.jwt() ->> 'sub');

create policy "owner_update_own"
  on player_profiles for update
  using      (steam_id = auth.jwt() ->> 'sub')
  with check (steam_id = auth.jwt() ->> 'sub');

-- delete left out unless the game actually deletes profiles.
```

Repeat for `space_hub_bank`, `death_ledger`, `active_strongholds`.

`ledger_receipts` is special — it's an Acurast result queue. Two
options:

1. **Service-role only.** RLS on, no policies for `authenticated`.
   Acurast workers (with service-role key in TEE env) write; the
   game reads its own via a SECURITY DEFINER function that filters
   by `steam_id`.
2. **Per-player read.** Same `using (steam_id = auth.jwt()->>'sub')`
   for select; service-role only for insert.

Pick #1 unless the game needs raw receipt access.

---

## Pre-requisites before any of this is safe

Every per-player table needs a `steam_id text not null` column. If
existing rows lack `steam_id`, we either:

- Backfill from whatever player identifier the game already uses
  (Sky Scaffold may already have a `player_id` we can map), or
- Wipe the table (dev data only) and let it re-populate from the
  game post-RLS rollout.

Check `BackendSyncManager.cs` for the current write shape before
writing the migration.

---

## What the ops console shows today

The Bridge tab on the ops console pings scaffold-ledger as a
`gamestate` profile. It enumerates row counts on the 5 known tables
and renders a permanent yellow reminder pointing to this document.
Once RLS is live and the Edge Function is deployed, this reminder
will be retired (the console will probe a known-bad steam-id JWT
and confirm policies enforce).

---

## Order of operations (when we tackle this)

1. Inventory `BackendSyncManager.cs` — what's it actually writing?
   What identifier does it use?
2. Add `steam_id text` to every per-player table; backfill or wipe.
3. Write Steam Web API key into Supabase Edge Function env.
4. Deploy `scaffold-issue-jwt` Edge Function.
5. Apply RLS migrations to all 5 tables.
6. Update `BackendSyncManager.cs` to:
   - Get session ticket on game start
   - Exchange for JWT
   - Use JWT on every call
7. Verify Sky Scaffold smoke test passes end-to-end.
8. Re-test ops console Bridge: lint warnings should clear.

---

*Notes drafted alongside ops console v2 — May 2026.*
