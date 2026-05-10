-- ============================================================================
-- DriftMetrics // SAD Ledger Stub (Bureau game layer)
-- ----------------------------------------------------------------------------
-- The Social Ledger Stub. Server-side notary record for the Bureau layer.
-- We do NOT store the body of any player's archive. Only:
--   * a SHA-256 of the code (decouples this table from the codes table)
--   * the current head hash of the player's local hash-chained log
--   * the count of events the chain claims to contain
--   * timestamps for last update
--
-- The body of the archive lives in the player's localStorage. The Stub
-- exists solely so the network can refuse to advance a chain that doesn't
-- match what was last committed (CAS on prev_head), and so a stolen code
-- holder must explicitly pay to re-establish provenance.
--
-- Run AFTER schema.sql and codes.sql. Idempotent.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- 1. STUB TABLE
-- ============================================================================
create table if not exists sad_ledger_stub (
  code_hash    text primary key,           -- sha256(canonical_code), 64 hex chars
  head_hash    text not null,              -- 64 hex chars, the current chain head
  event_count  bigint not null default 0,  -- monotonic, matches client n
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_sad_stub_updated on sad_ledger_stub(updated_at desc);

alter table sad_ledger_stub enable row level security;
-- (No policies. Locked except for service_role bypass. Reads go through
--  sad_peek() which is anon-callable and only exposes head + count.)

-- ============================================================================
-- 2. CODE -> CODE_HASH HELPER
--    Centralizes the canonicalization + hashing so client and server stay
--    in lockstep. Pure: safe to grant to anon for debugging.
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
--    Read-only lookup. A freshly-arrived device calls this to find out
--    whether a code already has a chain on the network and at what state.
--    Returns:
--      { ok: true,  exists: bool,  head: hex64,  count: int }   on success
--      { ok: false, error: string }                              on bad input
--    For a code with no Stub row, exists=false, head=zero64, count=0.
-- ============================================================================
create or replace function sad_peek(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_row sad_ledger_stub;
  v_zero text := repeat('0', 64);
begin
  v_hash := sad_code_hash(p_code);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  select * into v_row from sad_ledger_stub where code_hash = v_hash;
  if not found then
    return jsonb_build_object(
      'ok',     true,
      'exists', false,
      'head',   v_zero,
      'count',  0
    );
  end if;

  return jsonb_build_object(
    'ok',     true,
    'exists', true,
    'head',   v_row.head_hash,
    'count',  v_row.event_count
  );
end;
$$;

revoke execute on function sad_peek(text) from public;
grant  execute on function sad_peek(text) to anon;
grant  execute on function sad_peek(text) to authenticated;
grant  execute on function sad_peek(text) to service_role;

-- ============================================================================
-- 4. SAD_ADVANCE
--    CAS-update of the Stub. Genesis is the case where no row exists; we
--    accept it only when prev_head is all zeros and new_count is 1. For
--    existing rows we require:
--      stored.head_hash  == p_prev_head
--      stored.event_count == p_new_count - 1
--    Service-role only — only the sad_advance Edge Function calls this,
--    after it has validated the code and (optionally) burned scrapes.
--
--    Returns:
--      { ok: true,  head: hex64, count: int }                        on success
--      { ok: false, error: 'desync', head: server_head, count: ... } on conflict
--      { ok: false, error: string }                                  on bad input
-- ============================================================================
create or replace function sad_advance(
  p_code      text,
  p_prev_head text,
  p_new_head  text,
  p_new_count bigint
) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_row sad_ledger_stub;
  v_zero text := repeat('0', 64);
begin
  v_hash := sad_code_hash(p_code);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  select * into v_row from sad_ledger_stub
   where code_hash = v_hash
   for update;

  if not found then
    -- Genesis. prev_head must be zero64, new_count must be 1.
    if p_prev_head <> v_zero then
      return jsonb_build_object(
        'ok',     false,
        'error',  'desync',
        'head',   v_zero,
        'count',  0
      );
    end if;
    if p_new_count <> 1 then
      return jsonb_build_object('ok', false, 'error', 'invalid_genesis_count');
    end if;
    insert into sad_ledger_stub (code_hash, head_hash, event_count)
    values (v_hash, p_new_head, p_new_count);
    return jsonb_build_object('ok', true, 'head', p_new_head, 'count', p_new_count);
  end if;

  -- Existing chain. CAS check.
  if v_row.head_hash <> p_prev_head or v_row.event_count <> (p_new_count - 1) then
    return jsonb_build_object(
      'ok',     false,
      'error',  'desync',
      'head',   v_row.head_hash,
      'count',  v_row.event_count
    );
  end if;

  update sad_ledger_stub
     set head_hash   = p_new_head,
         event_count = p_new_count,
         updated_at  = now()
   where code_hash = v_hash;

  return jsonb_build_object('ok', true, 'head', p_new_head, 'count', p_new_count);
end;
$$;

revoke execute on function sad_advance(text, text, text, bigint) from public;
grant  execute on function sad_advance(text, text, text, bigint) to service_role;

-- ============================================================================
-- 5. SAD_FORCE_ADVANCE
--    Re-establish provenance. Bypasses CAS. The Edge Function is responsible
--    for charging the flat 3-scrape provenance tax via burn_code() before
--    calling this. Used in two cases:
--      * Theft: someone else holds the code and wants to claim the chain
--      * Self-recovery: original holder lost their localStorage and wants to
--        reset their chain back to whatever they have locally
--    The original holder, if they ever come back, sees the chain has been
--    overwritten and is themselves desynced — symmetric by design.
-- ============================================================================
create or replace function sad_force_advance(
  p_code      text,
  p_new_head  text,
  p_new_count bigint
) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
begin
  v_hash := sad_code_hash(p_code);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  insert into sad_ledger_stub (code_hash, head_hash, event_count)
  values (v_hash, p_new_head, p_new_count)
  on conflict (code_hash) do update
    set head_hash   = excluded.head_hash,
        event_count = excluded.event_count,
        updated_at  = now();

  return jsonb_build_object('ok', true, 'head', p_new_head, 'count', p_new_count);
end;
$$;

revoke execute on function sad_force_advance(text, text, bigint) from public;
grant  execute on function sad_force_advance(text, text, bigint) to service_role;

-- ============================================================================
-- 6. BURN_CODE
--    Pure balance decrement, no queue side-effects. Used by the Bureau Edge
--    Function to charge scrapes for in-game actions (force-overwrite, future
--    DEEP-FILE, future DISPATCH) without enqueueing a scan.
--
--    Caps amount at 100 to bound mistakes. Atomic: row-locked via FOR UPDATE.
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
-- END OF SAD LAYER
-- ----------------------------------------------------------------------------
-- Deploy steps:
--   1. Run this file in the Supabase SQL editor (idempotent).
--   2. Deploy the sad_advance Edge Function:
--        npx supabase functions deploy sad_advance --no-verify-jwt
--   3. Mint a code via mint_code() if you don't have one already.
--   4. Open bureau.html, paste the code, file something.
-- ============================================================================
