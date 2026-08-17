# Live Bridge

A production-ready streaming server that ingests **SRT** and **RTMP**, bridges
between them, republishes to external platforms, and exposes HLS for browser
preview — with a real-time web dashboard.

```
  vMix / Kiloview / OBS / Resi
        │                │
   SRT  │ 9000/udp       │ 1935/tcp  RTMP
        ▼                ▼
  ┌──────────────────────────────┐
  │        SRS engine            │──► HLS  /hls/live/<key>.m3u8
  │  (livebridge_srs)            │──► FLV  /live/live/<key>.flv
  └──────────────────────────────┘──► SRT playback  srt://…m=request
        │ hooks + stats API
        ▼
  ┌──────────────────────────────┐      ┌──────────────┐
  │  Backend (livebridge_backend)│◄────►│   Supabase   │  metadata only
  │  auth · stats · FFmpeg relay │      │  (Postgres)  │  never media
  └──────────────────────────────┘      └──────────────┘
        │ WebSocket + REST                     │ FFmpeg relay
        ▼                                      ▼
  Dashboard ──► Nginx 443 (HTTPS)      YouTube / Facebook / Twitch
```

> **Choosing where to run this?** See **[HOSTING_PLAN.md](HOSTING_PLAN.md)** — free hosting
> options compared (home PC + Tailscale, port forwarding, Cloudflare Tunnel, Oracle Always Free),
> the full tech stack, domain/TLS setup, and bandwidth math. It is a proposal awaiting sign-off;
> this README documents what is actually built.

---

## Table of contents

1. [What you get](#what-you-get)
2. [Deploy on a fresh Ubuntu server](#deploy-on-a-fresh-ubuntu-server)
3. [Point your encoder at Live Bridge](#point-your-encoder-at-live-bridge)
4. [Adding authenticated stream sources](#adding-authenticated-stream-sources)
5. [SRT connection modes](#srt-connection-modes)
6. [Relaying to external platforms](#relaying-to-external-platforms)
7. [Protocol bridging](#protocol-bridging)
8. [Supabase setup](#supabase-setup)
9. [Supabase schema & RLS](#supabase-schema--rls)
10. [Security: restrict dashboard access](#security-restrict-dashboard-access)
11. [Why custom WebSocket over Supabase Realtime](#why-custom-websocket-over-supabase-realtime)
12. [Operations](#operations)
13. [Known limitations](#known-limitations)
14. [API reference](#api-reference)
15. [Troubleshooting](#troubleshooting)
16. [Branding](#branding)

---

## What you get

| Capability | Where |
|---|---|
| SRT ingest, multiple concurrent streams | `9000/udp`, SRS `srt_server` |
| RTMP ingest, multiple concurrent streams | `1935/tcp`, SRS |
| Stream IDs (SRT) and stream keys (RTMP) | `on_publish` hook → registry |
| Passphrase encryption (SRT) + key auth (both) | `SRT_PASSPHRASE`, `stream_keys` table |
| SRT listener / caller / rendezvous | native listener; FFmpeg for caller & rendezvous |
| SRT ⇄ RTMP bridging | FFmpeg egress; native SRT playback for RTMP sources |
| HLS output for every source | `/hls/live/<key>.m3u8` |
| Live dashboard, no login | React + Tailwind behind Nginx 443 |
| Session history, key registry, relay config | Supabase Postgres |
| Auto-restart on crash | Compose `restart: unless-stopped` (+ systemd alternative) |
| Structured JSON logs | backend, Nginx, dashboard, SRS |

---

## Deploy on a fresh Ubuntu server

Tested target: **Ubuntu 22.04 LTS** and **24.04 LTS**, x86-64, 2 vCPU / 4 GB RAM
minimum for pass-through relaying. Add ~1 vCPU per *transcoded* relay.

### 1. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Run docker without sudo (log out and back in afterwards)
sudo usermod -aG docker "$USER"
```

Exactly these packages, and why (project rule 14): Docker Engine + the Compose
plugin to run the stack, `git` to clone it, `curl`/`ca-certificates` for the
repository key. Everything else lives inside the images.

### 2. Get the code and generate secrets

```bash
sudo mkdir -p /opt/livebridge && sudo chown "$USER" /opt/livebridge
git clone <your-repo-url> /opt/livebridge
cd /opt/livebridge

./scripts/gen-secrets.sh
```

This writes `.env` (mode 600, gitignored) with a cryptographically random SRT
passphrase and prints it **once**. Save it in your password manager — every SRT
encoder needs it.

### 3. Fill in the rest of `.env`

```bash
nano .env
```

At minimum:

```ini
LIVEBRIDGE_HOST=stream.yourdomain.com
LIVEBRIDGE_PUBLIC_HOST=stream.yourdomain.com
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
```

Every variable is documented in `.env.example`.

> **Leaving Supabase blank is fine to start.** Set `SUPABASE_ENABLED=false` and
> the whole streaming stack still works — you just lose session history and
> persisted configuration. See [Supabase setup](#supabase-setup).

### 4. TLS certificate

For a quick start (self-signed, browser will warn):

```bash
./scripts/gen-selfsigned-cert.sh
```

For a real certificate with Let's Encrypt:

```bash
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d stream.yourdomain.com

sudo mkdir -p nginx/certs
sudo cp /etc/letsencrypt/live/stream.yourdomain.com/fullchain.pem nginx/certs/livebridge.crt
sudo cp /etc/letsencrypt/live/stream.yourdomain.com/privkey.pem   nginx/certs/livebridge.key
sudo chmod 644 nginx/certs/livebridge.*
```

Renewal — certbot's timer renews, but the files must be re-copied and Nginx
reloaded. Add a deploy hook:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/livebridge.sh >/dev/null <<'EOF'
#!/bin/sh
cp /etc/letsencrypt/live/stream.yourdomain.com/fullchain.pem /opt/livebridge/nginx/certs/livebridge.crt
cp /etc/letsencrypt/live/stream.yourdomain.com/privkey.pem   /opt/livebridge/nginx/certs/livebridge.key
chmod 644 /opt/livebridge/nginx/certs/livebridge.*
cd /opt/livebridge && docker compose restart nginx
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/livebridge.sh
```

### 5. Firewall — do this *before* you start

There is **no login on the dashboard**. Read
[Security](#security-restrict-dashboard-access) before exposing port 443.

```bash
sudo ufw allow 22/tcp                       # SSH
sudo ufw allow 9000/udp                     # SRT ingest
sudo ufw allow 1935/tcp                     # RTMP ingest
sudo ufw allow from 203.0.113.0/24 to any port 443 proto tcp   # dashboard, YOUR IPs only
sudo ufw enable
```

### 6. Start

```bash
docker compose up -d --build
docker compose ps
```

All four services should report `healthy` within about 30 seconds.

### 7. Verify

```bash
# Backend + engine health
curl -sk https://localhost/api/health | jq .

# Ports actually listening on the host
sudo ss -lunp | grep 9000     # SRT  — must be udp
sudo ss -ltnp | grep 1935     # RTMP — must be tcp
sudo ss -ltnp | grep 443      # dashboard

# Structured logs
docker compose logs -f backend | jq .
```

Then open `https://stream.yourdomain.com/` — you should see the Live Bridge
dashboard with "Engine OK".

---

## Point your encoder at Live Bridge

The dashboard's **Encoder Endpoints** panel generates these URLs for any stream
key. Replace `stream.yourdomain.com` and `studio_a` below.

### SRT — vMix

*Output / NDI → Stream → SRT*

| Field | Value |
|---|---|
| Type | **Caller** |
| Hostname | `stream.yourdomain.com` |
| Port | `9000` |
| Stream ID | `#!::r=live/studio_a,m=publish` |
| Latency | `300` ms (match `SRT_LATENCY_MS`) |
| Encryption | on |
| Passphrase | your `SRT_PASSPHRASE` |

### SRT — Kiloview (E2/E3/N-series)

*Encoding → SRT → Push*

| Field | Value |
|---|---|
| Mode | **Caller** |
| Address | `stream.yourdomain.com` |
| Port | `9000` |
| Stream ID | `#!::r=live/studio_a,m=publish` |
| Latency | `300` |
| Encryption | AES-128 |
| Passphrase | your `SRT_PASSPHRASE` |

### SRT — OBS Studio

*Settings → Stream → Service: Custom*

```
Server:     srt://stream.yourdomain.com:9000?streamid=#!::r=live/studio_a,m=publish&latency=300&passphrase=YOUR_PASSPHRASE
Stream Key: (leave empty)
```

> OBS puts everything in the Server field for SRT. Keep the passphrase out of
> shared screenshots.

### SRT — Resi

Resi's SRT output is caller mode. Host `stream.yourdomain.com`, port `9000`,
stream ID `#!::r=live/studio_a,m=publish`, passphrase as above.

### RTMP — OBS / vMix / anything

*Settings → Stream → Service: Custom*

```
Server:     rtmp://stream.yourdomain.com:1935/live
Stream Key: studio_a
```

With an extra secret configured on the key (see below), append it:

```
Stream Key: studio_a?secret=YOUR_SECRET
```

### Browser preview

| Format | URL | Latency |
|---|---|---|
| HLS | `https://stream.yourdomain.com/hls/live/studio_a.m3u8` | ~6 s |
| HTTP-FLV | `https://stream.yourdomain.com/live/live/studio_a.flv` | ~1–2 s |

---

## Adding authenticated stream sources

A stream is admitted only if its **SRT stream ID** or **RTMP stream key** matches
an enabled row in the registry. Everything else is rejected at `on_publish`.

### From the dashboard

**Registered Stream Keys → + Add stream key.** "Generate" produces a random key.

| Field | Meaning |
|---|---|
| Stream key / stream ID | What the encoder sends. 3–64 chars, `A–Z a–z 0–9 _ -` |
| Label | Human name, e.g. "Studio A – vMix" |
| Allowed protocol | `SRT only`, `RTMP only`, or both |
| Extra secret | Optional second factor sent as `?secret=…` |

Changes take effect on the **next** publish attempt — the backend mirrors the
write straight into its in-memory cache.

### From the API

```bash
curl -sk -X POST https://stream.yourdomain.com/api/keys \
  -H 'content-type: application/json' \
  -d '{
        "stream_key": "studio_a",
        "label": "Studio A - vMix",
        "protocol": "SRT",
        "secret": "a-long-random-string",
        "notes": "Sanctuary rack encoder"
      }'
```

### The two layers of auth, and what each actually protects

| Layer | Protects against | Limitation |
|---|---|---|
| **SRT passphrase** (`SRT_PASSPHRASE`) | Passive interception; anyone without the passphrase cannot connect at all | **One passphrase for the entire SRT listener.** SRS has no per-stream-ID passphrase. Everyone publishing over SRT shares it. |
| **Stream key registry** (`on_publish`) | An unknown or revoked source publishing | Per-stream, revocable instantly, works identically for SRT and RTMP |
| **Extra secret** (`?secret=`) | Someone who learned a stream key but not the secret | Travels in the URL — meaningful for RTMP, and for SRT it is inside the encrypted handshake |

Because the SRT passphrase is shared, **the stream-key registry is what gives
you per-source identity and revocation.** If a contractor's encoder leaves, you
disable their stream key; you don't have to re-key every other encoder.

### If Supabase is unreachable

The registry is cached in memory and refreshed every `KEY_CACHE_REFRESH_SEC`
(default 60 s). During an outage the backend keeps authorising from the cache.

Only when the cache is *also* empty — a cold start during an outage — does
`AUTH_FAILURE_MODE` decide:

| Value | Behaviour |
|---|---|
| `open` *(default)* | Admit the publisher, log at `critical`, flag the stream **UNVERIFIED** in the dashboard and in `stream_sessions.authorized` |
| `closed` | Reject the publisher |

The default follows the project requirement that Supabase must never take down
ingest. If you would rather drop a show than accept an unregistered publisher,
set `AUTH_FAILURE_MODE=closed`.

---

## SRT connection modes

All three modes required are supported, but by two different mechanisms — worth
understanding before you plan a deployment.

| Mode | Who dials whom | How Live Bridge does it |
|---|---|---|
| **Listener** | Encoder → Live Bridge | **Native.** SRS's `srt_server` listens on 9000/udp. This is the normal path. |
| **Caller** | Live Bridge → remote | **FFmpeg ingest job.** SRS's SRT server only ever listens; it never dials out. The backend runs an FFmpeg process that connects to the remote and republishes into SRS over local RTMP. |
| **Rendezvous** | Both simultaneously (NAT traversal) | **FFmpeg ingest job**, same mechanism with `mode=rendezvous`. |

Once an FFmpeg-ingested stream lands in SRS it is indistinguishable from a
native one: same hooks, same HLS output, same relay options, same dashboard row.

### Starting a caller or rendezvous ingest

```bash
curl -sk -X POST https://stream.yourdomain.com/api/ingest \
  -H 'content-type: application/json' \
  -d '{
        "stream_key":  "remote_venue",
        "mode":        "caller",
        "remote_host": "198.51.100.20",
        "remote_port": 9000,
        "latency_ms":  400,
        "passphrase":  "the-remote-end-passphrase"
      }'

curl -sk https://stream.yourdomain.com/api/ingest | jq .      # list
curl -sk -X DELETE https://stream.yourdomain.com/api/ingest/ingest:1   # stop
```

Ingest jobs restart automatically with exponential backoff (1 s → 30 s).

> **Bonus:** FFmpeg-based ingest is the *only* path where real SRT transport
> statistics (RTT, packet loss) are available — see
> [Known limitations](#known-limitations).

---

## Relaying to external platforms

### From the dashboard

**Relay Destinations → + Add destination.** Presets are included for YouTube,
Facebook and Twitch; pick "Custom" for anything else.

| Field | Example |
|---|---|
| Name | `Sunday service – YouTube` |
| Platform | `YouTube Live` |
| Source stream key | `studio_a` — the Live Bridge stream to forward |
| Destination URL | `rtmp://a.rtmp.youtube.com/live2` |
| Platform stream key | from YouTube Studio |
| Transcode | leave **off** unless the platform rejects your format |

Relays **start automatically** when the source stream goes live and stop when it
goes offline. You can also Start/Stop manually.

### Platform endpoints

| Platform | URL | Notes |
|---|---|---|
| YouTube Live | `rtmp://a.rtmp.youtube.com/live2` | Key from YouTube Studio → Go Live |
| Facebook Live | `rtmps://live-api-s.facebook.com:443/rtmp` | **RTMPS required** |
| Twitch | `rtmp://live.twitch.tv/app` | Use your nearest ingest server |
| Custom | any `rtmp://`, `rtmps://` or `srt://` | Scheme allowlist is enforced |

### Pass-through vs transcode

Pass-through (`-c copy`) is the default: it remuxes without re-encoding, so
there is **no quality loss and almost no CPU cost**. It requires the destination
to accept your source codecs — H.264 + AAC, which every major platform does.

Turn transcoding on only when a platform rejects your source format or you need
a different bitrate. Budget roughly **one CPU core per 1080p30 transcode**.

```bash
curl -sk -X POST https://stream.yourdomain.com/api/destinations \
  -H 'content-type: application/json' \
  -d '{
        "name": "YouTube 720p",
        "platform": "youtube",
        "source_stream_key": "studio_a",
        "url": "rtmp://a.rtmp.youtube.com/live2",
        "dest_stream_key": "xxxx-xxxx-xxxx-xxxx",
        "transcode": true,
        "transcode_profile": {
          "video_bitrate_kbps": 3000,
          "audio_bitrate_kbps": 128,
          "width": 1280, "height": 720,
          "preset": "veryfast", "gop": 60
        }
      }'
```

### Stream keys are never sent to the browser

The API returns only a masked form (`ab*****yz`). With no login on the
dashboard, echoing a real YouTube key into an API response would let anyone who
reached the page hijack the broadcast.

---

## Protocol bridging

| Direction | Mechanism | Cost |
|---|---|---|
| **SRT in → RTMP out** (YouTube etc.) | FFmpeg egress, `-c copy` | One lightweight process per destination |
| **RTMP in → SRT out** | **Native** — SRS serves any ingested stream over SRT playback | Zero extra processes |
| **SRT in → SRT out** | Native SRT playback | Zero |
| **Either → HLS / FLV** | Native SRS output | Zero |

To pull *any* Live Bridge stream back out over SRT, regardless of how it arrived:

```bash
ffplay "srt://stream.yourdomain.com:9000?streamid=#!::r=live/studio_a,m=request&latency=300&passphrase=YOUR_PASSPHRASE"
```

Note `m=request` (play) versus `m=publish` (ingest).

---

## Supabase setup

Supabase stores **metadata only** — session history, the stream-key registry and
relay destination config. **No media ever passes through it**, and it is never on
the ingest path.

### 1. Create a project

At [supabase.com](https://supabase.com) → New project. Any region; latency does
not matter because nothing time-critical depends on it.

### 2. Get the credentials

**Project Settings → API**:

- **Project URL** → `SUPABASE_URL`
- **`service_role` secret** → `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ The service role key **bypasses Row Level Security**. It belongs in `.env`
> on the server and nowhere else. Never put it in the frontend, a build
> argument, or a `VITE_*` variable. The dashboard has no login, so anything the
> browser receives is effectively public.

### 3. Run the migrations

**With the Supabase CLI (recommended):**

```bash
npm install -g supabase
supabase login
supabase link --project-ref your-project-ref
supabase db push
```

**Or paste them manually** — SQL Editor → New query, run in order:

1. `supabase/migrations/20260815120000_livebridge_init.sql`
2. `supabase/migrations/20260815120100_livebridge_rls.sql`

### 4. Verify RLS is on

```sql
-- Note: forcerowsecurity lives on pg_class, not pg_tables.
select c.relname            as table_name,
       c.relrowsecurity     as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('stream_keys','stream_sessions','relay_destinations',
                    'relay_events','event_log')
order by c.relname;
```

Every row must show `rls_enabled = t` **and** `rls_forced = t`. Then confirm the anon key really sees
nothing:

```bash
curl -s "https://your-project-ref.supabase.co/rest/v1/stream_keys?select=*" \
  -H "apikey: YOUR_ANON_KEY" -H "Authorization: Bearer YOUR_ANON_KEY"
# Expected: []  (or a permission error) — never actual rows
```

> **Verified on this project (2026-08-15):** all five tables created, `rls_enabled`
> and `rls_forced` both true on every one, zero policies, zero grants to
> `anon`/`authenticated`. An anon-key request to each table returns **HTTP 401
> `42501 permission denied`**, while the service role returns **HTTP 200**.

### 5. Restart the backend

```bash
docker compose restart backend
docker compose logs backend | jq 'select(.service=="supabase")'
```

---

## Supabase schema & RLS

### Tables

#### `stream_keys` — the authorisation registry

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `stream_key` | `text` UNIQUE | Enforced `^[A-Za-z0-9_-]{3,64}$` |
| `label` | `text` | Human name |
| `protocol` | `text` | `SRT` \| `RTMP` \| `ANY` |
| `enabled` | `boolean` | Disable to revoke instantly |
| `secret` | `text` | Optional `?secret=` token. **Never returned to the frontend** |
| `notes` | `text` | |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` maintained by trigger |

#### `stream_sessions` — history

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `stream_key` | `text` | |
| `protocol` | `text` NULL | Null until the poller identifies the transport (~1 s) |
| `connection_mode` | `text` NULL | `listener` \| `caller` \| `rendezvous` \| `push` |
| `source_ip`, `client_id` | `text` | |
| `authorized` | `boolean` | `false` = admitted during a registry outage |
| `started_at` / `ended_at` | `timestamptz` | `ended_at IS NULL` ⇒ still live |
| `duration_sec` | `integer` | |
| `avg_bitrate_kbps`, `peak_bitrate_kbps` | `integer` | |
| `bytes_received` | `bigint` | |
| `reconnect_count` | `integer` | A brief reconnect does **not** create a second row |
| `end_reason` | `text` | |

#### `relay_destinations` — external targets

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `name`, `platform` | `text` | `youtube` \| `facebook` \| `twitch` \| `custom` |
| `source_stream_key` | `text` | Which Live Bridge stream to forward |
| `url` | `text` | Scheme constrained to `rtmp`/`rtmps`/`srt` |
| `dest_stream_key` | `text` | **Never returned to the frontend** |
| `enabled`, `transcode` | `boolean` | |
| `transcode_profile` | `jsonb` | |

#### `relay_events` / `event_log` — append-only audit trail

Relay lifecycle events and stream connect/disconnect/reject events. These grow
without bound; see [retention](#log--data-retention).

### RLS policy model

RLS is enabled **and forced** on every table, with **no policies defined**.

That is deliberate, and it is the strictest possible configuration:

- The **service role** (the backend) has `BYPASSRLS`, so it works normally.
- `anon` and `authenticated` have **no policies**, and with RLS enabled that
  means Postgres denies every row. A leaked anon key reads nothing and writes
  nothing.
- `FORCE ROW LEVEL SECURITY` extends this to the table *owner*, so even a query
  run as the owner from a pooled connection can't quietly read everything.
- Table privileges are additionally `REVOKE`d from `anon`/`authenticated`, so a
  future migration that accidentally adds a permissive policy still won't expose
  data. Two independent locks.

There is no user-level auth in Live Bridge (by design — requirement 12), so
there is no principal these tables could meaningfully be scoped to. "Service
role only, ever" is the correct posture.

**Do not add a `using (true)` policy.** That would make every table
world-readable to anyone with the anon key.

### Log / data retention

`event_log` and `relay_events` grow forever. A retention helper is included but
**not scheduled**, because silently deleting audit history should be a choice:

```sql
select public.livebridge_prune_logs(90);   -- keep 90 days

-- Or schedule it with pg_cron:
select cron.schedule('livebridge-retention', '0 4 * * *',
                     $$ select public.livebridge_prune_logs(90) $$);
```

---

## Security: restrict dashboard access

> ### ⚠️ There is no login on the dashboard. This is intentional — and it means the network is your only protection.
>
> Anyone who can reach port 443 can add relay destinations, disable stream keys,
> stop live relays and read your entire session history. **Treat the dashboard
> port exactly as you would an unauthenticated admin panel, because that is what
> it is.**

Pick **at least one**, ideally two:

### Option 1 — VPN (strongest, recommended)

Put the dashboard behind WireGuard and never expose 443 publicly.

```bash
sudo apt-get install -y wireguard
# ... configure WireGuard ...

# In .env — bind the dashboard to the VPN interface only:
HTTPS_BIND_ADDR=10.8.0.1
```

```bash
sudo ufw allow 51820/udp     # WireGuard
# and do NOT open 443 to the world
```

### Option 2 — Firewall IP allowlist

```bash
sudo ufw allow from 203.0.113.0/24 to any port 443 proto tcp   # office
sudo ufw allow from 198.51.100.5   to any port 443 proto tcp   # home
sudo ufw deny 443/tcp
```

### Option 3 — Nginx allowlist (defence in depth)

Uncomment the block in `nginx/livebridge.conf`:

```nginx
allow 10.8.0.0/24;        # VPN subnet
allow 203.0.113.0/24;     # office
deny  all;
```

Then `docker compose restart nginx`.

### Option 4 — SSH tunnel (no public exposure at all)

```ini
# .env
HTTPS_BIND_ADDR=127.0.0.1
```

```bash
ssh -L 8443:127.0.0.1:443 user@stream.yourdomain.com
# then browse to https://localhost:8443
```

### What stays public either way

`9000/udp` and `1935/tcp` must be reachable by your encoders. Those are
protected by the SRT passphrase and the stream-key registry, not by the
firewall — which is exactly why the registry matters.

### Other hardening applied by default

- The SRS HTTP API (1985), SRS's HLS server (8080), the backend (8000) and the
  dashboard's static server (8080) are **never published to the host** — internal
  Docker network only.
- SRS's `raw_api` is **off**, so nothing on the network can reconfigure or kick
  streams through the API.
- Nginx blocks `/api/hooks/` from the public side, so nobody can forge a publish
  authorisation or a session record.
- Every container runs as a **non-root** user with `no-new-privileges`.
- FFmpeg is always spawned with an **argv array and no shell**, so a malicious
  destination URL cannot become command injection.
- Platform stream keys and the SRT passphrase are **never** sent to the browser.

---

## Why custom WebSocket over Supabase Realtime

Requirement 17 asks which to use for sub-second updates, and why. **Live Bridge
uses a custom WebSocket for live metrics, and leaves Supabase Realtime available
for durable data.** The reasoning:

**Where the data comes from.** Bitrate, uptime, viewer counts and relay state are
produced by the backend's own poll loop, reading the SRS API over the local
Docker bridge once a second. The dashboard is usually on the same LAN. Routing
that through Supabase Realtime means:

```
backend → WAN → Supabase Postgres write → logical replication
        → Realtime server → WAN → browser
```

That is two internet round trips added to a number that travelled three
processes on one host.

**Write amplification.** One row per stream per second is ~86,400 writes per
stream per day, purely to move a number to a browser. Ten streams during a
service is nearly a million rows a day of pure telemetry churn.

**It would violate requirement 21.** The live view would stop updating whenever
Supabase had a bad minute — and worse, the backend would be retrying writes
against a failing endpoint precisely when a show is live. The custom WebSocket
keeps the live view working with *zero* external dependencies; if Supabase is
down, the dashboard shows current streams perfectly and only the history panel
says "History unavailable".

**Where Supabase Realtime *would* be the better tool** — and remains available —
is durable, low-frequency changes: a second operator adding a relay destination,
or a completed session appearing in history. Those already live in Postgres,
change a few times an hour, and genuinely benefit from server-pushed
cross-client sync. Subscribe to `stream_sessions` / `relay_destinations` if you
want that; nothing in this design prevents it.

**Summary:** local, high-frequency, availability-critical → custom WebSocket.
Durable, low-frequency, multi-client → Supabase Realtime, optional.

---

## Operations

### Everyday commands

```bash
docker compose ps                        # status
docker compose logs -f backend | jq .     # structured logs
docker compose restart backend            # restart one service
docker compose up -d --build              # rebuild after a code change
docker compose stop                        # stop everything (keeps data)
```

> **Never run `docker compose down -v`** — the `-v` deletes volumes. Project
> rule 4.

### Log format

Every component emits one JSON object per line.

```bash
# Only stream connect/disconnect events
docker compose logs backend | jq 'select(.event | test("publisher_"))'

# Rejected publishers
docker compose logs backend | jq 'select(.event=="publish_rejected")'

# Relay problems
docker compose logs backend | jq 'select(.service=="relay" and .level=="error")'

# Dashboard access
docker compose logs nginx | jq 'select(.event=="dashboard_access")'

# Anything critical — including auth fail-open
docker compose logs backend | jq 'select(.level=="critical")'
```

Secrets are redacted by the logger: any field whose name contains `passphrase`,
`secret`, `token`, `service_role` etc. is replaced with `[redacted]`, and
outbound RTMP URLs have their stream key masked.

Docker rotates logs at 20 MB × 5 files per service.

### Auto-restart

Every service is `restart: unless-stopped`, so containers come back after a
crash and after a host reboot. Failure is isolated per-container: if the backend
dies, **SRT and RTMP ingest keep running** — SRS has no dependency on it. The
`on_publish` hook failing open or closed during that window is governed by SRS's
own hook timeout, and existing streams are unaffected.

A systemd alternative is in [`systemd/`](systemd/README.md).

### Backup

The only durable state is in Supabase:

```bash
supabase db dump -f livebridge-backup-$(date +%F).sql
```

Back up `.env` separately and securely — it holds the SRT passphrase and the
service role key.

---

## Known limitations

Stated plainly, because discovering these mid-event is worse than reading them
now.

### 1. SRT packet loss and RTT are unavailable for native SRT ingest

SRS's HTTP API does not expose per-connection SRT transport statistics in
versions 5 and 6. For streams arriving directly on the SRT listener, the
dashboard shows **`n/a`** for packet loss, RTT and measured latency — *not* a
zero. A fabricated `0%` would tell you your link is perfect when in fact nothing
was measured.

Bitrate, uptime, byte counts, resolution, codec, FPS and viewer counts **are**
available for every stream on both protocols.

Confirmed against SRS 6.0.191 with a live SRT publisher: `GET /api/v1/streams`
and `GET /api/v1/clients` return bitrate, byte counters, codecs and
seconds-connected, and no RTT or loss field of any kind.

> **Don't be fooled by a 200 here.** SRS answers **HTTP 200 with its API index**
> for *any* unknown path, so probing a guessed endpoint such as
> `/api/v1/srt/streams` looks like a hit until you read the body. Check the
> payload, not the status code.

Options if you need full SRT telemetry:

- Route SRT ingest through an FFmpeg ingest job (caller mode) — FFmpeg reports
  transport stats. Costs one process per stream.
- Read SRS's own logs, which include some SRT detail at `trace` level.
- Upgrade or patch SRS if a future version exposes these in the API.

### 2. One SRT passphrase for all SRT publishers

An SRS design constraint, not a Live Bridge one. Per-stream identity comes from
the stream-key registry instead. See
[the auth layers table](#the-two-layers-of-auth-and-what-each-actually-protects).

### 3. SRT caller and rendezvous cost a process each

SRS's SRT server is listener-only. Caller and rendezvous ingest run through
FFmpeg. Fine for a handful of remote feeds; not what you'd build a hundred-input
contribution network on.

### 4. Pass-through relays require compatible codecs

`-c copy` means the destination must accept H.264 + AAC. If a platform rejects
your stream, enable transcoding for that destination and budget the CPU.

### 5. Supabase outage effects

| Works | Degrades |
|---|---|
| SRT / RTMP ingest | Session history → "History unavailable" |
| HLS / FLV output | Adding or editing stream keys and destinations |
| Relays already running | New destinations cannot be saved |
| Live dashboard metrics | Authorisation falls back to cache, then `AUTH_FAILURE_MODE` |

---

## API reference

All endpoints are same-origin under `/api`, unauthenticated by design.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | Non-sensitive config for the UI |
| `GET` | `/api/health` | Engine, poller, Supabase, registry health |
| `GET` | `/api/streams` | Live streams + viewers + relays |
| `GET` | `/api/streams/:key` | One live stream |
| `GET` | `/api/viewers` | All viewers |
| `GET` | `/api/sessions` | History. `?limit&offset&stream_key&protocol&since` |
| `GET` | `/api/keys` | Registered keys (secrets redacted) |
| `POST` | `/api/keys` | Register a key |
| `PATCH` | `/api/keys/:id` | Update a key |
| `DELETE` | `/api/keys/:id` | Delete a key |
| `POST` | `/api/keys/refresh` | Force a registry refresh |
| `GET` | `/api/destinations` | Relay destinations (keys masked) |
| `POST` | `/api/destinations` | Add a destination |
| `PATCH` | `/api/destinations/:id` | Update a destination |
| `DELETE` | `/api/destinations/:id` | Delete a destination |
| `POST` | `/api/destinations/:id/start` | Start relaying now |
| `POST` | `/api/destinations/:id/stop` | Stop relaying |
| `GET` | `/api/relays` | Relay + ingest job status |
| `GET` | `/api/relay-events` | Relay audit trail |
| `GET` | `/api/ingest` | SRT ingest jobs |
| `POST` | `/api/ingest` | Start a caller/rendezvous ingest |
| `DELETE` | `/api/ingest/:id` | Stop an ingest job |
| `WS` | `/ws` | Live metrics: snapshot, then a frame per second |

Internal only, blocked at Nginx: `/api/hooks/srs/*` — the SRS callbacks.

---

## Troubleshooting

**Dashboard shows `400 Bad Request — Request Header Or Cookie Too Large`**

Your browser is sending an oversized `Cookie` header. Cookies are scoped by
hostname only — not by port or scheme — so on `localhost` every other dev server
you have ever run contributes cookies to the same origin, and they all get sent
here too.

Nginx drops the `Cookie` header on the way to the dashboard and API (neither has
any use for one — there is no app-level login), so this should not happen. If it
does, you are on a stale config; reload the proxy:

```bash
docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
```

To confirm the cause, check whether the 400 came from the proxy or from behind
it — `upstream_status: "400"` in the access log means the upstream container
rejected it, not the edge:

```bash
docker compose logs nginx | jq 'select(.status==400)'
```

An Incognito window (which sends no cookies) is the quickest one-off workaround.

**404 (or wrong content) after rebuilding a container**

This is fixed and should no longer happen — nginx re-resolves service names
through Docker's DNS every 10 s, so a rebuilt container is picked up
automatically with no reload.

Historically nginx resolved `upstream` hostnames **once, at config load**. A
rebuilt container got a new IP, Docker handed the freed address to a different
container, and nginx silently proxied to the wrong service — surfacing as a
**404, not a 502**, with nginx still reporting healthy.

If you ever see it again, the diagnostic is to compare the container directly
against the proxy. Upstream healthy but proxy failing is the signature:

```bash
docker compose exec backend curl -s -o /dev/null -w '%{http_code}\n' http://livebridge_dashboard:8080/
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/
```

**Encoder won't connect over SRT**

```bash
sudo ss -lunp | grep 9000            # must show udp, not tcp
docker compose logs srs | tail -50   # look for handshake errors
```
Most common causes: passphrase mismatch, UDP blocked upstream, encoder latency
lower than `SRT_LATENCY_MS`, or a malformed stream ID (it must be exactly
`#!::r=live/<key>,m=publish`).

**Publisher is rejected**

```bash
docker compose logs backend | jq 'select(.event=="publish_rejected")'
```
The `reason` field says exactly why: not registered, disabled, wrong protocol,
or bad secret.

**Stream shows `DETECTING` for its protocol**

Normal for the first second — the poller identifies the transport from the SRS
client list on the next tick. If it persists, the SRS API is unreachable; check
`/api/health`.

**Relay won't start**

```bash
docker compose logs backend | jq 'select(.service=="relay")'
curl -sk https://localhost/api/relays | jq .
```
Check that the source stream is actually live, the destination is enabled, and
the platform key is correct. `last_error` carries FFmpeg's own message.

**Dashboard shows "Engine down"**

```bash
docker compose ps
docker compose logs srs | tail -50
curl -s http://localhost:1985/api/v1/versions   # from inside the host network
```

**HLS won't play**

HLS needs a keyframe to start a segment. Set your encoder's keyframe interval to
2 seconds. Allow `hls_fragment × 3` (~6 s) before the first segment appears.

**Everything says "Supabase down"**

```bash
docker compose logs backend | jq 'select(.service=="supabase")'
curl -s "$SUPABASE_URL/rest/v1/" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"
```
Streaming is unaffected — this only impacts history and stored config.

---

## Project layout

```
livebridge/
├── docker-compose.yml            # 4 services, 3 published ports
├── .env.example                  # every variable documented
├── srs/                          # SRS engine image + config template
│   ├── conf/livebridge.conf.template
│   └── docker-entrypoint.sh      # renders config, validates the passphrase
├── backend/                      # API, WebSocket, hooks, FFmpeg relay manager
│   ├── src/
│   └── test/                     # regression suite — `npm test`
├── dashboard/                    # React + Tailwind, no login
│   ├── src/
│   └── public/                   # generated logo + favicon (served at site root)
├── brand/                        # master logo artwork (source of truth)
├── nginx/livebridge.conf         # TLS, reverse proxy, JSON access logs
├── supabase/migrations/          # schema + RLS
├── systemd/                      # non-Docker alternative
├── scripts/                      # secret, certificate and brand asset generation
├── PROGRESS.md                   # running build log
└── CLAUDE.md                     # project rules
```

## Branding

The dashboard header, browser tab icon and touch icon all come from one master
image, `brand/livebridge-logo-master.jpg`. Everything else is generated:

```bash
powershell -ExecutionPolicy Bypass -File scripts\gen-logo-assets.ps1
```

That writes four files into `dashboard/public/`, which Vite copies verbatim to
the site root at build time:

| File | Used by | Notes |
|---|---|---|
| `livebridge-logo-dark.png` | dashboard header | Dark-surface variant — see below |
| `livebridge-logo.png` | docs, light backgrounds | Full logo incl. the RTMP / SRT / SERVER strip |
| `livebridge-mark.png` | `apple-touch-icon` | Square LB monogram, 256×256 |
| `favicon.png` | browser tab | Same monogram, 64×64 |

**Why there are two colour variants.** The master is dark navy ink on solid
white. The dashboard surface is `#0b1017`, so the navy wordmark is essentially
invisible on it — dropping the original straight into the header either
disappears or forces an ugly white box behind it. The generator therefore
produces a dark-surface variant that keys the white background out to
transparency and remaps only the near-black navy to slate-300, leaving the red
and blue brand gradients untouched. **Use `livebridge-logo.png` on light
backgrounds and `livebridge-logo-dark.png` on dark ones**; neither works well on
the other.

The script installs nothing (it uses the `System.Drawing` assembly that ships
with Windows) and never runs inside a container or at request time. Crop boxes
are measured from the current master and are documented at the bottom of the
script; replacing the master with differently-proportioned artwork means
re-measuring them.

The generated PNGs are served with `Cache-Control: public, max-age=86400`
rather than the `immutable` used for `/assets/` — their filenames are not
content-hashed, so a rebrand needs to be able to reach clients without a hard
reload.

## Running the tests

```bash
cd backend
npm ci        # first time only
npm test      # 280 assertions, 8 suites, ~30 s
```

Run one suite by name — `npm test relay`, `npm test session` — matching is a substring of the
suite name.

Nothing is installed to run these: the runner, the assertions and the mocks are hand-rolled on
`node:http`, so the backend keeps its three-dependency budget.

| Suite | What it protects |
|---|---|
| `unit` | input validators and FFmpeg argv construction — argv is always an array, never a shell string |
| `state` | session lifecycle in memory: takeover vs reconnect, uptime derivation, SRT latency field |
| `relay-supervision` | FFmpeg process supervision: one child per destination, deferred restart, backoff, force-kill |
| `integration` | the real backend against a mock SRS — auth gate, poller, WebSocket, validation |
| `auth-closed` | `AUTH_FAILURE_MODE=closed` rejects unregistered publishers and answers SRS fast |
| `supabase-errors` | a duplicate key is a 409, not a 503, and does not trip the circuit breaker |
| `session-lifecycle` | the Supabase writes themselves, against a mock PostgREST |
| `poller-inactive` | a finished stream is never resurrected, and a live one is never reaped |

**What these do and do not prove.** The suites run the real `src/index.js` as a child process;
only SRS and Supabase are mocked, each behind its own HTTP server. That covers backend logic
thoroughly. It does **not** cover the container stack — the mock SRS has no vhost concept, no URI
parser and no SRT stack, and three of the worst bugs in this project's history (the
hostname-underscore parse failure, `srt disabled` on the vhost, and the HLS playlist path
collision) were invisible to a mock and only ever surfaced against the real container. **A green
`npm test` means the logic is right, not that the stack works.** Verify ingest with a real encoder.
