# Live Bridge — NDI Output Plan (Phase 9)

> **Status: PROPOSAL. No code, config, `.env`, compose or schema changes have been made.**
> Everything here is gated on operator go-ahead (rule 11) — it adds a container, a network
> protocol, a dependency with a licence, and a large amount of LAN traffic.

---

## 0. What was asked for

> "each stream source will be its own NDI output and it can output all or selected stream.
> but make it all by default"

Restated as a spec:

1. Every live stream ingested by Live Bridge (SRT **or** RTMP) is exposed as its **own discoverable
   NDI source** on the local network.
2. The operator can turn NDI output on or off **per stream**.
3. **Default is ON for every stream** — a new stream key needs no configuration to appear as NDI.

All three are achievable. Points 1 and 3 are straightforward; the difficulty is entirely in *how*
the NDI frames get produced and *whether the LAN can discover them*, which is where the rest of this
document goes.

---

## 1. BLOCKING FINDING — FFmpeg cannot do NDI, so none of the existing relay code can be reused

**Verified on the running stack, not assumed:**

```
$ docker exec livebridge_backend ffmpeg -hide_banner -version
ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers

$ docker exec livebridge_backend ffmpeg -hide_banner -devices | grep -i ndi
NO NDI DEVICE FOUND

$ docker exec livebridge_backend ffmpeg -hide_banner -muxers | grep -i ndi
(only PCM muxers — the substring "ndi" matched inside "big-e-ndi-an")
```

The muxer grep is a good example of why this needed executing rather than eyeballing: it *appears*
to return hits, and every one of them is the letters `ndi` sitting inside the word "endian". There
is no NDI muxer and no NDI output device in this build.

**This is not fixable with a build flag.** FFmpeg carried an NDI wrapper (`libndi_newtek`) until it
was deprecated in 4.3 and **removed outright in 2021** over SDK licensing, and it has not returned.
Any FFmpeg you can `apk add` in 2026 — including the 8.1.2 in our image — has no NDI support and
never will.

**Consequence for this project:** `relay.js` spawns FFmpeg for every egress path we have
(`buildEgressArgs`, `buildIngressArgs`). **NDI cannot be added as another destination row in
`relay_destinations`.** It needs a different binary, which means a different process manager, and
almost certainly a different container. This is the single largest cost in the plan and it is
structural, not incidental.

---

## 2. How NDI actually works — the four constraints that shape everything below

NDI is not "another RTMP". Four properties drive every decision in this document:

| Property | Consequence for Live Bridge |
|---|---|
| **LAN-local by design.** Discovery is mDNS/Bonjour multicast on the local subnet. | NDI **does not traverse the internet**. It is useless on the AWS box. See §5. |
| **Very high bitrate.** Full NDI 1080p59.94 ≈ **110–140 Mbps per source**. | "All streams by default" has real bandwidth consequences. See §4. |
| **Uncompressed input.** The SDK takes raw frames and applies SpeedHQ itself. | Every NDI output must **fully decode** its source. Real CPU per stream — unlike `-c copy` relays, which cost almost nothing. |
| **Proprietary SDK with a EULA.** `libndi` is redistributable only under Vizrt's terms. | Cannot be baked into a committed image casually. See §8. |

The second and third points together are the important ones: an NDI output is roughly **20× the
bandwidth and vastly more CPU** than an existing relay destination. The current relay architecture
was explicitly built around `-c copy` costing "~0 CPU" (`relay.js` header comment). NDI breaks that
assumption completely, and the concurrency limit (`RELAY_MAX_CONCURRENT=16`) is meaningless for it.

---

## 3. Implementation options

### Option A ⭐ — GStreamer `ndisink` *(recommended)*

`gst-plugins-rs` (Centricular/Sebastian Dröge) ships a maintained `net/ndi` plugin providing
`ndisink` and `ndisinkcombiner`. Actively developed, Rust, and the de-facto way to send NDI from a
headless Linux service in 2026.

Pipeline shape, per stream:

```
rtmpsrc location=rtmp://livebridge-srs:1935/live/<KEY>
  ! flvdemux name=d
  d.video ! h264parse ! avdec_h264 ! videoconvert ! c.video
  d.audio ! aacparse  ! avdec_aac  ! audioconvert ! c.audio
  ndisinkcombiner name=c ! ndisink ndi-name="LIVEBRIDGE (<KEY>)"
```

- **Pro:** maintained; one process per stream, supervisable exactly like `relay.js` does today;
  pulls from SRS over the internal network with no changes to SRS.
- **Con:** adds GStreamer to the image (large), plus the NDI SDK runtime.
- ⚠️ **Element names above are from documentation, not from a build on this machine.** They must be
  confirmed with `gst-inspect-1.0 ndisink` before anything is written against them.

### Option B — Patched FFmpeg with `libndi_newtek` restored

Rebuild FFmpeg from source with the removed wrapper patched back in.

- **Pro:** would slot into the existing `relay.js` with minimal new code.
- **Con:** resurrecting code upstream deleted five years ago, unmaintained against modern FFmpeg,
  and the licensing objection that caused its removal still applies. **Not recommended** — it trades
  a one-time integration cost for a permanent maintenance liability.

### Option C — Custom sender against the NDI SDK directly

Write a small C/Rust/Python service using the SDK's send API.

- **Pro:** total control; smallest runtime.
- **Con:** most work by far, and we would own frame timing, A/V sync and clocking — all of which
  GStreamer already solves. Only worth it if Option A proves unworkable.

**Recommendation: Option A.** Fall back to C only if `ndisink` fails verification.

---

## 4. Bandwidth and CPU — read before agreeing to "all by default"

Per 1080p source, full NDI:

| Streams | LAN bandwidth | Fits gigabit? |
|---|---|---|
| 1 | ~125 Mbps | yes |
| 4 | ~500 Mbps | yes, half the link |
| 7 | ~875 Mbps | **saturated** — a gigabit LAN is ~940 Mbps practical |
| 8+ | >1 Gbps | **impossible without 2.5G/10G** |

Plus roughly **0.5–1 CPU core per stream** for H.264 decode + colour conversion + SpeedHQ encode.

**I am building "all by default" as you asked** — but with two guardrails, because the failure mode
otherwise is that the seventh stream silently degrades *every other NDI source on the network*
including ones already on air:

1. `NDI_MAX_OUTPUTS` (proposed default **6**) — beyond this, further outputs are refused and logged
   at `critical` rather than started. Explicit refusal, never silent degradation.
2. The dashboard shows a running total of estimated NDI bandwidth against a configured link
   capacity, so the ceiling is visible before it is hit.

**Note this differs deliberately from the Preview player decision (2026-08-16 14:05)**, which is
opt-in precisely to avoid multiplying bandwidth. That reasoning does **not** transfer here, and the
distinction matters: browser preview consumes the operator's scarce *WAN upload*, whereas NDI
consumes *LAN* capacity, which is free and plentiful up to the ceiling above. **Default-on is the
right call for NDI and the wrong call for preview.** Same-looking decision, opposite answer.

---

## 5. ⚠️ Conflict with the hosting decision made 2026-08-17

The 2026-08-17 08:46 entry records the operator's decision to run Live Bridge **both** on this
Windows PC and on AWS Lightsail.

**NDI output is meaningless on the Lightsail box.** NDI discovery is LAN multicast and its bitrate
is ~125 Mbps per source; there is no LAN there to serve, and pushing that over the internet is both
technically impossible without NDI Bridge and financially absurd at Lightsail egress rates.

**Therefore NDI is a local-deployment feature only.** The plan below makes it opt-in per deployment
via `NDI_ENABLED`, defaulting to **on locally / off on AWS**. This is not a limitation of the
design — it is what NDI is. Worth stating plainly so it is not discovered later as a "bug".

---

## 6. ⚠️ The discovery problem — the most likely way this silently fails

This project has now been bitten **three times** by a green, healthy-looking stack with a dead
feature: the SRS hostname-underscore bug, the `srt disabled` vhost bug, and the duplicate backend
container. NDI discovery is the next candidate, and for the same reason — nothing about it surfaces
in a healthcheck.

**The problem:** NDI finds sources via **mDNS multicast on UDP 5353**. Multicast does **not** cross
a Docker bridge network. A container sending NDI on the default `livebridge_net` will be running
perfectly, reporting healthy, logging frames sent — and be **completely invisible** to vMix or OBS
on the LAN.

**It is worse on Windows.** Docker Desktop runs containers inside a Linux VM, so even
`network_mode: host` attaches to the *VM's* network, not the Windows machine's LAN. Whether Docker
Desktop's newer host-networking support carries multicast to the physical LAN is **unverified and I
would not bet the feature on it.**

### ✅ RESOLVED 2026-08-17 — tested, and the containerised approach is IMPOSSIBLE on this machine

This was tested before building anything. **The risk was real and it is fatal to the container
design.** Measured, not reasoned:

| Where | IPv4 address seen |
|---|---|
| Container, default bridge | `172.17.0.2` |
| Container, `--network host` | `192.168.65.6`, `192.168.65.3` (**Docker Desktop VM subnet**) |
| **Windows host, real LAN** | **`192.168.18.72`** (+ `172.25.192.1` for WSL) |
| Windows → `192.168.65.6` | **UNREACHABLE — no route** |

Outbound pings from a container succeed (that is just NAT) and prove nothing: **NDI requires the
receiver to connect *inbound* to the sender**, and an NDI sender advertises its own address. A
container can only ever advertise `172.17.x` or `192.168.65.x`.

**Therefore a `livebridge_ndi` container cannot serve any NDI receiver — not on the LAN, and not
even on this same Windows PC**, because Windows itself has no route to the Docker VM subnet.
`--network host` does not help: on Docker Desktop it attaches to the Linux VM, not to Windows.

This is *not* fixable with the NDI Discovery Server. A discovery server fixes **discovery**; it does
not fix **reachability**, and reachability is what is broken here.

### Revised architecture — native Windows agent (was fallback, is now the only option)

NDI senders must run **as a native Windows process**, outside Docker, so they advertise
`192.168.18.72` and are reachable and discoverable by vMix/OBS normally. They pull from
`rtmp://127.0.0.1:1935/live/<key>`, which Docker already publishes to the host and which is
**proven working** (2026-08-16 13:35).

```
   livebridge_srs (container) ──RTMP──▶ 127.0.0.1:1935 (published to Windows)
                                              │
                                              ▼
                              livebridge-ndi-agent  ★ NATIVE WINDOWS PROCESS
                              one sender per live stream
                                              │ NDI on 192.168.18.72
                                              ▼
                              vMix / OBS / Studio Monitor on the LAN
```

The backend keeps owning **state** (which streams are NDI-enabled) and the agent owns **process
supervision**, polling `/api/ndi` for its work list. Consequences, stated honestly:

- The `docker compose up` single-command story is lost for NDI. Everything else is unchanged.
- Rule 3 (non-root in containers) does not apply to a process that is not in a container; the agent
  runs as the logged-in user.
- **~80% of the phase is unaffected**: the migration, override semantics, API routes and dashboard
  panel are identical either way. Only the sender's host and packaging change.

---

## 7. Proposed architecture

```
                    ┌──────────────────────────────────────┐
   encoder ──SRT──▶ │  livebridge_srs                      │
   encoder ──RTMP─▶ │  (unchanged)                         │
                    └───────────┬──────────────────────────┘
                                │ internal RTMP pull
                    ┌───────────▼──────────────────────────┐
                    │  livebridge_ndi          ★ NEW       │
                    │  GStreamer + NDI SDK                 │
                    │  one pipeline per live stream        │
                    └───────────┬──────────────────────────┘
                                │ NDI (LAN)
                    ┌───────────▼──────────────────────────┐
                    │  vMix / OBS / TriCaster / Studio Mon │
                    └──────────────────────────────────────┘

   livebridge_backend  ──supervises──▶ livebridge_ndi (start/stop per stream)
```

**Key decision: the backend stays the brain.** It already knows exactly when a stream goes live and
offline (`onStreamOnline` / `onStreamOffline` in `relay.js`, driven by the SRS `on_publish` /
`on_unpublish` hooks). NDI outputs hook into those same two functions. No new detection logic, no
polling, no second source of truth about what is live.

New module `backend/src/ndi.js`, deliberately mirroring `relay.js`:
- one child process per NDI output, argv **array** only, `shell: false` (rule 8);
- exponential-backoff restart, reusing the same backoff config;
- **the spawn-identity guard and the `stopRelay` capture-the-dying-child fix must be carried over.**
  Both were real bugs found the hard way in `relay.js`; a fresh copy of that file's structure
  without them would reintroduce both.

---

## 8. Dependencies added (rule 14)

| Package | Why | Where |
|---|---|---|
| `gstreamer` + `gst-plugins-base/good/bad/libav` | pipeline, H.264/AAC decode | new `ndi/Dockerfile` only |
| `gst-plugin-ndi` (from gst-plugins-rs) | the `ndisink` element | same |
| **NDI SDK runtime** (`libndi`) | required by `ndisink` | same |

Two things to flag:

- **Nothing is added to the backend or SRS images.** The NDI container is separate, so if NDI is
  disabled the rest of the stack is byte-for-byte what it is today.
- ⚠️ **The NDI SDK has a licence (Vizrt EULA) and is not freely redistributable.** It must be
  downloaded at build time with the EULA accepted, or mounted from the host — **not committed to
  this repo**. Needs an explicit operator decision, and a `.gitignore` entry so an SDK tarball
  cannot be committed by accident (rule 1).

---

## 9. Data model — "all by default" stored as *overrides*, not enrolments

New table `ndi_outputs`. The important design choice:

> **A missing row means ENABLED.** The table stores *exceptions*, not memberships.

```sql
create table if not exists public.ndi_outputs (
    id            uuid primary key default gen_random_uuid(),
    stream_key    text not null unique
                  constraint ndi_outputs_key_format
                  check (stream_key ~ '^[A-Za-z0-9_-]{3,64}$'),
    enabled       boolean not null default true,   -- a row with false = opt-OUT
    ndi_name      text,                            -- null = derive from stream_key
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
```

Why overrides rather than enrolments — three independent reasons:

1. **It makes "all by default" literally true.** A brand-new stream key needs no row and no
   dashboard visit to appear as NDI.
2. **It satisfies rule 29 / requirement 21 for free.** If Supabase is unreachable, there are no
   rows, so *every stream is enabled* — which is the documented default. An enrolment model would
   fail the opposite way: a Supabase outage would silently produce **zero** NDI outputs mid-service.
   That is precisely the class of failure rule 29 exists to prevent.
3. Deleting a stream key leaves no orphaned NDI config to clean up.

RLS enabled and forced, zero policies, grants revoked from `anon`/`authenticated` — identical to the
other five tables (rule 26), in a new migration under `supabase/migrations/` (rule 28).

---

## 10. API surface

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/ndi` | every live stream, its NDI status, source name, bitrate estimate, last error |
| `PATCH` | `/api/ndi/:streamKey` | `{ enabled: bool }` — writes/clears the override row, starts or stops immediately |
| `POST` | `/api/ndi/:streamKey/restart` | manual restart of a wedged pipeline |
| `GET` | `/api/ndi/health` | SDK loaded, discovery mode, active output count, aggregate bandwidth |

Every route validated through the existing `validate.js` (rule 8). `stream_key` reuses the existing
`^[A-Za-z0-9_-]{3,64}$` pattern, so path traversal and shell metacharacters are rejected by the same
tested code that guards `on_publish`.

---

## 11. Dashboard

New `NdiPanel.jsx` beside the Active Relays panel:

- one row per live stream: NDI source name, status pill, resolution/fps, restart count, last error;
- a per-stream toggle (this is "output all or selected");
- a header showing `N of M streams → ~X Mbps of Y Mbps LAN capacity`, amber past 70%, red past 90%;
- when `NDI_ENABLED=false` the panel renders a single explanatory line rather than vanishing, so
  "NDI is off" is never confusable with "NDI is broken".

---

## 12. Environment variables (rule 17 — all to be added to `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `NDI_ENABLED` | `true` locally, `false` on AWS | master switch |
| `NDI_DEFAULT` | `all` | `all` \| `none` — what an un-overridden stream does |
| `NDI_SOURCE_PREFIX` | `LIVEBRIDGE` | NDI sources appear as `LIVEBRIDGE (<stream_key>)` |
| `NDI_MAX_OUTPUTS` | `6` | hard ceiling; refuses beyond, never degrades silently |
| `NDI_DISCOVERY_SERVER` | *(empty)* | unicast discovery server; empty = mDNS |
| `NDI_LAN_CAPACITY_MBPS` | `1000` | denominator for the dashboard bandwidth gauge |
| `GST_DEBUG` | `2` | GStreamer log level |

---

## 13. Build order

Each step is independently testable, and **step 1 is the gate** — if it fails, Option A is dead and
we go to Option C before writing any integration code.

| # | Step | Proves |
|---|---|---|
| **1** | **Spike only:** build the NDI image, run `gst-inspect-1.0 ndisink`, send one hardcoded test pattern, **see it in a real NDI receiver on the LAN** | `ndisink` exists and works, **and discovery actually reaches the LAN** — the §6 risk, retired first |
| 2 | Pipeline from a real SRS stream instead of a test pattern | A/V sync, decode, correct colour |
| 3 | `ndi.js` process manager + supervision, carrying over both `relay.js` bug fixes | start/stop/restart/backoff |
| 4 | Wire into `onStreamOnline` / `onStreamOffline` | default-all works with zero configuration |
| 5 | Migration + RLS + override semantics | Supabase-down still yields all-enabled |
| 6 | API routes + validation | per-stream selection |
| 7 | Dashboard panel | operator control |
| 8 | Multi-stream load test at `NDI_MAX_OUTPUTS` | the ceiling refuses cleanly |

**Step 1 must not be skipped.** It is roughly an hour of work and it retires the single risk most
likely to make this whole phase worthless.

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **NDI invisible on LAN from Docker on Windows** | **High** | Step 1 gate; discovery server; native sidecar fallback (§6) |
| `ndisink` element names differ from docs | Medium | Verified in step 1 before code is written |
| NDI SDK licence blocks image build | Medium | Build-time download w/ EULA, or host mount; operator decision |
| Bandwidth saturation takes out on-air sources | **High** | `NDI_MAX_OUTPUTS`, dashboard gauge, explicit refusal |
| CPU exhaustion starves ingest | **High** | NDI is decode-heavy; cap outputs; **ingest must never be starved by a preview feature** |
| Someone adds NDI as a `relay_destinations` row | Low | Cannot work (§1); reject at validation with a clear message |

---

## 15. Open decisions needed before implementation

- [ ] **Go-ahead for the step-1 spike?** It is throwaway and changes nothing in the running stack.
- [ ] **NDI SDK acquisition** — build-time download with EULA acceptance, or host mount?
- [ ] **Discovery: mDNS or Discovery Server?** Recommend the server; needs one config change in
      vMix/OBS on each receiving machine.
- [ ] **What receives the NDI?** vMix, OBS, TriCaster, Studio Monitor — determines what step 1 is
      tested against, and whether NDI|HX is worth investigating later.
- [ ] **`NDI_MAX_OUTPUTS` default of 6** — accept, or set from your actual LAN?
- [ ] **Confirm NDI stays off on AWS** (§5).
- [ ] **How many simultaneous streams do you actually expect?** Drives whether gigabit is enough.
