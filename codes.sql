-- ============================================================================
-- DriftMetrics  //  Layer 2 Codes Extension (ASC v0.1)
-- ----------------------------------------------------------------------------
-- Run AFTER schema.sql. Adds the codes table, redemption RPC, mint helper,
-- and the trigger update that lets coded requests bypass per-IP rate gates.
--
-- Pairs with the spec at ASC_SPEC.md and the Layer 1 reference at
-- G:\Projects\theVibez\underground\crawler\codes.js.
-- ============================================================================

-- ============================================================================
-- 1. CODES TABLE
-- ============================================================================
create table if not exists codes (
  code           text primary key,           -- canonical form: UPPER, no whitespace
  category       text not null,              -- ASL/DRF/EVT/PRO/etc.
  balance        int  not null default 10,
  generation     int  not null default 1,    -- which mint drop this came from
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  use_count      int  not null default 0,
  notes          text                        -- internal memo: who got this, why
);

create index if not exists idx_codes_category on codes(category);
create index if not exists idx_codes_expires  on codes(expires_at)
  where expires_at is not null;

-- ============================================================================
-- 2. CODE NORMALIZATION HELPER
--    Mirrors Underground's parseCode canonicalization: uppercase, strip ws.
-- ============================================================================
create or replace function dm_canonicalize_code(p_raw text) returns text
language sql immutable
as $$
  select case
    when p_raw is null or btrim(p_raw) = '' then null
    else regexp_replace(upper(p_raw), '\s+', '', 'g')
  end;
$$;

-- ============================================================================
-- 3. PREFIX EXTRACTION
--    Returns the three-letter prefix or null if malformed.
-- ============================================================================
create or replace function dm_code_prefix(p_code text) returns text
language sql immutable
as $$
  select case
    when p_code ~ '^[A-Z]{3}-.+$' then substring(p_code from 1 for 3)
    else null
  end;
$$;

-- ============================================================================
-- 4. FNV-1a 32-BIT HASH (matches Underground's codes.js exactly)
--    Returns the canonical hash so server-side decisions stay consistent
--    with what the JS client computes. Used by the Bonus mechanic in §6.
-- ============================================================================
create or replace function dm_fnv1a(p_str text) returns bigint
language plpgsql immutable
as $$
declare
  h bigint := x'811c9dc5'::bigint;        -- FNV-1a 32-bit offset basis
  prime bigint := x'01000193'::bigint;    -- FNV prime
  i int;
  c int;
begin
  if p_str is null then return 0; end if;
  for i in 1 .. length(p_str) loop
    c := ascii(substring(p_str from i for 1));
    h := (h # c::bigint);                 -- xor
    h := (h * prime) & x'FFFFFFFF'::bigint;  -- mul mod 2^32
  end loop;
  return h;
end;
$$;

-- Hidden Bonus flag (matches Underground's "Currept" derivation: byte 1 < 102).
create or replace function dm_code_is_bonus(p_code text) returns boolean
language sql immutable
as $$
  select ((dm_fnv1a(p_code) >> 8) & 255) < 102;
$$;

-- Tier (1-4) from low byte. Same distribution as Underground codes.js.
create or replace function dm_code_tier(p_code text) returns int
language sql immutable
as $$
  select case
    when (dm_fnv1a(p_code) & 255) < 140 then 1
    when (dm_fnv1a(p_code) & 255) < 210 then 2
    when (dm_fnv1a(p_code) & 255) < 245 then 3
    else 4
  end;
$$;

-- ============================================================================
-- 5. SHADOWBAN TRIGGER UPDATE
--    Coded requests skip per-IP rate gates. We still apply: keyword shape,
--    honeypot, and global pending backpressure. The Edge Function sets the
--    session var dm.coded_request='true' before its INSERT.
-- ============================================================================
create or replace function shadowban_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ip      text;
  v_recent  int;
  v_daily   int;
  v_global  int;
  v_coded   boolean;
begin
  v_ip := dm_client_ip();
  new.ip_address := v_ip;
  new.keyword := lower(trim(coalesce(new.keyword, '')));

  -- Detect coded request via session var. set_config(..., true) is txn-local
  -- so this only applies to the current INSERT, not subsequent ones.
  v_coded := coalesce(current_setting('dm.coded_request', true), 'false') = 'true';

  -- Gate 1: keyword shape. Applies to ALL paths (coded or not).
  if length(new.keyword) < 2 or length(new.keyword) > 128 then
    new.status := 'shadowbanned';
    return new;
  end if;

  -- Gate 2: honeypot. Applies to ALL paths.
  if new.honeypot is not null and length(new.honeypot) > 0 then
    new.status := 'shadowbanned';
    return new;
  end if;

  -- Gates 3+4: per-IP rate. SKIPPED for coded requests.
  -- The user paid in code-balance; per-IP rate is now irrelevant.
  if not v_coded then
    select count(*) into v_recent
      from query_queue
     where ip_address = v_ip
       and created_at > now() - interval '10 minutes';
    if v_recent > 3 then
      new.status := 'shadowbanned';
      return new;
    end if;

    select count(*) into v_daily
      from query_queue
     where ip_address = v_ip
       and created_at > now() - interval '24 hours';
    if v_daily > 50 then
      new.status := 'shadowbanned';
      return new;
    end if;
  end if;

  -- Gate 5: global pending backpressure. Applies to ALL paths.
  -- A runaway code with 10000 balance still cannot DoS the queue.
  select count(*) into v_global
    from query_queue
   where status = 'pending';
  if v_global > 200 then
    new.status := 'shadowbanned';
    return new;
  end if;

  return new;
end;
$$;

-- (The trigger itself was created in schema.sql; this CREATE OR REPLACE
-- just updates the function definition. No need to drop/recreate the trigger.)

-- ============================================================================
-- 6. REDEEM_CODE RPC
--    The Edge Function calls this. It atomically:
--      a) Validates and locks the code row
--      b) Checks balance > 0 and not expired
--      c) Decrements balance
--      d) Inserts the queue row with the bypass session var set
--      e) Returns: { ok, remaining, bonus, error_code }
--
--    The function returns an error_code on failure, but the Edge Function
--    is responsible for translating that into client-visible behavior. By
--    spec, an invalid code should be silently shadowbanned at the surface —
--    the client should see "submitted" regardless. Whether to honor that or
--    show a user-facing "invalid code" message is a UX decision the Edge
--    Function makes; the database is honest about what happened.
-- ============================================================================
create or replace function redeem_code(
  p_request_id uuid,
  p_keyword    text,
  p_code       text,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_code_canon text;
  v_row codes;
  v_bonus boolean;
  v_global int;
begin
  v_code_canon := dm_canonicalize_code(p_code);
  if v_code_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  -- Lock the row so concurrent redemptions can't double-spend.
  select * into v_row
    from codes
   where code = v_code_canon
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_row.balance <= 0 then
    return jsonb_build_object('ok', false, 'error', 'depleted');
  end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- Global backpressure check happens here too (defense in depth).
  select count(*) into v_global from query_queue where status = 'pending';
  if v_global > 200 then
    return jsonb_build_object('ok', false, 'error', 'queue_full');
  end if;

  -- Decrement balance and stamp.
  update codes
     set balance      = balance - 1,
         use_count    = use_count + 1,
         last_used_at = now()
   where code = v_code_canon;

  -- Bonus: if the code's hash flag is set, the resulting report gets a
  -- 24h cache TTL instead of 1h, donating compute to the public square.
  v_bonus := dm_code_is_bonus(v_code_canon);

  -- Insert the queue row with the bypass var set.
  perform set_config('dm.coded_request', 'true', true);
  insert into query_queue (request_id, keyword, honeypot, user_agent, status)
  values (p_request_id, p_keyword, '', p_user_agent, 'pending');

  return jsonb_build_object(
    'ok',        true,
    'remaining', v_row.balance - 1,
    'bonus',     v_bonus,
    'tier',      dm_code_tier(v_code_canon),
    'category',  v_row.category
  );
end;
$$;

-- ============================================================================
-- 7. MINT HELPER
--    Convenience for handing out codes from psql. Inserts with sane defaults
--    based on the prefix. You can override any field manually too.
--
--    Examples:
--      select mint_code('DRF-7F4A-BLOOM');                       -- 10 scrapes, no expiry
--      select mint_code('EVT-2026-MAYDROP-A', 5, '30 days');     -- 5 scrapes, 30d expiry
--      select mint_code('ASL-FOUNDERS-001', 100, null, 'gen 1, handed out at PAX East');
-- ============================================================================
create or replace function mint_code(
  p_code        text,
  p_balance     int    default null,
  p_expires_in  interval default null,
  p_notes       text   default null,
  p_generation  int    default 1
) returns codes
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_canon text;
  v_prefix text;
  v_category text;
  v_balance int;
  v_expires timestamptz;
  v_row codes;
begin
  v_canon := dm_canonicalize_code(p_code);
  v_prefix := dm_code_prefix(v_canon);

  if v_canon is null or v_prefix is null then
    raise exception 'invalid code format: %', p_code;
  end if;

  -- ASC v0.1 §6 defaults
  v_category := case v_prefix
    when 'DRF' then 'driftmetrics'
    when 'ASL' then 'universal'
    when 'EVT' then 'event'
    when 'PRO' then 'pack'
    when 'SCH' then 'schema'        -- recognized but balance defaults 0
    when 'ARC' then 'archive'
    when 'ESO' then 'esoterica'
    when 'PCK' then 'underground_pack'
    else            'unknown'
  end;

  v_balance := coalesce(p_balance, case v_prefix
    when 'DRF' then 10
    when 'ASL' then 10
    when 'EVT' then 5
    when 'PRO' then 30
    else 0
  end);

  v_expires := case
    when p_expires_in is not null then now() + p_expires_in
    when v_prefix = 'EVT' then now() + interval '30 days'
    else null
  end;

  insert into codes (code, category, balance, generation, expires_at, notes)
  values (v_canon, v_category, v_balance, p_generation, v_expires, p_notes)
  on conflict (code) do update
    set balance     = excluded.balance,
        expires_at  = excluded.expires_at,
        notes       = excluded.notes,
        generation  = excluded.generation
  returning * into v_row;

  return v_row;
end;
$$;

-- ============================================================================
-- 8. PERMISSIONS
-- ============================================================================
-- redeem_code is invoked by the Edge Function (service role).
-- Anon must NEVER call it directly — they don't have the verified
-- Turnstile token, so we don't want them bypassing the gate.
revoke execute on function redeem_code(uuid, text, text, text) from public;
grant  execute on function redeem_code(uuid, text, text, text) to service_role;

-- mint_code is for you, the operator, in the SQL editor. Never expose.
revoke execute on function mint_code(text, int, interval, text, int) from public;
grant  execute on function mint_code(text, int, interval, text, int) to service_role;

-- Hash/parse helpers are pure — fine for anyone to call.
grant execute on function dm_canonicalize_code(text) to public;
grant execute on function dm_code_prefix(text)        to public;
grant execute on function dm_fnv1a(text)              to public;
grant execute on function dm_code_is_bonus(text)      to public;
grant execute on function dm_code_tier(text)          to public;

-- Codes table: workers don't read it; only the redeem_code function does.
-- Anon never reads it (knowledge of remaining balance shouldn't leak).
alter table codes enable row level security;
-- (No policies. Locked down except for service_role which bypasses RLS.)

-- ============================================================================
-- 9. EXAMPLE MINTING (run these by hand once, then delete from the file)
-- ----------------------------------------------------------------------------
-- select mint_code('ASL-FOUNDERS-001', 100, null, 'phase 4 launch — Jordan personal');
-- select mint_code('ASL-FOUNDERS-002', 50,  null, 'first community drop');
-- select mint_code('DRF-PAX-EAST-A',   10,  '90 days', 'PAX East cards, gen 1');
-- select mint_code('EVT-2026-MAYDROP-A', 5, '30 days', 'May 2026 launch promo');
-- ============================================================================
