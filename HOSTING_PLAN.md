# Live Bridge — Hosting & Ease-of-Use Plan

> **Status:** Proposal. Nothing in this document has been implemented.
> Everything under "Rollout" that touches port exposure, dashboard reachability, or
> startup/restart behaviour requires explicit go-ahead per CLAUDE.md rule 11.
>
> **Constraints given by the operator:** stay on Windows (no OS switch), no paid cloud VPS,
> must remain free, and make use of the already-owned domain `krzn.site`.

---

## 0. DECISION LOG — updated 2026-08-15

**The operator has chosen a different path from the §1 recommendation below.**

| Decision | Choice |
|---|---|
| **Production hosting** | **AWS** (paid). Supersedes §4 Options A–F for the production question. |
| **First step** | **Run locally on this machine under WSL2 + Docker**, before touching AWS. |

§§ 2–12 are kept as the record of how the decision was reached, and the bandwidth math (§8),
tech stack (§6) and domain/TLS logic (§7) all still apply to AWS. **Read §13 for the active plan.**

### ⚠️ Critical constraint discovered on this machine

This is **Windows 10 (build 19045)**. WSL2's **mirrored networking mode is Windows 11 only**.
On Windows 10, WSL2 uses NAT networking, where `localhostForwarding` handles **TCP only** —
**UDP is not forwarded**, and `netsh interface portproxy` cannot forward UDP either.

**Consequence: do NOT install Docker Engine natively inside a WSL distro on this machine.**
SRT is `9000/udp`. Under bare Docker-in-WSL on Windows 10, SRT ingest would be unreachable from
Windows or the LAN — silently breaking the exact protocol this project exists for, while RTMP
(TCP) kept working and made it look fine.

**Use Docker Desktop with WSL2 integration instead.** Docker Desktop runs its own port proxy on
the Windows side that publishes UDP correctly — already proven on this machine, which previously
bound `127.0.0.1:9000->9000/udp` successfully.

---

## 1. TL;DR — the recommendation *(superseded for production — see §0)*

**Run Live Bridge on the existing Windows PC. Reach it over Tailscale. Put `stream.krzn.site`
in front of it with a real Let's Encrypt certificate issued by DNS-01. Open zero router ports.**

That gives you:

| Want | How it is delivered |
|---|---|
| A real HTTPS dashboard, no browser warning | `https://stream.krzn.site` + Let's Encrypt DNS-01 cert |
| SRT ingest from your laptop/phone anywhere | Tailscale carries UDP — Cloudflare cannot |
| RTMP ingest from OBS anywhere | Same tailnet |
| No open ports on your home router | Tailscale is outbound-only |
| Works even behind CGNAT | Tailscale relays via DERP if NAT traversal fails |
| Cost | **$0** |

If you later need *strangers* to push a stream into you, that is a separate, riskier decision —
see Option B in §4.

**One free alternative worth knowing about even though it is technically a VPS:**
**Oracle Cloud Always Free** is free forever (not a 12-month trial) and includes **10 TB/month
egress**, which is the only free tier with enough bandwidth for video. It solves the "my PC must
stay on" problem for $0. It is listed as Option D. Your call — you said no VPS, and this plan
does not assume one.

---

## 2. What "free + no VPS + Windows" actually costs you

These are real and should be decided on, not discovered mid-service.

1. **This PC becomes the server.** If it sleeps, reboots, updates, or Docker Desktop is closed,
   the stream dies. Sleep and hibernate must be disabled. Windows Update reboots are a live risk.
2. **Your home upload is the hard ceiling.** See the bandwidth math in §8. This is the single
   most common reason a home streaming setup fails, and no software choice fixes it.
3. **You may be behind CGNAT.** If your ISP hands you a shared address, port forwarding is
   impossible regardless of configuration. Test this before designing around it (§3).
4. **No SLA, no redundancy.** A power cut at your house ends the broadcast. A VPS does not have
   this problem — that is genuinely what you are trading away for $0.

---

## 3. The three questions that decide the whole architecture

Answer these first; everything downstream follows.

### Q1 — Who needs to send a stream *in*?

| Answer | Consequence |
|---|---|
| Only me / my own devices | **Tailscale alone is sufficient.** No open ports, ever. Simplest and safest. |
| Third parties, or a hardware encoder I can't install software on | You need real public ingest → Option B, port forwarding, and a serious security conversation |

### Q2 — Who watches, and where?

| Answer | Consequence |
|---|---|
| Audience watches on YouTube / Facebook / Twitch | **Best case.** Your home upload carries exactly *one* copy to each platform. The platform's CDN serves the audience. This is what Live Bridge's relay feature is for. |
| Audience watches HLS directly from my box | Your upload is multiplied by every viewer. 10 viewers at 6 Mbps = 60 Mbps upload. Not viable on a home line. |

### Q3 — Am I behind CGNAT?

**Test:** compare your router's WAN IP against what a "what is my IP" site reports.

- **They match** → you have a real public IP; port forwarding is possible.
- **They differ**, or the WAN IP is in `100.64.0.0` – `100.127.255.255` → **you are behind CGNAT.**
  Port forwarding is dead. Tailscale or a cloud host are your only paths.

---

## 4. Hosting options — full comparison

### Option A ⭐ — Home Windows PC + Tailscale *(recommended)*

Tailscale is a free personal-tier mesh VPN (WireGuard under the hood). Install it on the Windows
host and on each device that needs to connect. Every device gets a stable `100.x.y.z` address.

Then point the real domain at that private address: a **public DNS `A` record
`stream.krzn.site → 100.x.y.z`**. The *name* is public; the *address* is private-only. Anyone not
on your tailnet resolves the name and then reaches nothing. Pair it with a Let's Encrypt cert
issued by **DNS-01 challenge** (validated via a DNS TXT record, so no inbound port is needed at
all) and you get a genuinely trusted certificate on a domain you own, with nothing exposed.

- **Cost:** free (personal tier: 3 users / 100 devices)
- **Carries UDP?** **Yes** — this is why SRT works here and nowhere else on this list
- **Open ports required:** none
- **Works behind CGNAT?** Yes
- **Trade-offs:** only enrolled devices can connect; if direct NAT traversal fails the connection
  is relayed through Tailscale's DERP servers, adding latency — which matters for SRT. Verify with
  `tailscale status` that the link shows `direct` and not `relay` before a real service.

### Option B ⚠️ — Home PC + router port forwarding + Dynamic DNS

Forward `1935/tcp` and `9000/udp` from your router to this PC, plus a small scheduled script that
updates the Cloudflare `A` record when your home IP rotates (free via Cloudflare's API).

- **Cost:** free
- **Required for:** third-party ingest, hardware encoders
- **Requires:** a real public IP (fails under CGNAT — see Q3)
- **Risks:** your home network becomes internet-reachable. If we do this it comes bundled with
  `AUTH_FAILURE_MODE=closed`, a mandatory SRT passphrase, and rate limiting.
- **Explicitly gated:** I will not configure this without a written yes (rule 11).

### Option C — Home PC + Cloudflare Tunnel

Free, needs no open ports, gives a trusted cert automatically.

- **Carries HTTP/HTTPS:** yes — great for the dashboard
- **Carries SRT (UDP):** **no.** Not supported. This is disqualifying for ingest.
- **Carries RTMP (raw TCP):** only via `cloudflared access tcp` running *on the encoder machine* —
  impractical for OBS, impossible for a hardware encoder
- **ToS caveat:** serving significant non-HTML content (i.e. HLS video) through Cloudflare's free
  proxy is restricted under their Terms §2.8. Dashboard = fine. Video to an audience = risky.
- **Verdict:** a nice *supplement* for dashboard access, never a substitute for Option A.

### Option D — Oracle Cloud Always Free *(free forever, but it is a VPS)*

The only free tier with bandwidth adequate for video.

- **Includes:** up to 4 ARM Ampere A1 cores + 24 GB RAM, ~200 GB storage, and **10 TB/month egress**
- **Cost:** $0, indefinitely — not a 12-month trial
- **Why it matters:** solves "my PC must stay on", gives a static public IP, real ports, no CGNAT
- **Caveats to go in with eyes open:**
  - ARM (`aarch64`) capacity is frequently unavailable in popular regions; you may wait or retry
  - Oracle reclaims idle Always Free resources unless the account is upgraded to Pay-As-You-Go
    (which can still cost nothing if you stay in free limits, but requires a card on file)
  - All four containers would need ARM64 images — `ossrs/srs`, `node`, and
    `nginxinc/nginx-unprivileged` all publish arm64 tags, so this should work, but it is untested
- **Note:** this contradicts your "no VPS" constraint, so it is not assumed anywhere in the
  rollout. Listed because it is the honest answer to "what's the most reliable free option".

### Option E — Google Cloud free tier *(not viable)*

One `e2-micro` in a US region is genuinely always-free, **but the free egress allowance is
approximately 1 GB/month**. At 6 Mbps that is about **22 minutes of streaming per month.**
Structurally unusable for video. Listed only so it is not re-proposed later.

### Option F — Spare hardware you already own

An old laptop, a mini PC, a Raspberry Pi 4/5, or a Synology/QNAP NAS with Docker. Free if the
hardware exists. Advantage over the main PC: it can stay on 24/7 without tying up your workstation.
A Pi handles SRS passthrough fine; it does **not** handle transcoding, so relay destinations must
stay on the default `-c copy` profile.

### Non-options — and why, so they don't get suggested again

| Platform | Why it cannot work |
|---|---|
| Vercel, Netlify, GitHub Pages | Static/serverless only. No long-lived processes, no raw TCP, no UDP. |
| Render, Railway, Heroku | HTTP ingress only. No UDP → no SRT. Free tiers also sleep on idle. |
| Fly.io | Supports UDP, but the free allowance has been withdrawn for new accounts and bandwidth is metered. |
| AWS / Azure free tiers | 12-month trials, then billed. Fails "stay free". |

---

## 5. Recommended architecture

```
                    ┌────────────────────── your Windows PC ──────────────────────┐
                    │                                                             │
 OBS / vMix ──SRT──▶│  livebridge_srs  (SRS 6)  ← RTMP 1935 / SRT 9000 / HLS      │
 (over Tailscale)   │        │  http_hooks + HTTP API (1985, internal only)        │
                    │        ▼                                                     │
                    │  livebridge_backend (Node 22)  ── FFmpeg relay processes ────┼──▶ YouTube
                    │        │  WebSocket 1 Hz metrics                             │    Facebook
                    │        ▼                                                     │    Twitch
                    │  livebridge_dashboard (React/Vite, static)                   │
                    │        ▲                                                     │
                    │  livebridge_nginx  ── TLS 443 ──┐                            │
                    └─────────────────────────────────┼────────────────────────────┘
                                                      │
                              https://stream.krzn.site │ (A record → 100.x.y.z, Tailscale-only)
                                                      │
                                          your laptop / phone / operators
                                                (on the tailnet)

                    Supabase (free tier, cloud) ◀── metadata + session history only
                                                    never in the media path
```

**Key property:** the media path is entirely local. Supabase being down degrades history to
"unavailable" and never touches ingest (requirement 21, already implemented via the circuit
breaker in `backend/src/supabase.js`).

---

## 6. Tech stack

### What is already built and running

| Layer | Technology | Version | Role | Why this choice |
|---|---|---|---|---|
| Media engine | **SRS (Simple Realtime Server)** | `ossrs/srs:6` (6.0.191) | SRT listener (9000/udp), RTMP listener (1935/tcp), HLS/FLV output, HTTP callbacks | One binary serves both protocols; native SRT listener; mature callback hooks for auth |
| Backend | **Node.js** | `node:22-alpine` | SRS hooks, 1 Hz stats poller, WebSocket hub, FFmpeg relay manager, Supabase client | Only 3 runtime deps (rule 14) |
| ↳ HTTP | **Express** | ^4.19 | REST API | — |
| ↳ Realtime | **ws** | ^8.18 | WebSocket push, snapshot + 1 Hz deltas | Chosen over Supabase Realtime — metrics are local, a WAN round-trip would add latency and ~86k rows/day/stream |
| ↳ Data client | **@supabase/supabase-js** | ^2.45 | service-role only, backend-side | Never exposed to the frontend (rule 25) |
| Relay / bridge | **FFmpeg** | in backend image | SRT↔RTMP egress, SRT caller/rendezvous ingest | `-c copy` by default: no transcode, no quality loss, near-zero CPU |
| Dashboard | **React 18 + Vite 5 + Tailwind 3** | — | Live panels, no login screen | 183 kB JS build; no routing needed with no auth boundary |
| Reverse proxy | **nginx-unprivileged** | `1.27-alpine` | TLS termination, WS upgrade, HLS proxy, JSON access logs | Unprivileged image binds 8443 in-container → host maps 443, so nothing runs as root (rule 3) |
| Orchestration | **Docker Compose** | project `livebridge` | 4 services, healthchecks (rule 6), `restart: unless-stopped` (rule 7) | — |
| Database | **Supabase (Postgres)** | free tier | `stream_keys`, `stream_sessions`, `relay_destinations`, `relay_events`, `event_log` | RLS enabled **and forced** on all 5 tables, zero policies = deny-by-default |
| Alt. runtime | **systemd units** | provided | non-Docker path | Documented in `systemd/README.md` |

### What this plan proposes adding

| Purpose | Technology | Cost | Why |
|---|---|---|---|
| Private network access | **Tailscale** (WireGuard) | Free | The only free option that carries UDP, so the only one SRT can use |
| TLS certificate | **Let's Encrypt via DNS-01** (e.g. `lego` or `certbot` + Cloudflare DNS plugin) | Free | Issues a trusted cert with **no inbound port** — works for a private-IP host |
| DNS + API | **Cloudflare DNS** for `krzn.site` | Free | Free API drives both the DNS-01 challenge and, if ever needed, DDNS |
| Operator UX | **PowerShell wrapper** `livebridge.ps1` | Free | `start` / `stop` / `status` / `logs` / `doctor` in one command |
| Optional public dashboard | **Cloudflare Tunnel** (`cloudflared`) | Free | HTTP-only supplement; explicitly *not* for media |

Everything proposed is either a host-level tool or a config change. **No new runtime dependency is
added to the backend or dashboard** — rule 14 stays satisfied.

---

## 7. Domain & TLS plan for `krzn.site`

**Target hostname: `stream.krzn.site`** — this also resolves two of the open questions still
sitting in PROGRESS.md (the `localhost` vs `stream.krzn.site` disagreement, and "TLS certificate
source").

1. Move/confirm `krzn.site` DNS on **Cloudflare** (free) — needed for the API-driven DNS-01 challenge.
2. Create `A` record `stream.krzn.site` → the Windows host's **Tailscale** `100.x.y.z`.
   Set it **DNS-only (grey cloud)**, not proxied — proxying a private IP cannot work.
3. Issue a Let's Encrypt cert by DNS-01 (a TXT record proves ownership; no port 80 needed).
4. Drop the cert into `nginx/certs/`, replacing the self-signed pair from
   `scripts/gen-selfsigned-cert.sh`.
5. Set `LIVEBRIDGE_HOST` and `LIVEBRIDGE_PUBLIC_HOST` to `stream.krzn.site` in `.env` so the
   **Encoder Endpoints** panel stops handing out `srt://localhost:9000/...`.
6. Schedule renewal (Let's Encrypt certs last 90 days) + an nginx reload.

**Caveat to verify, not assume:** some public DNS resolvers strip private/CGNAT-range answers
("DNS rebinding protection"), which would break a public `A` record pointing at `100.x.y.z`.
If that bites, the fallback is Tailscale MagicDNS or a `*.ts.net` name with Tailscale's own
free HTTPS certs — same result, less pretty hostname.

---

## 8. Bandwidth math — read this before choosing anything

At **6 Mbps** (typical 1080p30):

- **0.75 MB/s ≈ 2.7 GB/hour**
- A 2-hour service ≈ **5.4 GB**

| Scenario | Sustained upload needed |
|---|---|
| SRT in only (no relay) | ~6 Mbps down |
| Relay to YouTube | ~6 Mbps **up** |
| Relay to YouTube + Facebook | ~12 Mbps up |
| Relay to 3 platforms | ~18 Mbps up |
| 10 viewers pulling HLS directly from you | **~60 Mbps up** ❌ |

**Conclusions:**

- **Always relay to platforms; never serve the audience HLS from home.** One outbound copy per
  platform, and their CDN absorbs the audience. This is the whole point of Phase 7.
- Check your actual *upload* speed (not download) before committing to multi-platform relay.
- Each extra relay destination is another full copy of your upload budget.
- For reference: Oracle's 10 TB/month is ~3,700 hours at 6 Mbps. GCP's ~1 GB/month is ~22 minutes.

---

## 9. Ease-of-use work — safe, no exposure changes

These need no network decisions and can start immediately.

| # | Item | Effect | Gated? |
|---|---|---|---|
| A | `livebridge.ps1` — `start` / `stop` / `status` / `logs` / `doctor` | One command instead of remembering compose invocations | No |
| B | `doctor` preflight | Verifies Docker is up, ports are free, cert expiry, SRS API reachable **via the hyphenated alias**, Supabase reachable — one command diagnoses everything | No |
| C | Docker Desktop "start at login" + one `compose up -d` | `restart: unless-stopped` then restores all four services on boot automatically | **Yes — rule 11** |
| D | Disable sleep/hibernate (`powercfg`) | Stops Windows killing a live stream mid-service | **Yes — rule 11** |
| E | Desktop shortcut to `https://stream.krzn.site` | Removes the localhost + cert-warning ritual | No |
| F | Healthcheck that sends a **real `Host:` header** | Closes the exact blind spot that let the `livebridge_srs` underscore bug hide behind a "healthy" container for an entire session | No |

Item F is worth singling out: the current healthcheck probes over `/dev/tcp` with HTTP/1.0 and
**no Host header**, so it never exercises the parser path that real callers hit. A healthcheck that
does not exercise the same code path as real traffic proved worthless once already.

---

## 10. Rollout order

| Step | Work | Needs go-ahead? |
|---|---|---|
| **1** | **Prove ingest locally.** Point OBS at `rtmp://localhost:1935/live/<key>` on this machine and confirm media actually flows. | No |
| **2** | Ship items **A + B** (wrapper script + doctor) | No |
| **3** | Run the **CGNAT test** (Q3) — decides Option A vs B | No |
| **4** | Install Tailscale; verify `tailscale status` shows **`direct`**, not `relay` | No |
| **5** | Cloudflare DNS + `A` record + Let's Encrypt DNS-01 → real cert on `stream.krzn.site` | **Yes** — changes dashboard reachability |
| **6** | Set `LIVEBRIDGE_HOST` / `LIVEBRIDGE_PUBLIC_HOST`, restart, re-verify endpoints panel | No |
| **7** | Items **C + D + E** (autostart, no-sleep, shortcut) | **Yes** — restart/power behaviour |
| **8** | Item **F** (healthcheck fix) | No |
| **9** | End-to-end relay test with a real platform key | No |
| **10** | *Only if Q1 demands it:* Option B public ingest | **Yes — hard gate** |

**Step 1 is not optional and not reorderable.** No encoder has ever connected to this stack. Until
media has passed through it once, every networking decision above is being made on an unproven
foundation, and Phases 1, 2 and 7 remain genuinely unverified.

---

## 11. Open decisions needed from the operator

1. **Q1 — who sends streams in?** Only your own devices (→ Option A, done) or third parties
   (→ Option B, port forwarding, security review)?
2. **Q2 — where does the audience watch?** Platforms (relay) or directly from your box (HLS)?
3. **Is `krzn.site` DNS already on Cloudflare?** Their free API drives both the DNS-01 cert and DDNS.
4. **`AUTH_FAILURE_MODE`** — currently `open`. Must become `closed` if ingest is ever public.
   *(Carried over from PROGRESS.md open questions.)*
5. **Confirm `stream.krzn.site`** as the baked-in hostname, replacing `localhost`.
6. **Oracle Always Free** — genuinely out of scope, or worth a look as a $0 way to stop depending
   on this PC being awake?

---

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Windows Update reboots mid-service | High | Set active hours; pause updates before a service; item D |
| Home power/internet outage | High | Unmitigable without a second host (Option D) |
| Home upload too slow for multi-platform relay | High | Measure upload first (§8); cut destinations or bitrate |
| Behind CGNAT | Medium | Option A works anyway; Option B does not |
| Tailscale falls back to a relayed path | Medium | Check `tailscale status`; relay adds latency, which SRT feels |
| Public DNS strips the private-range `A` record | Medium | Fall back to MagicDNS / `*.ts.net` cert |
| Let's Encrypt renewal silently fails | Medium | `doctor` checks cert expiry (item B) |
| Cloudflare ToS on proxied video | Low | Keep video off the proxy; dashboard only |
| SRT loss/RTT metrics remain `n/a` | Low | Known and documented; bitrate + uptime + reconnect count are the working health signals |

---

## 13. ACTIVE PLAN — local WSL2 first, then AWS

### 13.1 Why WSL2 is the right local step

Docker Desktop already works here, so WSL2 is not about *making it run* — it is about **parity
with the AWS target**. An Ubuntu WSL2 distro is essentially the same environment as an Ubuntu EC2
instance: same shell, same paths, same permissions model, same `docker compose` invocations. Every
command learned locally transfers to AWS unchanged. Three concrete wins:

1. **Correct file permissions.** `srs/docker-entrypoint.sh` needs its executable bit, and the
   non-root users (uid 10001) need sane ownership. NTFS cannot express either.
2. **LF line endings.** A `CRLF` shebang in the entrypoint breaks the container with a confusing
   `no such file or directory`. ext4 + git on Linux avoids this class of bug entirely.
3. **Fast bind mounts.** `/mnt/c` bind mounts are slow; native ext4 is not.

### 13.2 Current state of this machine

| Fact | Value | Implication |
|---|---|---|
| Windows build | 10.0.19045 (Win 10 22H2) | **No mirrored networking** → see §0 warning |
| WSL version | 2.7.11.0 | Modern; fine |
| WSL distros installed | only `docker-desktop` (Stopped) | **No usable Linux distro yet** — must install Ubuntu |
| Docker contexts | `desktop-linux` (default) | Docker Desktop is installed… |
| Docker daemon | **not running** | …but currently stopped; nothing is up |
| Port bindings in `.env` | all `127.0.0.1` | Loopback-only; fine for a local test, unreachable from LAN |

### 13.3 What gets installed, and why *(rule 14)*

| Install | Size | Why it is needed |
|---|---|---|
| `Ubuntu-24.04` WSL distro | ~500 MB download / ~2 GB on disk | The Linux environment. 24.04 LTS chosen to match the intended AWS Ubuntu LTS AMI. |
| *(nothing else)* | — | Docker Desktop is already installed. No packages are added inside the distro; `docker` and `docker compose` are provided by Docker Desktop's WSL integration. |

**Explicitly NOT installed:** `docker.io` / `docker-ce` inside the distro. That is the bare-engine
path that breaks UDP on Windows 10 (§0).

### 13.4 Local steps

| # | Step | Gated? |
|---|---|---|
| 1 | `wsl --install -d Ubuntu-24.04 --no-launch`, then create the user *(may require a reboot)* | Needs go-ahead — system component |
| 2 | Start Docker Desktop → Settings → Resources → WSL Integration → enable for `Ubuntu-24.04` | No |
| 3 | Copy the project to `~/livebridge` on **ext4**, not `/mnt/c` | No |
| 4 | Normalise line endings to LF; `chmod +x scripts/*.sh srs/docker-entrypoint.sh` | No |
| 5 | Verify `.env` came across with mode `600` and is still gitignored | No |
| 6 | `docker compose up -d --build`; confirm all four services healthy | No |
| 7 | Confirm `https://localhost/` and `/api/health` report `srs_reachable: true` | No |
| 8 | **Connect OBS to `rtmp://localhost:1935/live/<key>`** — the long-standing blocker | No |
| 9 | Repeat with SRT on `9000/udp` — this is what proves the §0 concern is handled | No |

Steps 1–8 need **no change to port bindings**: OBS on this same PC reaches `127.0.0.1` fine.
Testing from a *second* device on the LAN would require changing the bind addresses to `0.0.0.0`
plus Windows Firewall rules — that is a port-exposure change and is **gated under rule 11**.

### 13.5 AWS notes for later *(not yet scoped)*

Recorded now because one choice materially changes cost:

- **EC2 charges egress at roughly $0.09/GB** beyond the 100 GB/month free allowance. At 6 Mbps
  that is ~2.7 GB/hour, so ~$0.24/hour per relay destination once free tier is used up.
- **Lightsail bundles bandwidth** — a flat monthly plan includes multiple TB of transfer. For a
  bandwidth-heavy, CPU-light workload like SRS passthrough, **Lightsail is usually far cheaper
  than EC2**, and it is still AWS. Worth pricing both before committing.
- **Graviton (`t4g`) is cheaper than `t3`** and all four images publish arm64 tags — but this is
  untested and would need verifying.
- Static address via **Elastic IP**; security group opens exactly `443/tcp`, `1935/tcp`, `9000/udp`.
- §8's bandwidth math applies with money attached now: **relay to platforms, never serve HLS to an
  audience directly**, or the egress bill scales with viewer count.

---

*Companion documents: [README.md](README.md) for setup and the security model,
[PROGRESS.md](PROGRESS.md) for the running build log and verification status.*
