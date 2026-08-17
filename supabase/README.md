# Live Bridge — Supabase

Supabase is used **strictly as a data layer**. It holds metadata and logs only:

- `stream_keys` — registered SRT stream IDs / RTMP stream keys
- `stream_sessions` — historical publisher sessions
- `relay_destinations` — external RTMP/SRT relay targets
- `relay_events`, `event_log` — append-only audit trail

**No media ever passes through Supabase.** The SRT/RTMP engine is fully local,
and nothing on the ingest path waits on a Supabase call.

## Migrations

Applied in filename order:

| File | Contents |
|---|---|
| `20260815120000_livebridge_init.sql` | Tables, constraints, indexes, `updated_at` triggers |
| `20260815120100_livebridge_rls.sql` | RLS enabled + forced on every table, privileges revoked, retention helper |

```bash
supabase link --project-ref your-project-ref
supabase db push
```

Or paste each file into the Supabase SQL Editor, in order.

## Access model

Only the **backend** talks to Supabase, using the **service role key** from
`.env`. The frontend never receives any Supabase credential — there is no
user-level auth in Live Bridge, so anything the browser holds is effectively
public.

RLS is enabled *and forced* on every table with **no policies defined**, which
denies `anon` and `authenticated` everything. The service role bypasses RLS by
design.

Full schema documentation, the RLS rationale, and the verification commands are
in the main [README](../README.md#supabase-schema--rls).
