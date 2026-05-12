-- ============================================================================
-- TELEMETRY TRENCH  //  Drift integration  (ASC v0.2, prefix TRN)
-- ----------------------------------------------------------------------------
-- Run AFTER codes.sql in the drift Supabase project. Adds:
--   - trench_runs              run input + output + audit_status
--   - trench_terminated_pool   final boards of dead operators (R4+ kills)
--   - trench_start_run         (anon) validates a TRN code, returns a run_id
--   - trench_complete_run      (anon) decrements code, stores result
--   - trench_pull_ghost        (anon) random terminated entry near a round
--
-- ASC role: TRN is a Layer-2 stateful prefix. The Layer-1 hash (tier, hidden)
-- is honoured by trench_practice.html for cosmetic flavour but the run gate
-- is purely Layer 2 (balance > 0 ∧ not expired).
--
-- Acurast role: this file does NOT execute the combat engine. The client
-- (trench_practice.html) simulates locally; this table stores the inputs
-- + outputs verbatim. An Acurast worker (acurast/trench-verifier/) runs
-- the same simulate() against those inputs on TEE hardware and stamps
-- audit_status. Mismatches are flagged for operator review.
--
-- Phantom-discipline: rows emit raw observations only. No "intent" or
-- "skill score" fields. Phantom shapes downstream.
--
-- Authority: ASC_SPEC.md  §3 Prefix registry  (TRN entry)
--            HANDOFF.md   §Trench
--            TRENCH_DEPLOY.md
-- ============================================================================

-- ============================================================================
-- 1. EXTEND mint_code() prefix awareness
--    The root codes.sql mint_code() function already exists; we re-declare it
--    here with the TRN prefix added. This is idempotent — CREATE OR REPLACE
--    preserves the function signature.
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

  v_category := case v_prefix
    when 'DRF' then 'driftmetrics'
    when 'ASL' then 'universal'
    when 'EVT' then 'event'
    when 'PRO' then 'pack'
    when 'SCH' then 'schema'
    when 'ARC' then 'archive'
    when 'ESO' then 'esoterica'
    when 'PCK' then 'underground_pack'
    when 'RAD' then 'raid_pool'
    when 'TRN' then 'trench_submission'
    else            'unknown'
  end;

  v_balance := coalesce(p_balance, case v_prefix
    when 'DRF' then 10
    when 'ASL' then 10
    when 'EVT' then 5
    when 'PRO' then 30
    when 'TRN' then 1                -- one run per TRN code by default
    else 0
  end);

  v_expires := case
    when p_expires_in is not null then now() + p_expires_in
    when v_prefix = 'EVT' then now() + interval '30 days'
    when v_prefix = 'TRN' then now() + interval '30 days'
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
-- 2. TABLES
-- ----------------------------------------------------------------------------
-- trench_runs is the canonical record. Every Bureau-mode submission lands
-- here. Inputs are stored verbatim (boards, seed, drift_score, round) so the
-- Acurast verifier can re-simulate. Outputs are stored as a summary plus the
-- full tick_log JSON for debugging.
--
-- audit_status state machine:
--   'pending'   — written by client; not yet audited
--   'verified'  — Acurast verifier re-ran with same inputs and got byte-exact match
--   'mismatch'  — Acurast verifier got a different result; operator must investigate
--   'stale'     — older than 30 days; verifier skips
-- ============================================================================
create table if not exists trench_runs (
  run_id            uuid primary key default gen_random_uuid(),
  code              text not null references codes(code),
  started_at        timestamptz not null default now(),
  completed_at      timestamptz,

  -- inputs (frozen at start_run time so verifier sees what client saw)
  seed              text,
  drift_score       numeric(4,3),
  round_number      int,
  player_board      jsonb not null default '[]'::jsonb,
  ghost_board       jsonb not null default '[]'::jsonb,
  ghost_source      text,                       -- 'synthetic_aggressive' | 'pool:<run_id>' | ...
  player_starting_state jsonb,                  -- {phantom_pool, lane_integrity}

  -- outputs (set on complete)
  winner            text,                       -- 'player' | 'ghost' | 'draw'
  final_state       jsonb,                      -- {player:{...}, ghost:{...}}
  terminated        boolean not null default false,  -- player died on R4+
  damage_summary    jsonb,                      -- {player_dealt, ghost_dealt, ticks_played}
  engine_version    text,

  -- audit
  audit_status      text not null default 'pending',
  audit_at          timestamptz,
  audit_worker_id   text,
  audit_notes       text,

  -- housekeeping
  ip_hash           text,                       -- sha256 of IP for soft rate limiting; never raw IP
  user_agent        text                        -- coarse, truncated server-side
);

create index if not exists idx_trench_runs_code         on trench_runs(code);
create index if not exists idx_trench_runs_audit_status on trench_runs(audit_status)
  where audit_status = 'pending';
create index if not exists idx_trench_runs_started_at   on trench_runs(started_at desc);
create index if not exists idx_trench_runs_terminated   on trench_runs(terminated)
  where terminated = true;

-- ----------------------------------------------------------------------------
-- trench_terminated_pool: the final boards of operators who died on R4+.
-- These become opposition layouts for future runs. Single source of "ghost"
-- content beyond the synthetic library.
--
-- The pool is keyed by round_number — clients pull boards near their own
-- round to keep difficulty in band. A board may appear in many runs as
-- opposition; we don't track that here (Phantom can if it wants to).
-- ----------------------------------------------------------------------------
create table if not exists trench_terminated_pool (
  pool_id           uuid primary key default gen_random_uuid(),
  source_run_id     uuid references trench_runs(run_id),
  round_number      int not null,
  board             jsonb not null,             -- [{item_id, lane, tick}, ...]
  drift_score       numeric(4,3),               -- the drift score the operator died at
  added_at          timestamptz not null default now(),
  draws             int not null default 0      -- bump when used as a ghost
);

create index if not exists idx_trench_pool_round on trench_terminated_pool(round_number);
create index if not exists idx_trench_pool_added on trench_terminated_pool(added_at desc);

-- ============================================================================
-- 2b. trench_peek_code RPC
-- ----------------------------------------------------------------------------
-- Anon-callable, side-effect-free. Used by the Bureau UI to validate a code
-- AS THE OPERATOR TYPES, without inserting a trench_runs row. Returns the
-- same shape as start_run minus run_id+seed.
--
-- Discloses balance & expiry; does not disclose internal notes.
-- ============================================================================
create or replace function trench_peek_code(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_canon  text;
  v_prefix text;
  v_row    codes;
begin
  v_canon := dm_canonicalize_code(p_code);
  if v_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;
  v_prefix := dm_code_prefix(v_canon);
  if v_prefix is null or v_prefix <> 'TRN' then
    return jsonb_build_object('ok', false, 'error', 'wrong_prefix',
                              'prefix', v_prefix);
  end if;

  select * into v_row from codes where code = v_canon;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_row.balance <= 0 then
    return jsonb_build_object('ok', false, 'error', 'depleted',
                              'tier', dm_code_tier(v_canon));
  end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired',
                              'expired_at', v_row.expires_at);
  end if;

  return jsonb_build_object(
    'ok',         true,
    'code',       v_canon,
    'balance',    v_row.balance,
    'tier',       dm_code_tier(v_canon),
    'hidden',     dm_code_is_bonus(v_canon),
    'expires_at', v_row.expires_at,
    'category',   v_row.category
  );
end;
$$;

-- ============================================================================
-- 3. trench_start_run RPC
-- ----------------------------------------------------------------------------
-- Anon-callable. Validates the TRN code (balance > 0, not expired), stamps a
-- new trench_runs row in 'pending' state, returns the run_id + frozen inputs.
--
-- Does NOT decrement balance. The code stays valid until complete_run is
-- called. A run can be abandoned safely (the row will simply have
-- completed_at = null forever; sweeper can prune).
--
-- Soft rate limit: max 1 active (not-yet-completed) run per code at a time.
-- ============================================================================
create or replace function trench_start_run(
  p_code            text,
  p_round           int     default 1,
  p_drift_score     numeric default 0.5,
  p_player_board    jsonb   default '[]'::jsonb,
  p_ghost_board     jsonb   default '[]'::jsonb,
  p_ghost_source    text    default 'synthetic_aggressive',
  p_player_state    jsonb   default null,
  p_seed            text    default null,
  p_user_agent      text    default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_code_canon text;
  v_prefix     text;
  v_row codes;
  v_active_count int;
  v_run_id uuid;
  v_seed text;
begin
  v_code_canon := dm_canonicalize_code(p_code);
  if v_code_canon is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_format');
  end if;

  v_prefix := dm_code_prefix(v_code_canon);
  if v_prefix is null or v_prefix <> 'TRN' then
    return jsonb_build_object('ok', false, 'error', 'wrong_prefix',
                              'detail', 'trench requires TRN prefix; got ' || coalesce(v_prefix, 'null'));
  end if;

  select * into v_row from codes where code = v_code_canon for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_row.balance <= 0 then
    return jsonb_build_object('ok', false, 'error', 'depleted');
  end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- Soft rate: at most one active (incomplete) run per code.
  select count(*) into v_active_count
    from trench_runs
   where code = v_code_canon
     and completed_at is null
     and started_at > now() - interval '15 minutes';
  if v_active_count >= 1 then
    return jsonb_build_object('ok', false, 'error', 'active_run_exists',
                              'detail', 'another run is in progress for this code; wait or complete it first');
  end if;

  -- Seed: client may provide one (deterministic re-run / shared seeds), or we
  -- generate one server-side. Server-side seeds are preferred for trust.
  v_seed := coalesce(p_seed, encode(gen_random_bytes(32), 'hex'));

  insert into trench_runs (
    code, seed, drift_score, round_number,
    player_board, ghost_board, ghost_source, player_starting_state,
    user_agent
  ) values (
    v_code_canon, v_seed, p_drift_score, greatest(1, coalesce(p_round, 1)),
    coalesce(p_player_board, '[]'::jsonb),
    coalesce(p_ghost_board, '[]'::jsonb),
    p_ghost_source,
    p_player_state,
    left(coalesce(p_user_agent, ''), 200)
  ) returning run_id into v_run_id;

  return jsonb_build_object(
    'ok',           true,
    'run_id',       v_run_id,
    'seed',         v_seed,
    'tier',         dm_code_tier(v_code_canon),
    'hidden',       dm_code_is_bonus(v_code_canon),
    'balance_before', v_row.balance,
    'expires_at',   v_row.expires_at
  );
end;
$$;

-- ============================================================================
-- 4. trench_complete_run RPC
-- ----------------------------------------------------------------------------
-- Anon-callable. Records the outcome of a run and decrements the code.
--
-- Idempotency: if completed_at is already set, returns ok=false with
-- 'already_completed'. Does NOT double-burn the code. Replay-safe.
--
-- Terminated pool insertion: if terminated=true AND round_number >= 4 AND
-- player_board is non-empty, also insert into trench_terminated_pool. The
-- caller signals terminated; we don't infer (avoids subtle disagreements
-- with the client's run_terminated state machine).
-- ============================================================================
create or replace function trench_complete_run(
  p_run_id          uuid,
  p_winner          text,
  p_final_state     jsonb,
  p_damage_summary  jsonb default null,
  p_terminated      boolean default false,
  p_engine_version  text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_run trench_runs;
  v_code codes;
  v_added_to_pool boolean := false;
begin
  if p_run_id is null then
    return jsonb_build_object('ok', false, 'error', 'missing_run_id');
  end if;
  if p_winner not in ('player', 'ghost', 'draw') then
    return jsonb_build_object('ok', false, 'error', 'invalid_winner',
                              'detail', 'expected player|ghost|draw, got ' || coalesce(p_winner, 'null'));
  end if;

  select * into v_run from trench_runs where run_id = p_run_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'run_not_found');
  end if;
  if v_run.completed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_completed',
                              'completed_at', v_run.completed_at,
                              'winner',       v_run.winner);
  end if;

  -- Decrement code balance. Failure to do so is non-fatal (we still record
  -- the outcome), but we log it.
  select * into v_code from codes where code = v_run.code for update;
  if found and v_code.balance > 0 then
    update codes
       set balance      = balance - 1,
           use_count    = use_count + 1,
           last_used_at = now()
     where code = v_run.code;
  end if;

  -- Stamp the run.
  update trench_runs
     set completed_at    = now(),
         winner          = p_winner,
         final_state     = p_final_state,
         damage_summary  = p_damage_summary,
         terminated      = coalesce(p_terminated, false),
         engine_version  = p_engine_version
   where run_id = p_run_id;

  -- Terminated pool insertion. Only R4+ deaths count (matches client's
  -- run_terminated rule in trench_practice.html:applyResultToRun).
  if coalesce(p_terminated, false)
     and v_run.round_number >= 4
     and jsonb_array_length(coalesce(v_run.player_board, '[]'::jsonb)) > 0 then
    insert into trench_terminated_pool (
      source_run_id, round_number, board, drift_score
    ) values (
      p_run_id, v_run.round_number, v_run.player_board, v_run.drift_score
    );
    v_added_to_pool := true;
  end if;

  return jsonb_build_object(
    'ok',                 true,
    'run_id',             p_run_id,
    'balance_after',      coalesce(v_code.balance - 1, 0),
    'added_to_pool',      v_added_to_pool,
    'audit_status',       'pending'
  );
end;
$$;

-- ============================================================================
-- 5. trench_pull_ghost RPC
-- ----------------------------------------------------------------------------
-- Anon-callable. Returns a random terminated_pool board near a given round.
-- The "near" window expands if exact-match returns nothing: round_number =
-- p_round, then ±1, then ±2.
--
-- Returns the board only — NOT the source run_id or contributing operator
-- info. The opposition is anonymous by design.
--
-- Bumps the `draws` counter so we can see which boards are circulating.
-- ============================================================================
create or replace function trench_pull_ghost(
  p_round int default 1
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row trench_terminated_pool;
  v_window int := 0;
begin
  loop
    -- Try exact then ±window.
    select * into v_row
      from trench_terminated_pool
     where round_number between (p_round - v_window) and (p_round + v_window)
     order by random()
     limit 1;
    if found then exit; end if;
    v_window := v_window + 1;
    if v_window > 2 then exit; end if;
  end loop;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'pool_empty');
  end if;

  update trench_terminated_pool
     set draws = draws + 1
   where pool_id = v_row.pool_id;

  return jsonb_build_object(
    'ok',           true,
    'board',        v_row.board,
    'round_number', v_row.round_number,
    'drift_score',  v_row.drift_score,
    'ghost_source', 'pool:' || v_row.pool_id::text
  );
end;
$$;

-- ============================================================================
-- 6. Acurast verifier-facing helpers (service_role only)
-- ----------------------------------------------------------------------------
-- The verifier worker pulls a batch of pending runs, re-simulates, then
-- stamps audit_status. These functions are service-role-only.
-- ============================================================================
create or replace function trench_claim_audit_batch(
  p_limit int default 10,
  p_worker_id text default null
) returns setof trench_runs
language sql security definer set search_path = public, pg_temp
as $$
  update trench_runs
     set audit_status    = 'auditing',
         audit_worker_id = coalesce(p_worker_id, 'unknown'),
         audit_at        = now()
   where run_id in (
     select run_id from trench_runs
      where audit_status = 'pending'
        and completed_at is not null
        and started_at > now() - interval '30 days'
      order by completed_at asc
      limit greatest(1, p_limit)
      for update skip locked
   )
   returning *;
$$;

create or replace function trench_finish_audit(
  p_run_id uuid,
  p_status text,                -- 'verified' | 'mismatch' | 'error'
  p_notes  text default null
) returns void
language sql security definer set search_path = public, pg_temp
as $$
  update trench_runs
     set audit_status = p_status,
         audit_at     = now(),
         audit_notes  = p_notes
   where run_id = p_run_id;
$$;

-- ============================================================================
-- 7. RLS
-- ----------------------------------------------------------------------------
-- Both tables get RLS on. Anon has no direct table access; all writes go
-- through the security-definer RPCs above. Service role bypasses.
--
-- For READ access from the ops console: service-role calls aren't subject to
-- RLS, so the console can list rows freely with its service key. We do NOT
-- grant anon SELECT — there's no public board browser at this time.
-- ============================================================================
alter table trench_runs            enable row level security;
alter table trench_terminated_pool enable row level security;

-- (no policies = nothing visible to anon/authenticated; service_role bypasses RLS)

-- ============================================================================
-- 8. PERMISSIONS
-- ============================================================================
revoke execute on function trench_peek_code(text) from public;
grant  execute on function trench_peek_code(text) to anon;
grant  execute on function trench_peek_code(text) to authenticated;
grant  execute on function trench_peek_code(text) to service_role;

revoke execute on function trench_start_run(text, int, numeric, jsonb, jsonb, text, jsonb, text, text) from public;
grant  execute on function trench_start_run(text, int, numeric, jsonb, jsonb, text, jsonb, text, text) to anon;
grant  execute on function trench_start_run(text, int, numeric, jsonb, jsonb, text, jsonb, text, text) to authenticated;
grant  execute on function trench_start_run(text, int, numeric, jsonb, jsonb, text, jsonb, text, text) to service_role;

revoke execute on function trench_complete_run(uuid, text, jsonb, jsonb, boolean, text) from public;
grant  execute on function trench_complete_run(uuid, text, jsonb, jsonb, boolean, text) to anon;
grant  execute on function trench_complete_run(uuid, text, jsonb, jsonb, boolean, text) to authenticated;
grant  execute on function trench_complete_run(uuid, text, jsonb, jsonb, boolean, text) to service_role;

revoke execute on function trench_pull_ghost(int) from public;
grant  execute on function trench_pull_ghost(int) to anon;
grant  execute on function trench_pull_ghost(int) to authenticated;
grant  execute on function trench_pull_ghost(int) to service_role;

revoke execute on function trench_claim_audit_batch(int, text) from public;
grant  execute on function trench_claim_audit_batch(int, text) to service_role;

revoke execute on function trench_finish_audit(uuid, text, text) from public;
grant  execute on function trench_finish_audit(uuid, text, text) to service_role;

-- ============================================================================
-- 9. SMOKE
-- ============================================================================
-- Verify the basic plumbing without minting a code. Should print 3 rows:
--   trench_runs            : table exists
--   trench_terminated_pool : table exists
--   trench_start_run       : function exists
-- ----------------------------------------------------------------------------
do $$ begin
  perform 1 from information_schema.tables where table_name = 'trench_runs';
  if not found then raise exception 'trench_runs missing after install'; end if;
  perform 1 from information_schema.tables where table_name = 'trench_terminated_pool';
  if not found then raise exception 'trench_terminated_pool missing after install'; end if;
  perform 1 from information_schema.routines where routine_name = 'trench_start_run';
  if not found then raise exception 'trench_start_run missing after install'; end if;
  raise notice 'trench.sql installed cleanly';
end $$;
