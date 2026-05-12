-- ============================================================================
-- ASC v0.2 // PORTABLE codes.sql
-- ----------------------------------------------------------------------------
-- Layer 2 codes table + helpers + RPCs. Drop into any Asleepius product's
-- Supabase project. Spec-conformant by construction.
--
-- This file is a master copy from G:\Projects\AlgoParallax\Drift-Metrics\asc\.
-- Each product owns its own deployed copy from the moment it absorbs this
-- file. Re-pull when ASC bumps version.
--
-- Authority: ../ASC_SPEC.md (v0.2 ecosystem pass)
--
-- ============================================================================
-- Per-product configuration
-- ----------------------------------------------------------------------------
-- The mint_code() defaults block at the bottom is the only place that should
-- need product-specific tuning. Look for the comment "PRODUCT-SPECIFIC
-- DEFAULTS" and adjust balance / expiry per prefix to taste. Everything
-- else is canonical and should NOT be edited.
-- ============================================================================

-- ============================================================================
-- 1. CODES TABLE
-- ============================================================================
create table if not exists codes (
  code           text primary key,           -- canonical: UPPER, no whitespace
  category       text not null,              -- ASL/DRF/EVT/PRO/RAD/etc.
  balance        int  not null default 10,
  generation     int  not null default 1,
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  use_count      int  not null default 0,
  notes          text                        -- internal memo
);

create index if not exists idx_codes_category on codes(category);
create index if not exists idx_codes_expires  on codes(expires_at)
  where expires_at is not null;

-- ============================================================================
-- 2. CODE NORMALIZATION
--    Mirrors the Layer 1 reference at
--    G:\Projects\theVibez\underground\crawler\codes.js (parseCode).
-- ============================================================================
create or replace function asc_canonicalize_code(p_raw text) returns text
language sql immutable
as $$
  select case
    when p_raw is null or btrim(p_raw) = '' then null
    else regexp_replace(upper(p_raw), '\s+', '', 'g')
  end;
$$;

create or replace function asc_code_prefix(p_code text) returns text
language sql immutable
as $$
  select case
    when p_code ~ '^[A-Z]{3}-.+$' then substring(p_code from 1 for 3)
    else null
  end;
$$;

-- ============================================================================
-- 3. FNV-1a 32-BIT HASH
--    Byte-for-byte equivalent to the JS reference. Used by tier and
--    hidden_flag derivations so client and server agree.
-- ============================================================================
create or replace function asc_fnv1a(p_str text) returns bigint
language plpgsql immutable
as $$
declare
  h bigint := x'811c9dc5'::bigint;
  prime bigint := x'01000193'::bigint;
  i int;
  c int;
begin
  if p_str is null then return 0; end if;
  for i in 1 .. length(p_str) loop
    c := ascii(substring(p_str from i for 1));
    h := (h # c::bigint);
    h := (h * prime) & x'FFFFFFFF'::bigint;
  end loop;
  return h;
end;
$$;

-- Tier (1-4) from low byte. Distribution from ASC §2 Layer 1.
create or replace function asc_code_tier(p_code text) returns int
language sql immutable
as $$
  select case
    when (asc_fnv1a(p_code) & 255) < 140 then 1
    when (asc_fnv1a(p_code) & 255) < 210 then 2
    when (asc_fnv1a(p_code) & 255) < 245 then 3
    else 4
  end;
$$;

-- Hidden flag from second byte (~40% rate). Per-product semantics:
--   Underground: "Currept"
--   DriftMetrics: "Bonus" (extended cache TTL)
--   Sky Scaffold: "Lucky" (raid fail_chance halved)
create or replace function asc_code_hidden(p_code text) returns boolean
language sql immutable
as $$
  select ((asc_fnv1a(p_code) >> 8) & 255) < 102;
$$;

-- ============================================================================
-- 4. MINT_CODE  (operator-only)
--    Inserts or upserts a code with sensible defaults per prefix. The
--    PRODUCT-SPECIFIC DEFAULTS block below is the one place to tune.
-- ============================================================================
create or replace function mint_code(
  p_code        text,
  p_balance     int      default null,
  p_expires_in  interval default null,
  p_notes       text     default null,
  p_generation  int      default 1
) returns codes
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_canon    text;
  v_prefix   text;
  v_category text;
  v_balance  int;
  v_expires  timestamptz;
  v_row      codes;
begin
  v_canon  := asc_canonicalize_code(p_code);
  v_prefix := asc_code_prefix(v_canon);

  if v_canon is null or v_prefix is null then
    raise exception 'invalid code format: %', p_code;
  end if;

  -- ---- ASC v0.2 §3 prefix → category mapping ----
  v_category := case v_prefix
    when 'ASL' then 'universal'
    when 'EVT' then 'event'
    when 'PRO' then 'pack'
    when 'DRF' then 'driftmetrics'
    when 'RAD' then 'raid'
    when 'SCH' then 'schema'
    when 'ARC' then 'archive'
    when 'ESO' then 'esoterica'
    when 'PCK' then 'underground_pack'
    else            'unknown'
  end;

  -- ---- PRODUCT-SPECIFIC DEFAULTS (tune per product) ----
  -- These match Drift's defaults. Other products should set their own
  -- balance and expiry strategy. RAD codes default to balance 0 because
  -- joining a raid does not consume the code (Layer 3 semantics).
  v_balance := coalesce(p_balance, case v_prefix
    when 'DRF' then 10
    when 'ASL' then 10
    when 'EVT' then 5
    when 'PRO' then 30
    when 'RAD' then 0
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
-- 5. REDEEM_CODE  (service-role only)
--    Atomically validates + decrements balance. Returns a jsonb
--    descriptor; the caller (Edge Function or server-side trusted code)
--    decides what to do with the result.
--
--    INTENTIONAL DIFFERENCE from Drift's codes.sql: this portable version
--    does NOT touch any product-specific tables (no query_queue insert).
--    Each product's submit/join Edge Function calls redeem_code, then
--    performs its own next-step write. Keeps this file product-agnostic.
-- ============================================================================
create or replace function redeem_code(
  p_code text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_canon text;
  v_row codes;
begin
  v_canon := asc_canonicalize_code(p_code);
  if v_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  select * into v_row
    from codes
   where code = v_canon
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

  update codes
     set balance      = balance - 1,
         use_count    = use_count + 1,
         last_used_at = now()
   where code = v_canon;

  return jsonb_build_object(
    'ok',        true,
    'remaining', v_row.balance - 1,
    'hidden',    asc_code_hidden(v_canon),
    'tier',      asc_code_tier(v_canon),
    'category',  v_row.category,
    'prefix',    asc_code_prefix(v_canon)
  );
end;
$$;

-- ============================================================================
-- 6. PEEK_CODE  (anon-callable)
--    Read-only balance lookup. Never decrements, never logs. Safe to
--    expose to anon — knowledge of remaining balance does not grant
--    burning ability (the burn path goes through Turnstile + service
--    role).
-- ============================================================================
create or replace function peek_code(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_canon text;
  v_row codes;
begin
  v_canon := asc_canonicalize_code(p_code);
  if v_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  select * into v_row from codes where code = v_canon;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    return jsonb_build_object(
      'ok', false, 'error', 'expired',
      'remaining', v_row.balance
    );
  end if;

  return jsonb_build_object(
    'ok',        true,
    'remaining', v_row.balance,
    'tier',      asc_code_tier(v_canon),
    'prefix',    asc_code_prefix(v_canon),
    'category',  v_row.category
  );
end;
$$;

-- ============================================================================
-- 7. PERMISSIONS
-- ============================================================================
alter table codes enable row level security;
-- (No policies. Locked except for service_role which bypasses RLS.)

revoke execute on function redeem_code(text)                from public;
grant  execute on function redeem_code(text)                to service_role;

revoke execute on function mint_code(text, int, interval, text, int) from public;
grant  execute on function mint_code(text, int, interval, text, int) to service_role;

grant execute on function asc_canonicalize_code(text) to public;
grant execute on function asc_code_prefix(text)       to public;
grant execute on function asc_fnv1a(text)             to public;
grant execute on function asc_code_tier(text)         to public;
grant execute on function asc_code_hidden(text)       to public;

revoke execute on function peek_code(text) from public;
grant  execute on function peek_code(text) to anon;
grant  execute on function peek_code(text) to authenticated;
grant  execute on function peek_code(text) to service_role;

-- ============================================================================
-- 8. CROSS-PRODUCT MINT EXAMPLES (per ASC §4)
-- ----------------------------------------------------------------------------
-- The same canonical string minted in multiple product DBs gives you the
-- "ecosystem code." Run these by hand once, then delete from your copy.
--
-- select mint_code('ASL-FOUNDERS-001', 100, null, 'phase 4 launch');
-- select mint_code('EVT-2026-MAYDROP-A', 5, '30 days', 'may 2026 promo');
--
-- For RAD codes, also create the Layer 3 row in raids.sql via mint_raid().
-- ============================================================================
