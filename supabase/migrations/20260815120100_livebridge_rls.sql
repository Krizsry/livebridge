-- =============================================================================
-- Live Bridge - Row Level Security
-- =============================================================================
-- Requirement 17 / project rule 26: RLS is enabled on EVERY table, as defence
-- in depth, even though all access is backend-only.
--
-- THE MODEL, stated plainly:
--
--   * The backend connects with the SERVICE ROLE key. That role has BYPASSRLS,
--     so it reads and writes everything regardless of the policies below.
--     This is Supabase's documented behaviour, not a workaround.
--
--   * The `anon` and `authenticated` roles get NO policies at all. With RLS
--     enabled and zero permissive policies, Postgres denies every row to those
--     roles. So even if the anon key leaked, or someone pointed a supabase-js
--     client at this project, every query returns zero rows and every write is
--     rejected.
--
--   * That "deny by default" is the entire point. There is no user-level auth in
--     Live Bridge (requirement 12), so there is no principal these tables could
--     meaningfully be scoped to. The correct posture is: nothing but the
--     service role, ever.
--
-- VERIFY IT after applying (see README, "Verifying RLS"):
--     select tablename, rowsecurity from pg_tables
--      where schemaname = 'public' and tablename like '%stream%';
--   -> rowsecurity must be `t` for every Live Bridge table.
-- =============================================================================

alter table public.stream_keys        enable row level security;
alter table public.stream_sessions    enable row level security;
alter table public.relay_destinations enable row level security;
alter table public.relay_events       enable row level security;
alter table public.event_log          enable row level security;

-- -----------------------------------------------------------------------------
-- FORCE row level security.
--
-- Without FORCE, the table OWNER also bypasses RLS. Turning it on means that
-- even the migration/owner role is subject to the policies, so an accidental
-- query run as the owner from a pooled connection cannot quietly read
-- everything. The service role still bypasses via its BYPASSRLS attribute,
-- which is what the backend relies on.
-- -----------------------------------------------------------------------------
alter table public.stream_keys        force row level security;
alter table public.stream_sessions    force row level security;
alter table public.relay_destinations force row level security;
alter table public.relay_events       force row level security;
alter table public.event_log          force row level security;

-- -----------------------------------------------------------------------------
-- Explicitly revoke the default grants Supabase hands to anon/authenticated.
--
-- RLS alone already blocks these roles, but revoking the table privileges too
-- means a future migration that accidentally adds a permissive policy still
-- won't expose data. Two independent locks, not one.
-- -----------------------------------------------------------------------------
revoke all on public.stream_keys        from anon, authenticated;
revoke all on public.stream_sessions    from anon, authenticated;
revoke all on public.relay_destinations from anon, authenticated;
revoke all on public.relay_events       from anon, authenticated;
revoke all on public.event_log          from anon, authenticated;

-- Also revoke the schema-level default so newly created tables in `public` do
-- not inherit access for these roles.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Deliberately NO policies are created.
--
-- If you ever need direct frontend access (Live Bridge does not, and adding it
-- would violate project rule 25), you would add a scoped policy here, for
-- example:
--
--   create policy "authenticated users read their own sessions"
--     on public.stream_sessions for select
--     to authenticated
--     using (auth.uid() = owner_id);
--
-- Note that would require an owner_id column and real user auth, neither of
-- which exists in this design. Do not add a blanket `using (true)` policy -
-- that would make every table world-readable with the anon key.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- Optional retention helper.
--
-- event_log and relay_events grow without bound. This function trims them; call
-- it from pg_cron if you want automatic retention. It is NOT scheduled by
-- default, because silently deleting audit history should be an explicit choice.
--
--   select cron.schedule('livebridge-retention', '0 4 * * *',
--                        $$ select public.livebridge_prune_logs(90) $$);
-- -----------------------------------------------------------------------------
create or replace function public.livebridge_prune_logs(retain_days integer default 90)
returns table (pruned_event_log bigint, pruned_relay_events bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff timestamptz := now() - make_interval(days => retain_days);
  n1 bigint;
  n2 bigint;
begin
  if retain_days < 1 then
    raise exception 'retain_days must be at least 1';
  end if;

  delete from public.event_log where created_at < cutoff;
  get diagnostics n1 = row_count;

  delete from public.relay_events where created_at < cutoff;
  get diagnostics n2 = row_count;

  return query select n1, n2;
end;
$$;

comment on function public.livebridge_prune_logs is
    'Deletes event_log and relay_events rows older than retain_days. Not scheduled by default.';

-- The function is security definer, so make sure the untrusted roles cannot
-- call it at all.
revoke all on function public.livebridge_prune_logs(integer) from public, anon, authenticated;
