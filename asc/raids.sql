-- ============================================================================
-- ASC v0.2 // PORTABLE raids.sql
-- ----------------------------------------------------------------------------
-- Layer 3 raid coordination. Drop into any Asleepius product that wants the
-- "shared pool, equal share" multiplayer mechanic (canonically: Sky Scaffold
-- dataome uplink raids).
--
-- DEPENDS ON: asc/codes.sql (Layer 2 codes table + helpers).
-- AUTHORITY:  ../ASC_SPEC.md §2 Layer 3, §10 Phantom-discipline rule.
--
-- Math summary (from spec):
--   T = target_resources, scales with code tier (1x .. 10x baseline)
--   m = min_contribution, default = T * 0.02
--   p_base in [0.05, 0.30], halved if asc_code_hidden(code) is true
--   crowding_penalty = max(0, (over_pct - 0.10) * 0.5)
--   p_fail = clamp(p_base + crowding_penalty, 0, 0.95)
--   on success: reward_pool / count(contributors with sum >= m), equal share
--   on fail (any flavor): all resources burn
--
-- Phantom-discipline (spec §10): every table here emits RAW rows.
-- (raid_id, code_hash, amount, ts) etc. NO derived "intent" / "loyalty" /
-- "faction_pressure" columns. Phantom infers; this layer records.
-- ============================================================================

-- ============================================================================
-- 1. RAIDS TABLE  (Layer 3 coordination object)
-- ============================================================================
create table if not exists raids (
  raid_id            uuid primary key default gen_random_uuid(),
  code               text not null references codes(code) on delete restrict,
  target_resources   bigint not null check (target_resources > 0),
  min_contribution   bigint not null check (min_contribution > 0),
  reward_pool        bigint not null default 0,    -- abstract reward units
  fail_chance_base   numeric(3,2) not null
                       check (fail_chance_base >= 0 and fail_chance_base <= 0.95),
  deadline_at        timestamptz not null,
  status             text not null default 'open'
                       check (status in (
                         'open',
                         'ready_to_resolve',
                         'resolved_success',
                         'resolved_fail',
                         'burnt_deadline'
                       )),
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_p_fail    numeric(4,3),                 -- recorded post-roll
  resolved_dice      numeric(4,3),                 -- recorded post-roll
  notes              text
);

create index if not exists idx_raids_status   on raids(status);
create index if not exists idx_raids_code     on raids(code);
create index if not exists idx_raids_deadline on raids(deadline_at)
  where status = 'open';

-- ============================================================================
-- 2. RAID_CONTRIBUTIONS  (raw event log per ASC §10)
-- ----------------------------------------------------------------------------
-- One row per contribution event. We track code_hash (not raw code) so the
-- contributor identity is opaque to anyone reading the table without the
-- original code. The raw code is the player's; the platform records hashes.
-- ============================================================================
create table if not exists raid_contributions (
  contribution_id  uuid primary key default gen_random_uuid(),
  raid_id          uuid not null references raids(raid_id) on delete cascade,
  contributor_hash bigint not null,         -- asc_fnv1a(contributor_code)
  amount           bigint not null check (amount > 0),
  ts               timestamptz not null default now()
);

create index if not exists idx_contrib_raid       on raid_contributions(raid_id);
create index if not exists idx_contrib_contributor on raid_contributions(contributor_hash);

-- ============================================================================
-- 3. RAID_LOOT  (rewards waiting to be claimed by contributor)
-- ----------------------------------------------------------------------------
-- Loot model (b) per the plan: contributor polls by their code_hash, pulls
-- their share if any. Keeps the platform out of any notification surface
-- (email, push, etc.) — possession of the code IS the claim ticket.
-- ============================================================================
create table if not exists raid_loot (
  loot_id          uuid primary key default gen_random_uuid(),
  raid_id          uuid not null references raids(raid_id) on delete cascade,
  contributor_hash bigint not null,
  amount           bigint not null check (amount >= 0),
  claimed_at       timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_loot_unclaimed on raid_loot(contributor_hash)
  where claimed_at is null;
create index if not exists idx_loot_raid on raid_loot(raid_id);

-- ============================================================================
-- 4. MINT_RAID  (operator-only)
--    Creates the Layer 3 coordination row for a previously-minted RAD code.
--    Reads tier off the code's hash to set target_resources baseline.
--
--    Tier multiplier: T1=1x, T2=2.5x, T3=5x, T4=10x of p_target_baseline.
--    Hidden flag (Lucky): halves p_base when raid resolves.
-- ============================================================================
create or replace function mint_raid(
  p_code              text,
  p_target_baseline   bigint,
  p_reward_pool       bigint,
  p_deadline_in       interval,
  p_fail_chance_base  numeric default 0.15,
  p_min_pct           numeric default 0.02,   -- min contribution as % of target
  p_notes             text default null
) returns raids
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_canon  text;
  v_prefix text;
  v_tier   int;
  v_target bigint;
  v_min    bigint;
  v_row    raids;
begin
  v_canon  := asc_canonicalize_code(p_code);
  v_prefix := asc_code_prefix(v_canon);

  if v_canon is null or v_prefix is null then
    raise exception 'invalid code format: %', p_code;
  end if;
  if v_prefix <> 'RAD' then
    raise exception 'mint_raid requires a RAD prefix code, got: %', v_prefix;
  end if;
  if not exists (select 1 from codes where code = v_canon) then
    raise exception 'code % not found in codes table — mint Layer 2 first', v_canon;
  end if;
  if p_target_baseline <= 0 then
    raise exception 'target_baseline must be positive, got: %', p_target_baseline;
  end if;
  if p_fail_chance_base < 0 or p_fail_chance_base > 0.95 then
    raise exception 'fail_chance_base out of range [0, 0.95], got: %', p_fail_chance_base;
  end if;
  if p_min_pct <= 0 or p_min_pct > 1 then
    raise exception 'min_pct out of range (0, 1], got: %', p_min_pct;
  end if;

  v_tier := asc_code_tier(v_canon);
  v_target := case v_tier
    when 1 then p_target_baseline
    when 2 then (p_target_baseline * 25 / 10)
    when 3 then (p_target_baseline * 5)
    when 4 then (p_target_baseline * 10)
  end;
  v_min := greatest(1, (v_target * (p_min_pct * 100)::int / 100));

  insert into raids (
    code, target_resources, min_contribution, reward_pool,
    fail_chance_base, deadline_at, notes
  )
  values (
    v_canon, v_target, v_min, p_reward_pool,
    p_fail_chance_base, now() + p_deadline_in, p_notes
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ============================================================================
-- 5. JOIN_RAID  (service-role, called via Turnstile-gated Edge Function)
--    Records a contribution. Atomically:
--      a) validates raid is 'open' and not past deadline
--      b) inserts contribution row
--      c) checks if pool is now filled — if so, flips status to
--         'ready_to_resolve' so the Acurast worker can pick it up
--      d) returns: { ok, raid_status, pool_total, contributor_total }
--
--    Contributor identity is the FNV-1a hash of their code (opaque).
--    They MUST hold a code (any prefix works as identity for v0; future
--    versions may enforce specific prefixes for specific raids).
-- ============================================================================
create or replace function join_raid(
  p_raid_id          uuid,
  p_contributor_code text,
  p_amount           bigint
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_raid   raids;
  v_canon  text;
  v_hash   bigint;
  v_pool   bigint;
  v_self   bigint;
  v_filled boolean := false;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  v_canon := asc_canonicalize_code(p_contributor_code);
  if v_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_code_format');
  end if;
  v_hash := asc_fnv1a(v_canon);

  select * into v_raid from raids where raid_id = p_raid_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'raid_not_found');
  end if;
  if v_raid.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'raid_closed',
                              'raid_status', v_raid.status);
  end if;
  if v_raid.deadline_at < now() then
    update raids set status = 'burnt_deadline', resolved_at = now()
      where raid_id = p_raid_id;
    return jsonb_build_object('ok', false, 'error', 'deadline_passed',
                              'raid_status', 'burnt_deadline');
  end if;

  insert into raid_contributions (raid_id, contributor_hash, amount)
  values (p_raid_id, v_hash, p_amount);

  select coalesce(sum(amount), 0) into v_pool
    from raid_contributions where raid_id = p_raid_id;
  select coalesce(sum(amount), 0) into v_self
    from raid_contributions
    where raid_id = p_raid_id and contributor_hash = v_hash;

  if v_pool >= v_raid.target_resources then
    update raids set status = 'ready_to_resolve' where raid_id = p_raid_id;
    v_filled := true;
  end if;

  return jsonb_build_object(
    'ok',                 true,
    'raid_status',        case when v_filled then 'ready_to_resolve' else 'open' end,
    'pool_total',         v_pool,
    'pool_target',        v_raid.target_resources,
    'contributor_total',  v_self,
    'min_contribution',   v_raid.min_contribution,
    'meets_min',          v_self >= v_raid.min_contribution
  );
end;
$$;

-- ============================================================================
-- 6. SCAN_RAIDS_FOR_DEADLINES  (cron-callable, idempotent)
--    Sweeps 'open' raids past their deadline → 'burnt_deadline'. Does NOT
--    distribute loot (none earned on a deadline burn). Safe to call from
--    pg_cron at any cadence.
-- ============================================================================
create or replace function scan_raids_for_deadlines() returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  with burnt as (
    update raids
       set status = 'burnt_deadline',
           resolved_at = now()
     where status = 'open' and deadline_at < now()
    returning raid_id
  )
  select count(*) into v_count from burnt;
  return v_count;
end;
$$;

-- ============================================================================
-- 7. RESOLVE_RAID  (service-role, called by Acurast TEE worker)
--    Performs the dice roll for a 'ready_to_resolve' raid. Atomically:
--      a) computes p_fail using base + crowding penalty + hidden modifier
--      b) takes a dice roll in [0, 1) — caller-supplied so the TEE has
--         control over its randomness source (commit-reveal, on-chain RNG,
--         /dev/urandom from inside the secure enclave)
--      c) on success: distributes reward_pool equally among contributors
--                     with sum(amount) >= min_contribution; writes
--                     raid_loot rows
--      d) on fail: writes nothing (all resources burn implicitly — they
--                  stay in raid_contributions as historical record but
--                  no loot rows are created)
--      e) sets terminal status + records p_fail + dice for audit
--
--    Returns a descriptor for the worker's logs.
-- ============================================================================
create or replace function resolve_raid(
  p_raid_id uuid,
  p_dice    numeric            -- in [0, 1)
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_raid       raids;
  v_pool       bigint;
  v_over_pct   numeric;
  v_crowd      numeric;
  v_base       numeric;
  v_p_fail     numeric;
  v_hidden     boolean;
  v_eligible   int;
  v_share      bigint;
begin
  if p_dice is null or p_dice < 0 or p_dice >= 1 then
    return jsonb_build_object('ok', false, 'error', 'invalid_dice');
  end if;

  select * into v_raid from raids where raid_id = p_raid_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'raid_not_found');
  end if;
  if v_raid.status <> 'ready_to_resolve' then
    return jsonb_build_object('ok', false, 'error', 'raid_not_ready',
                              'raid_status', v_raid.status);
  end if;

  select coalesce(sum(amount), 0) into v_pool
    from raid_contributions where raid_id = p_raid_id;

  v_over_pct := (v_pool::numeric / v_raid.target_resources::numeric) - 1;
  v_crowd    := greatest(0, (v_over_pct - 0.10) * 0.5);
  v_hidden   := asc_code_hidden(v_raid.code);
  v_base     := case when v_hidden then v_raid.fail_chance_base / 2
                     else v_raid.fail_chance_base end;
  v_p_fail   := least(0.95, greatest(0, v_base + v_crowd));

  if p_dice < v_p_fail then
    -- FAIL. All resources burn; no loot distributed.
    update raids
       set status          = 'resolved_fail',
           resolved_at     = now(),
           resolved_p_fail = v_p_fail,
           resolved_dice   = p_dice
     where raid_id = p_raid_id;

    return jsonb_build_object(
      'ok',           true,
      'raid_status',  'resolved_fail',
      'pool_total',   v_pool,
      'p_fail',       v_p_fail,
      'dice',         p_dice,
      'hidden',       v_hidden
    );
  end if;

  -- SUCCESS. Equal share among contributors meeting min_contribution.
  select count(*) into v_eligible
    from (
      select contributor_hash
        from raid_contributions
       where raid_id = p_raid_id
       group by contributor_hash
      having sum(amount) >= v_raid.min_contribution
    ) e;

  if v_eligible = 0 then
    -- Edge case: nobody hit min (possible if many tiny contributors filled
    -- the pool). Treat as success-but-nobody-qualified: status success,
    -- reward_pool burns. Phantom can read this as a coordination signal.
    update raids
       set status          = 'resolved_success',
           resolved_at     = now(),
           resolved_p_fail = v_p_fail,
           resolved_dice   = p_dice
     where raid_id = p_raid_id;

    return jsonb_build_object(
      'ok',                true,
      'raid_status',       'resolved_success',
      'pool_total',        v_pool,
      'p_fail',            v_p_fail,
      'dice',              p_dice,
      'eligible_count',    0,
      'share_per_winner',  0
    );
  end if;

  v_share := v_raid.reward_pool / v_eligible;

  insert into raid_loot (raid_id, contributor_hash, amount)
  select p_raid_id, contributor_hash, v_share
    from raid_contributions
   where raid_id = p_raid_id
   group by contributor_hash
  having sum(amount) >= v_raid.min_contribution;

  update raids
     set status          = 'resolved_success',
         resolved_at     = now(),
         resolved_p_fail = v_p_fail,
         resolved_dice   = p_dice
   where raid_id = p_raid_id;

  return jsonb_build_object(
    'ok',                true,
    'raid_status',       'resolved_success',
    'pool_total',        v_pool,
    'p_fail',            v_p_fail,
    'dice',              p_dice,
    'eligible_count',    v_eligible,
    'share_per_winner',  v_share,
    'hidden',            v_hidden
  );
end;
$$;

-- ============================================================================
-- 8. PEEK_RAID  (anon-callable)
--    Public read of a raid's current state. Anyone with the raid_id (or
--    the RAD code → look up raid_id) can see fill progress. No identity
--    is leaked — only aggregate pool stats and contributor count.
-- ============================================================================
create or replace function peek_raid(p_raid_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_raid raids;
  v_pool bigint;
  v_count int;
begin
  select * into v_raid from raids where raid_id = p_raid_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'raid_not_found');
  end if;

  select coalesce(sum(amount), 0), count(distinct contributor_hash)
    into v_pool, v_count
    from raid_contributions where raid_id = p_raid_id;

  return jsonb_build_object(
    'ok',                  true,
    'raid_id',             v_raid.raid_id,
    'code',                v_raid.code,
    'status',              v_raid.status,
    'target_resources',    v_raid.target_resources,
    'min_contribution',    v_raid.min_contribution,
    'reward_pool',         v_raid.reward_pool,
    'pool_total',          v_pool,
    'contributor_count',   v_count,
    'deadline_at',         v_raid.deadline_at,
    'fill_pct',            (v_pool::numeric / v_raid.target_resources::numeric)
  );
end;
$$;

-- Convenience: look up the open raid for a RAD code (most recent).
create or replace function peek_raid_by_code(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_canon text;
  v_id uuid;
begin
  v_canon := asc_canonicalize_code(p_code);
  if v_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;
  select raid_id into v_id
    from raids where code = v_canon
    order by created_at desc limit 1;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'no_raid_for_code');
  end if;
  return peek_raid(v_id);
end;
$$;

-- ============================================================================
-- 9. CLAIM_RAID_LOOT  (service-role via Edge Function)
--    Contributor presents their code; we hash it and return any unclaimed
--    loot rows, marking them claimed in the same transaction.
--
--    The Edge Function is responsible for verifying the requester actually
--    presented the code (not just the hash) — this RPC trusts the hash it
--    receives. Always call from a Turnstile-gated path.
-- ============================================================================
create or replace function claim_raid_loot(p_contributor_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_canon text;
  v_hash  bigint;
  v_total bigint;
  v_rows  jsonb;
begin
  v_canon := asc_canonicalize_code(p_contributor_code);
  if v_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;
  v_hash := asc_fnv1a(v_canon);

  with claimed as (
    update raid_loot
       set claimed_at = now()
     where contributor_hash = v_hash and claimed_at is null
     returning loot_id, raid_id, amount
  )
  select coalesce(sum(amount), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'loot_id', loot_id, 'raid_id', raid_id, 'amount', amount
         )), '[]'::jsonb)
    into v_total, v_rows
    from claimed;

  return jsonb_build_object(
    'ok',     true,
    'total',  v_total,
    'items',  v_rows
  );
end;
$$;

-- ============================================================================
-- 10. PERMISSIONS
-- ============================================================================
alter table raids               enable row level security;
alter table raid_contributions  enable row level security;
alter table raid_loot           enable row level security;
-- (No policies. Locked except for service_role.)

revoke execute on function mint_raid(text, bigint, bigint, interval, numeric, numeric, text)
  from public;
grant  execute on function mint_raid(text, bigint, bigint, interval, numeric, numeric, text)
  to service_role;

revoke execute on function join_raid(uuid, text, bigint) from public;
grant  execute on function join_raid(uuid, text, bigint) to service_role;

revoke execute on function resolve_raid(uuid, numeric) from public;
grant  execute on function resolve_raid(uuid, numeric) to service_role;

revoke execute on function claim_raid_loot(text) from public;
grant  execute on function claim_raid_loot(text) to service_role;

revoke execute on function scan_raids_for_deadlines() from public;
grant  execute on function scan_raids_for_deadlines() to service_role;

grant execute on function peek_raid(uuid)              to anon, authenticated, service_role;
grant execute on function peek_raid_by_code(text)      to anon, authenticated, service_role;

-- ============================================================================
-- 11. EXAMPLE SESSION
-- ----------------------------------------------------------------------------
-- -- Operator mints a RAD code (Layer 2 row first):
-- select mint_code('RAD-NIGHTSHIFT-04', 0, null,
--                  'phase 1 dataome uplink raid · portsman dock');
--
-- -- Operator mints the Layer 3 raid:
-- select mint_raid(
--   'RAD-NIGHTSHIFT-04',
--   p_target_baseline  => 10000,           -- T1 baseline; tier scales it
--   p_reward_pool      => 5000,
--   p_deadline_in      => interval '7 days',
--   p_fail_chance_base => 0.15,
--   p_min_pct          => 0.02,
--   p_notes            => 'first raid · hand-tested baseline'
-- );
--
-- -- Players join (called by the join_raid Edge Function):
-- select join_raid('<raid_id>', 'ASL-PLAYER-A', 2500);
-- select join_raid('<raid_id>', 'ASL-PLAYER-B', 4000);
-- select join_raid('<raid_id>', 'ASL-PLAYER-C', 1200);
-- ...
--
-- -- Acurast TEE worker, when it sees status='ready_to_resolve':
-- select resolve_raid('<raid_id>', random()::numeric);
--   -- (in production the worker supplies a verifiable RNG, not random())
--
-- -- Player claims loot (called by Edge Function, Turnstile-gated):
-- select claim_raid_loot('ASL-PLAYER-A');
-- ============================================================================
