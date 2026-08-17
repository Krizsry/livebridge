-- =============================================================================
-- Live Bridge - initial schema
-- =============================================================================
-- Supabase is used STRICTLY as a data layer (requirement 17):
--   * registered stream IDs / stream keys
--   * historical stream sessions
--   * relay destination configuration
--   * an append-only audit trail
--
-- No media ever passes through Supabase (requirement 18 / project rule 27).
-- The SRT/RTMP engine is entirely local; this database holds metadata only, and
-- the backend is written so that a Supabase outage degrades the dashboard
-- without touching ingest (requirement 21).
--
-- Access model: the backend connects with the SERVICE ROLE key and is the only
-- client. The frontend never talks to Supabase (project rule 25). RLS is still
-- enabled on every table as defence in depth - see the RLS migration.
-- =============================================================================

-- gen_random_uuid() lives in pgcrypto. Supabase enables it by default; this is
-- here so the migration also applies to a bare Postgres.
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest.
-- -----------------------------------------------------------------------------
create or replace function public.livebridge_set_updated_at()
returns trigger
language plpgsql
-- Empty search_path: without this, a role that can create objects could shadow
-- a function name this trigger resolves at runtime.
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- stream_keys - the authorisation registry
-- =============================================================================
-- A publisher is admitted only if its SRT stream ID or RTMP stream key matches
-- an enabled row here (requirement 5). The backend caches this table in memory
-- and refreshes it on a timer, so authorisation never waits on the network.
-- =============================================================================
create table if not exists public.stream_keys (
    id          uuid primary key default gen_random_uuid(),

    -- The literal value an encoder sends. Character set is enforced by the
    -- backend validator as well; the constraint here stops a bad row entering
    -- through psql or the Supabase table editor.
    stream_key  text not null unique
                constraint stream_keys_key_format
                check (stream_key ~ '^[A-Za-z0-9_-]{3,64}$'),

    label       text not null check (char_length(label) between 1 and 120),

    -- Which protocol this key may publish over. 'ANY' permits both.
    protocol    text not null default 'ANY'
                check (protocol in ('SRT', 'RTMP', 'ANY')),

    enabled     boolean not null default true,

    -- Optional second factor: the publisher must additionally send
    -- ?secret=<value> after the stream key. Null means stream key alone.
    secret      text check (secret is null or char_length(secret) between 8 and 128),

    notes       text check (notes is null or char_length(notes) <= 1000),

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

comment on table  public.stream_keys is
    'Registered SRT stream IDs and RTMP stream keys permitted to publish. Cached in backend memory; a Supabase outage never blocks ingest.';
comment on column public.stream_keys.secret is
    'Optional query-parameter token required in addition to the stream key. Never returned to the frontend.';

create index if not exists stream_keys_enabled_idx on public.stream_keys (enabled) where enabled;

drop trigger if exists stream_keys_set_updated_at on public.stream_keys;
create trigger stream_keys_set_updated_at
    before update on public.stream_keys
    for each row execute function public.livebridge_set_updated_at();

-- =============================================================================
-- stream_sessions - historical log of past publisher sessions
-- =============================================================================
-- One row per publishing session. Opened on on_publish, closed when the stream
-- goes offline after the reconnect grace period. A brief reconnect does NOT
-- create a second row - it increments reconnect_count.
-- =============================================================================
create table if not exists public.stream_sessions (
    id                 uuid primary key default gen_random_uuid(),

    stream_key         text not null,

    -- Nullable: at the instant on_publish fires, SRS has not yet told us whether
    -- the publisher arrived over SRT or RTMP. The poller fills it in within a
    -- second. Recording null is more honest than guessing.
    protocol           text check (protocol is null or protocol in ('SRT', 'RTMP', 'WebRTC')),
    connection_mode    text check (connection_mode is null or connection_mode in ('listener', 'caller', 'rendezvous', 'push')),

    source_ip          text,
    client_id          text,

    -- False when the publisher was admitted while the registry was unreachable
    -- (AUTH_FAILURE_MODE=open). Worth being able to audit after the fact.
    authorized         boolean not null default true,

    started_at         timestamptz not null default now(),
    ended_at           timestamptz,
    duration_sec       integer check (duration_sec is null or duration_sec >= 0),

    avg_bitrate_kbps   integer check (avg_bitrate_kbps is null or avg_bitrate_kbps >= 0),
    peak_bitrate_kbps  integer check (peak_bitrate_kbps is null or peak_bitrate_kbps >= 0),
    bytes_received     bigint  check (bytes_received is null or bytes_received >= 0),

    reconnect_count    integer not null default 0,
    end_reason         text,

    created_at         timestamptz not null default now()
);

comment on table public.stream_sessions is
    'Completed and in-flight publisher sessions. ended_at IS NULL means the session is still live (or the backend died before closing it).';

-- The dashboard's default view is "most recent first", optionally per stream.
create index if not exists stream_sessions_started_idx  on public.stream_sessions (started_at desc);
create index if not exists stream_sessions_key_idx      on public.stream_sessions (stream_key, started_at desc);
create index if not exists stream_sessions_protocol_idx on public.stream_sessions (protocol, started_at desc);
-- Finding sessions the backend never closed (crash recovery / audit).
create index if not exists stream_sessions_open_idx     on public.stream_sessions (started_at desc) where ended_at is null;

-- =============================================================================
-- relay_destinations - external RTMP/SRT targets
-- =============================================================================
create table if not exists public.relay_destinations (
    id                 uuid primary key default gen_random_uuid(),

    name               text not null check (char_length(name) between 1 and 120),
    platform           text not null default 'custom'
                       check (platform in ('youtube', 'facebook', 'twitch', 'custom')),

    -- Which Live Bridge stream to forward. Not a foreign key to stream_keys on
    -- purpose: you may want a destination configured before its key is
    -- registered, and deleting a key should not silently delete relay config.
    source_stream_key  text not null
                       constraint relay_destinations_source_format
                       check (source_stream_key ~ '^[A-Za-z0-9_-]{3,64}$'),

    -- Base URL only, e.g. rtmp://a.rtmp.youtube.com/live2
    url                text not null
                       constraint relay_destinations_url_scheme
                       check (url ~ '^(rtmp|rtmps|srt)://'),

    -- The platform's stream key. Backend-only: the API masks this before it
    -- ever reaches the browser, because the dashboard has no login.
    dest_stream_key    text,

    enabled            boolean not null default true,

    -- Pass-through (-c copy) by default. Transcoding costs real CPU, so it is
    -- opt-in per destination.
    transcode          boolean not null default false,
    transcode_profile  jsonb,

    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

comment on table  public.relay_destinations is
    'External republish targets. Relays start automatically when source_stream_key goes live.';
comment on column public.relay_destinations.dest_stream_key is
    'Platform stream key. NEVER returned to the frontend - the API sends a masked form only.';

create index if not exists relay_destinations_source_idx
    on public.relay_destinations (source_stream_key) where enabled;

drop trigger if exists relay_destinations_set_updated_at on public.relay_destinations;
create trigger relay_destinations_set_updated_at
    before update on public.relay_destinations
    for each row execute function public.livebridge_set_updated_at();

-- =============================================================================
-- relay_events - append-only relay audit trail
-- =============================================================================
create table if not exists public.relay_events (
    id                 bigint generated always as identity primary key,

    -- If a destination is deleted, keep its history but drop the link.
    destination_id     uuid references public.relay_destinations(id) on delete set null,
    source_stream_key  text,

    event              text not null
                       check (event in ('started', 'stopped', 'exited', 'spawn_failed', 'retry', 'refused')),
    detail             text check (detail is null or char_length(detail) <= 2000),

    created_at         timestamptz not null default now()
);

create index if not exists relay_events_created_idx on public.relay_events (created_at desc);
create index if not exists relay_events_dest_idx    on public.relay_events (destination_id, created_at desc);

-- =============================================================================
-- event_log - general append-only audit trail
-- =============================================================================
-- Connect/disconnect/reject events for both protocols. This is a durable copy
-- of selected structured log lines; the authoritative logs remain on stdout.
-- =============================================================================
create table if not exists public.event_log (
    id          bigint generated always as identity primary key,

    event       text not null check (char_length(event) between 1 and 64),
    stream_key  text,
    source_ip   text,
    detail      text check (detail is null or char_length(detail) <= 2000),

    created_at  timestamptz not null default now()
);

create index if not exists event_log_created_idx on public.event_log (created_at desc);
create index if not exists event_log_event_idx   on public.event_log (event, created_at desc);
create index if not exists event_log_stream_idx  on public.event_log (stream_key, created_at desc);

comment on table public.event_log is
    'Durable audit trail of stream connect/disconnect/reject events. Grows without bound - see the retention note in the README.';
