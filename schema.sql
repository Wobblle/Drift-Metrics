-- ============================================================================
-- DriftMetrics  //  Step 3 — Schema, Triggers, RPCs, RLS
-- ----------------------------------------------------------------------------
-- Run this file from the Supabase SQL editor (Dashboard → SQL Editor → New).
-- Idempotent where possible; safe to re-run.
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto; Supabase ships with it but enable in case
create extension if not exists pgcrypto;

-- ============================================================================
-- 0. ENUM
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type job_status as enum (
      'pending',        -- waiting for a worker
      'processing',     -- claimed by a worker
      'done',           -- report posted (rare; row is usually deleted)
      'shadowbanned',   -- silently dropped by trigger; worker NEVER sees it
      'failed'          -- siphon.py errored or timed out
    );
  end if;
end $$;

-- ============================================================================
-- 1. TABLES
-- ============================================================================
create table if not exists query_queue (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null,                 -- frontend-generated correlation id
  keyword      text not null,
  status       job_status not null default 'pending',
  ip_address   text,                          -- set by trigger; never null for inserts
  honeypot     text,                          -- hidden form field; bots fill it
  user_agent   text,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  claimed_by   text
);

create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null,                 -- matches query_queue.request_id
  keyword      text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);

-- ============================================================================
-- 2. INDEXES
-- ============================================================================
-- Workers poll for the oldest pending row
create index if not exists idx_qq_pending      on query_queue(created_at)
  where status = 'pending';
-- Trigger does per-IP rate counts
create index if not exists idx_qq_ip_time      on query_queue(ip_address, created_at);
-- Stale-job sweeper finds long-running 'processing' rows
create index if not exists idx_qq_processing   on query_queue(claimed_at)
  where status = 'processing';
-- Frontend polls reports by request_id
create index if not exists idx_rep_request     on reports(request_id);
-- Cache lookup by keyword
create index if not exists idx_rep_keyword_t   on reports(keyword, created_at desc);

-- ============================================================================
-- 3. CLIENT-IP HELPER
--    Wraps current_setting('request.headers') safely. PostgREST sets this
--    per-request as the JSON of incoming HTTP headers. The first IP in
--    x-forwarded-for is the original client (after Supabase's edge proxy).
-- ============================================================================
create or replace function dm_client_ip() returns text
language plpgsql stable
as $$
declare
  raw text;
  xff text;
  ip  text;
begin
  raw := current_setting('request.headers', true);
  if raw is null or raw = '' then
    return '0.0.0.0';
  end if;
  begin
    xff := raw::json ->> 'x-forwarded-for';
  exception when others then
    return '0.0.0.0';
  end;
  ip := nullif(trim(split_part(coalesce(xff, ''), ',', 1)), '');
  return coalesce(ip, '0.0.0.0');
end;
$$;

-- ============================================================================
-- 4. SHADOWBAN TRIGGER
--    BEFORE INSERT on query_queue. Decides whether the new row will be
--    'pending' (workers see it) or 'shadowbanned' (workers never see it).
--    Either way the INSERT succeeds → spammer gets HTTP 201 either way.
--
--    SECURITY DEFINER + explicit search_path so the trigger can read other
--    rows in query_queue regardless of the caller's RLS context.
-- ============================================================================
create or replace function shadowban_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ip      text;
  v_recent  int;
  v_daily   int;
  v_global  int;
begin
  -- Always set IP server-side. Don't trust whatever the client put in the row.
  v_ip := dm_client_ip();
  new.ip_address := v_ip;

  -- Normalize keyword so cache + dedup are consistent across clients.
  new.keyword := lower(trim(coalesce(new.keyword, '')));

  -- Gate 1: keyword shape. Silent. Never tell the client what's wrong.
  if length(new.keyword) < 2 or length(new.keyword) > 128 then
    new.status := 'shadowbanned';
    return new;
  end if;

  -- Gate 2: honeypot. Real frontend always sends '' (empty string).
  -- Naive bots that scrape forms will fill the hidden field.
  if new.honeypot is not null and length(new.honeypot) > 0 then
    new.status := 'shadowbanned';
    return new;
  end if;

  -- Gate 3 (PRIMARY): per-IP rolling 10-minute cap.
  --   > 3 inserts in 10min from the same IP → silent drop.
  select count(*) into v_recent
  from query_queue
  where ip_address = v_ip
    and created_at > now() - interval '10 minutes';
  if v_recent > 3 then
    new.status := 'shadowbanned';
    return new;
  end if;

  -- Gate 4: per-IP daily hard cap (defense in depth).
  --   > 50 inserts in 24h from the same IP → silent drop.
  select count(*) into v_daily
  from query_queue
  where ip_address = v_ip
    and created_at > now() - interval '24 hours';
  if v_daily > 50 then
    new.status := 'shadowbanned';
    return new;
  end if;

  -- Gate 5 (SECONDARY): global pending backpressure.
  --   If the queue is already deep, drop new entrants silently.
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

drop trigger if exists trg_shadowban_check on query_queue;
create trigger trg_shadowban_check
  before insert on query_queue
  for each row execute function shadowban_check();

-- ============================================================================
-- 5. CLAIM-NEXT-JOB RPC
--    Workers POST /rest/v1/rpc/claim_next_job with their worker_id.
--    Uses FOR UPDATE SKIP LOCKED so two workers can never claim the same row.
--    Returns the row, or NULL fields if no work available.
-- ============================================================================
create or replace function claim_next_job(p_worker_id text)
returns query_queue
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  job query_queue;
begin
  update query_queue q
     set status     = 'processing',
         claimed_by = p_worker_id,
         claimed_at = now()
   where q.id = (
     select id from query_queue
      where status = 'pending'
      order by created_at asc
      limit 1
      for update skip locked
   )
   returning q.* into job;
  return job;
end;
$$;

-- ============================================================================
-- 6. STALE-JOB SWEEPER
--    If a worker dies between claim and report-post, the row is stuck in
--    'processing' forever. Run this every couple minutes via pg_cron.
-- ============================================================================
create or replace function requeue_stale_jobs() returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  update query_queue
     set status     = 'pending',
         claimed_at = null,
         claimed_by = null
   where status = 'processing'
     and claimed_at < now() - interval '5 minutes';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ============================================================================
-- 7. TTL CLEANUP
--    Keep the DB near zero on the free tier. Reports expire after 24h;
--    terminal queue rows (done/failed/shadowbanned) after 1h.
-- ============================================================================
create or replace function cleanup_old_data() returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from reports     where created_at < now() - interval '24 hours';
  delete from query_queue where status in ('done','failed','shadowbanned')
                            and created_at < now() - interval '1 hour';
end;
$$;

-- ============================================================================
-- 8. ROW-LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- anon:
--   * INSERT into query_queue (silently shadowbanned if abusive)
--   * SELECT from reports (polling for results)
--   * NO SELECT on query_queue (cannot inspect own status — silence is the point)
--   * NO UPDATE / DELETE anywhere
-- service_role (workers):
--   * Full access; bypasses RLS by default.
-- ============================================================================
alter table query_queue enable row level security;
alter table reports     enable row level security;

drop policy if exists anon_insert_queue on query_queue;
create policy anon_insert_queue on query_queue
  for insert to anon with check (true);

drop policy if exists anon_select_reports on reports;
create policy anon_select_reports on reports
  for select to anon using (true);

-- Lock down RPCs. The default in Postgres is EXECUTE granted to PUBLIC; revoke.
revoke execute on function claim_next_job(text)    from public;
revoke execute on function requeue_stale_jobs()    from public;
revoke execute on function cleanup_old_data()      from public;
grant  execute on function claim_next_job(text)    to service_role;
grant  execute on function requeue_stale_jobs()    to service_role;
grant  execute on function cleanup_old_data()      to service_role;

-- dm_client_ip is read by the trigger (which runs as definer); no client need.
revoke execute on function dm_client_ip() from public;

-- ============================================================================
-- 9. OPTIONAL: pg_cron schedules
-- ----------------------------------------------------------------------------
-- Enable pg_cron once: Dashboard → Database → Extensions → pg_cron → Enable.
-- Then run the two SELECTs below in the SQL editor (one-time setup).
-- ============================================================================
-- select cron.schedule('dm_requeue_stale', '*/2 * * * *',
--   $$ select requeue_stale_jobs(); $$);
-- select cron.schedule('dm_cleanup',       '*/5 * * * *',
--   $$ select cleanup_old_data();   $$);
