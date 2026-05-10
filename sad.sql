-- ============================================================================
-- DriftMetrics // SAD Ledger Stub (Bureau game layer)  v0.3a
-- ----------------------------------------------------------------------------
-- The Social Ledger Stub. Server-side notary record for the Bureau layer.
-- The body of any player's archive lives entirely in their localStorage.
-- The Stub stores ONLY:
--   * code_hash    = sha256(canonical anchor code) — first code in codex
--   * chain_nonce  = client-generated random hex32 — disambiguates parallel
--                    chains that share an anchor (lore: rival auditors)
--   * head_hash    = current chain head
--   * event_count  = monotonic event counter
--   * cdx_hash     = sha256-roll over the codex; passively stored in v0.3a
--                    (no server enforcement, but binds the client chain)
--
-- Two distinct chains MAY exist on the same anchor code, distinguished by
-- chain_nonce. This is by design — the lore canon for "two assets file
-- against the same credential." Each gets its own row.
--
-- v0.3a does NOT enforce cdx_hash transitions on the server. The hash is
-- bound into the chain event hash on the client side, so tampering with
-- the codex breaks local verification. Server enforcement of cdx_hash
-- transitions is reserved for v0.3b.
--
-- Run AFTER schema.sql and codes.sql. Idempotent.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- 1. STUB TABLE
-- ----------------------------------------------------------------------------
-- Fresh databases get the v0.3 schema directly. Pre-v0.3 databases get an
-- in-place migration: add the new columns and swap the primary key from
-- single-column to composite. Existing rows receive the legacy sentinel
-- chain_nonce ('0' * 32) so they keep functioning without disruption.
-- ============================================================================
create table if not exists sad_ledger_stub (
  code_hash    text not null,                       -- sha256(anchor code)
  chain_nonce  text not null default repeat('0', 32),
  head_hash    text not null,
  event_count  bigint not null default 0,
  cdx_hash     text,                                 -- nullable for legacy chains
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- v0.1/v0.2 → v0.3 migration. Idempotent: only fires if columns are missing
-- or the legacy single-column PK is still in place.
alter table sad_ledger_stub
  add column if not exists chain_nonce text not null default repeat('0', 32),
  add column if not exists cdx_hash    text;

do $$
declare
  old_pk_count integer;
  new_pk_count integer;
begin
  select count(*) into old_pk_count
    from pg_constraint c
   where c.conrelid = 'public.sad_ledger_stub'::regclass
     and c.contype  = 'p'
     and array_length(c.conkey, 1) = 1;
  select count(*) into new_pk_count
    from pg_constraint c
   where c.conrelid = 'public.sad_ledger_stub'::regclass
     and c.contype  = 'p'
     and array_length(c.conkey, 1) = 2;

  if old_pk_count > 0 and new_pk_count = 0 then
    alter table sad_ledger_stub drop constraint sad_ledger_stub_pkey;
  end if;
  if new_pk_count = 0 then
    alter table sad_ledger_stub add primary key (code_hash, chain_nonce);
  end if;
end $$;

create index if not exists idx_sad_stub_updated on sad_ledger_stub(updated_at desc);
create index if not exists idx_sad_stub_code    on sad_ledger_stub(code_hash);

alter table sad_ledger_stub enable row level security;
-- (No policies. Locked except for service_role bypass. Reads go through
--  sad_peek() which is anon-callable and exposes head + count + cdx_hash.)

-- ============================================================================
-- 2. CODE -> CODE_HASH HELPER
-- ============================================================================
create or replace function sad_code_hash(p_code text) returns text
language sql stable
as $$
  select case
    when dm_canonicalize_code(p_code) is null then null
    else encode(extensions.digest(dm_canonicalize_code(p_code), 'sha256'), 'hex')
  end;
$$;

grant execute on function sad_code_hash(text) to public;

-- ============================================================================
-- 3. SAD_PEEK
--    Looks up a chain by (anchor_code, chain_nonce). Anyone can call it.
--    Returns:
--      { ok:true,  exists:false, head:zero64, count:0,  cdx_hash:null }   no row
--      { ok:true,  exists:true,  head, count, cdx_hash }                  found
--      { ok:false, error:'invalid_format' }                               bad input
--
--    A fresh device that has not yet picked a chain_nonce should not call
--    this — it should generate a new nonce locally and start a fresh chain.
--    sad_peek does NOT enumerate chains for a given code; you must already
--    know which chain (which nonce) you're asking about.
-- ============================================================================
drop function if exists sad_peek(text);
drop function if exists sad_peek(text, text);
create function sad_peek(p_code text, p_chain_nonce text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_row  sad_ledger_stub;
  v_zero text := repeat('0', 64);
begin
  v_hash := sad_code_hash(p_code);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;
  if p_chain_nonce is null or length(p_chain_nonce) <> 32 or p_chain_nonce !~ '^[0-9a-f]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_chain_nonce');
  end if;

  select * into v_row from sad_ledger_stub
   where code_hash = v_hash and chain_nonce = p_chain_nonce;

  if not found then
    return jsonb_build_object(
      'ok',       true,
      'exists',   false,
      'head',     v_zero,
      'count',    0,
      'cdx_hash', null
    );
  end if;

  return jsonb_build_object(
    'ok',       true,
    'exists',   true,
    'head',     v_row.head_hash,
    'count',    v_row.event_count,
    'cdx_hash', v_row.cdx_hash
  );
end;
$$;

revoke execute on function sad_peek(text, text) from public;
grant  execute on function sad_peek(text, text) to anon, authenticated, service_role;

-- ============================================================================
-- 4. SAD_ADVANCE
--    CAS-update of a chain identified by (anchor_code, chain_nonce). Genesis
--    requires p_prev_head = zero64 and p_new_count = 1; existing chains
--    require stored.head_hash = p_prev_head AND stored.event_count = p_new_count - 1.
--    cdx_hash is stored passively (not enforced) in v0.3a.
--
--    Service-role only. Invoked exclusively by the sad_advance Edge Function
--    after it has validated the active code and (optionally) burned scrapes.
-- ============================================================================
drop function if exists sad_advance(text, text, text, bigint);
drop function if exists sad_advance(text, text, text, text, bigint, text);
create function sad_advance(
  p_anchor_code text,
  p_chain_nonce text,
  p_prev_head   text,
  p_new_head    text,
  p_new_count   bigint,
  p_cdx_hash    text
) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_row  sad_ledger_stub;
  v_zero text := repeat('0', 64);
begin
  v_hash := sad_code_hash(p_anchor_code);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;
  if p_chain_nonce is null or length(p_chain_nonce) <> 32 or p_chain_nonce !~ '^[0-9a-f]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_chain_nonce');
  end if;

  select * into v_row from sad_ledger_stub
   where code_hash = v_hash and chain_nonce = p_chain_nonce
   for update;

  if not found then
    -- Genesis. prev_head must be zero64 and new_count must be 1.
    if p_prev_head <> v_zero then
      return jsonb_build_object(
        'ok',       false,
        'error',    'desync',
        'head',     v_zero,
        'count',    0,
        'cdx_hash', null
      );
    end if;
    if p_new_count <> 1 then
      return jsonb_build_object('ok', false, 'error', 'invalid_genesis_count');
    end if;
    insert into sad_ledger_stub (code_hash, chain_nonce, head_hash, event_count, cdx_hash)
    values (v_hash, p_chain_nonce, p_new_head, p_new_count, p_cdx_hash);
    return jsonb_build_object(
      'ok',       true,
      'head',     p_new_head,
      'count',    p_new_count,
      'cdx_hash', p_cdx_hash
    );
  end if;

  -- Existing chain. CAS check on head + count.
  if v_row.head_hash <> p_prev_head or v_row.event_count <> (p_new_count - 1) then
    return jsonb_build_object(
      'ok',       false,
      'error',    'desync',
      'head',     v_row.head_hash,
      'count',    v_row.event_count,
      'cdx_hash', v_row.cdx_hash
    );
  end if;

  update sad_ledger_stub
     set head_hash   = p_new_head,
         event_count = p_new_count,
         cdx_hash    = p_cdx_hash,
         updated_at  = now()
   where code_hash = v_hash and chain_nonce = p_chain_nonce;

  return jsonb_build_object(
    'ok',       true,
    'head',     p_new_head,
    'count',    p_new_count,
    'cdx_hash', p_cdx_hash
  );
end;
$$;

revoke execute on function sad_advance(text, text, text, text, bigint, text) from public;
grant  execute on function sad_advance(text, text, text, text, bigint, text) to service_role;

-- ============================================================================
-- 5. SAD_FORCE_ADVANCE
--    Re-establish provenance. Bypasses CAS, costs a flat 3-scrape provenance
--    tax (charged by the Edge Function via burn_code BEFORE this call).
--    Used to recover from local-data loss or to override a parallel chain
--    you already control. Cannot be used to take over a chain you don't have
--    the chain_nonce for (because the routing key is part of the request).
-- ============================================================================
drop function if exists sad_force_advance(text, text, bigint);
drop function if exists sad_force_advance(text, text, text, bigint, text);
create function sad_force_advance(
  p_anchor_code text,
  p_chain_nonce text,
  p_new_head    text,
  p_new_count   bigint,
  p_cdx_hash    text
) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
begin
  v_hash := sad_code_hash(p_anchor_code);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;
  if p_chain_nonce is null or length(p_chain_nonce) <> 32 or p_chain_nonce !~ '^[0-9a-f]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_chain_nonce');
  end if;

  insert into sad_ledger_stub (code_hash, chain_nonce, head_hash, event_count, cdx_hash)
  values (v_hash, p_chain_nonce, p_new_head, p_new_count, p_cdx_hash)
  on conflict (code_hash, chain_nonce) do update
    set head_hash   = excluded.head_hash,
        event_count = excluded.event_count,
        cdx_hash    = excluded.cdx_hash,
        updated_at  = now();

  return jsonb_build_object(
    'ok',       true,
    'head',     p_new_head,
    'count',    p_new_count,
    'cdx_hash', p_cdx_hash
  );
end;
$$;

revoke execute on function sad_force_advance(text, text, text, bigint, text) from public;
grant  execute on function sad_force_advance(text, text, text, bigint, text) to service_role;

-- ============================================================================
-- 6. BURN_CODE
--    Pure balance decrement, no queue side-effects. The Edge Function passes
--    the ACTIVE code (not the anchor) — the player burns scrapes from
--    whichever code currently sits at the top of their codex.
-- ============================================================================
create or replace function burn_code(p_code text, p_amount int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_code_canon text;
  v_row codes;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;
  if p_amount > 100 then
    return jsonb_build_object('ok', false, 'error', 'amount_too_large');
  end if;

  v_code_canon := dm_canonicalize_code(p_code);
  if v_code_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  select * into v_row from codes where code = v_code_canon for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if v_row.balance < p_amount then
    return jsonb_build_object(
      'ok', false, 'error', 'insufficient',
      'remaining', v_row.balance, 'required', p_amount
    );
  end if;

  update codes
     set balance      = balance - p_amount,
         use_count    = use_count + p_amount,
         last_used_at = now()
   where code = v_code_canon;

  return jsonb_build_object(
    'ok',        true,
    'remaining', v_row.balance - p_amount,
    'tier',      dm_code_tier(v_code_canon)
  );
end;
$$;

revoke execute on function burn_code(text, int) from public;
grant  execute on function burn_code(text, int) to service_role;

-- ============================================================================
-- 7. CREDIT_CODE
--    Inverse of burn_code. Used to refund a charge when chain advance fails
--    after burn already succeeded.
-- ============================================================================
create or replace function credit_code(p_code text, p_amount int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_code_canon text;
  v_row codes;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;
  if p_amount > 100 then
    return jsonb_build_object('ok', false, 'error', 'amount_too_large');
  end if;

  v_code_canon := dm_canonicalize_code(p_code);
  if v_code_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  select * into v_row from codes where code = v_code_canon for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  update codes
     set balance   = balance + p_amount,
         use_count = greatest(0, use_count - p_amount)
   where code = v_code_canon;

  return jsonb_build_object(
    'ok',        true,
    'remaining', v_row.balance + p_amount
  );
end;
$$;

revoke execute on function credit_code(text, int) from public;
grant  execute on function credit_code(text, int) to service_role;

-- ============================================================================
-- END OF SAD LAYER (v0.3a)
-- ----------------------------------------------------------------------------
-- Deploy steps:
--   1. Run this file in the Supabase SQL editor (idempotent).
--   2. Re-deploy the sad_advance Edge Function:
--        npx supabase functions deploy sad_advance --no-verify-jwt
--   3. Hard-refresh bureau.html. Existing players bootstrap their codex
--      from their stored code on first visit; legacy chains use the
--      sentinel chain_nonce (zero string) so no migration disruption.
-- ============================================================================
