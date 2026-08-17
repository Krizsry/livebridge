# Live Bridge — Windows Installation & Requirements

Setup guide for running Live Bridge on Windows, including NDI output.

Every command and version in this document was **executed and verified on 2026-08-17** unless
explicitly marked otherwise. Where something is unverified, it says so — do not assume it works.

---

## 1. Hardware requirements

Sizing is driven almost entirely by **NDI**, which is ~20× heavier than everything else combined.
Ingest, HLS and platform relays are nearly free by comparison (relays run `-c copy`: no decode).

### Per-stream cost at 1080p

| Component | CPU | RAM | Network |
|---|---|---|---|
| SRT/RTMP ingest (SRS) | ~0.1 core | small | 6 Mbps in |
| HLS + HTTP-FLV remux | ~0.05 core | small | — |
| Relay to YouTube/FB (`-c copy`) | ~0.05 core | ~100 MB | 6 Mbps up per destination |
| **NDI output** | **~0.8–1.2 cores** | **~300–400 MB** | **~125 Mbps** |

### Recommended by stream count

| Streams | CPU | RAM | Network |
|---|---|---|---|
| 1–2 | 4 cores | 16 GB | gigabit |
| 3–4 | 8 cores | 16–32 GB | gigabit (tight) |
| **8** | **16 cores** | **32 GB** | **10 GbE** ⚠️ |

⚠️ **The network is the real ceiling at 8 streams.** 8 × 125 Mbps ≈ **1000 Mbps — a saturated
gigabit link**, with nothing left for ingest, relay egress or the dashboard.

**The cheapest fix is to output NDI at 720p instead of 1080p:**

| | 1080p | 720p |
|---|---|---|
| Per stream | ~125 Mbps | ~65 Mbps |
| 8 streams | ~1000 Mbps → **needs 10 GbE** | **~520 Mbps → fits gigabit** |
| CPU (8 streams) | ~7–10 cores | ~4–6 cores |

If your NDI feeds are for monitoring, multiview, or a source that gets re-encoded downstream, 720p
is usually indistinguishable in practice and removes the 10 GbE requirement entirely.

### Notes on specific hardware

- **Storage is NOT a bottleneck.** 8 streams write ~6 MB/s of HLS segments, and with
  `hls_cleanup on` the live footprint is ~70 MB total. **Any 1 TB SSD is fine.** Capacity only
  matters if you enable recording (~43 GB per 2-hour service at 8 streams).
- **The GPU barely matters.** NDI's SpeedHQ encoding is **CPU-only** in the NDI SDK. NVDEC can
  offload H.264 decode, but frames must be copied back to system memory for NDI, eating much of the
  gain. Buy cores and RAM, not a GPU.
- **Laptops:** two cautions. Most have 1 GbE or WiFi only — **WiFi is unusable for NDI**, not merely
  slow — so budget for a Thunderbolt/USB4 → 10 GbE adapter if you need 1080p. And sustained
  multi-core load for a 2-hour service will thermally throttle most laptops by 30–40%.
- **8 GB is not enough.** Measured on the original machine: at 8 GB with 94% commit charge, a 720p
  NDI sender died with `GLib-ERROR: failed to allocate 1843343 bytes` — exactly one 1280×720 UYVY
  frame. Only 320×180 was sustainable.

---

## 2. Software prerequisites

| Software | Version | winget ID | Required for |
|---|---|---|---|
| **Windows** | 10 build 19041+ / 11 | — | WSL2 needs 19041 or newer |
| **WSL2** | 2 | *(built in)* | **required by Docker Desktop** |
| **Docker Desktop** | 4.86+ | `Docker.DockerDesktop` | SRS, backend, dashboard, nginx |
| **Git for Windows** | current | `Git.Git` | `openssl` for certs; Git Bash |
| **NDI Runtime** | 6.x | `NDI.NDIRuntime` | NDI output |
| **GStreamer** | 1.26.11 or 1.28.5 | `gstreamerproject.gstreamer` | NDI output |
| *(optional)* DistroAV | 6.2.1 | `DistroAV.DistroAV` | NDI **receiving** in OBS |

### Yes — WSL2 and Docker are both required

Docker Desktop on Windows runs its containers inside a **WSL2 Linux VM**. There is no way around
it: SRS, the backend, the dashboard and nginx are all Linux containers. On a fresh machine WSL2 must
be installed **and the machine rebooted** before Docker Desktop will start.

**The NDI agent is the one exception — it runs natively on Windows, outside Docker.** That is not a
preference; a container cannot serve NDI at all on Windows. See §5 for the measured evidence.

### GStreamer version

Either **1.26.11** or **1.28.5** works. 1.26.11 is the version this project actually verified NDI
against; 1.28.5 is what `winget` currently installs.

> **Correction:** an earlier draft of this guide claimed "1.28.x has no Windows MSI". That was
> wrong — only the **1.28.6** directory is empty. 1.28.5 exists and is on winget.

**The version does not matter; the capability does.** What matters is that the build ships the NDI
plugin and can load `libndi`. `install-windows.ps1` checks exactly that and fails loudly if not.

---

## 3. Installation

### 3.0 ⭐ Automated (recommended)

From an **elevated** PowerShell in the project root:

```powershell
.\scripts\install-windows.ps1
```

It installs WSL2, Docker Desktop, Git, the NDI runtime and GStreamer via winget, adds the firewall
rules, puts GStreamer on `PATH`, and verifies the NDI plugin actually loads.

- **Idempotent** — checks before each step, safe to re-run after a reboot or partial failure.
- **Fails fast** — refuses to start unless elevated, rather than dying at exit code 1603 halfway
  through (verified).
- `-WhatIf` reports what it would do, changing nothing.
- `-SkipNdi` for a machine that ingests and relays but produces no NDI.

If WSL2 was newly installed the script stops and tells you to **reboot, then re-run**.

The manual steps below are the fallback, and document what the script does.

### 3.1 Docker Desktop *(manual fallback)*

**WSL2 first** — Docker Desktop will not start without it. Elevated PowerShell:

```powershell
wsl --install --no-distribution
wsl --set-default-version 2
```

**Reboot before continuing.** Docker Desktop supplies its own `docker-desktop` distro, so
`--no-distribution` avoids installing an Ubuntu you don't need.

Then install Docker Desktop:

```powershell
winget install --id Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements
```

Enable the **WSL2 backend** and allocate memory in Settings → Resources. On a 32 GB machine,
**8 GB to Docker** leaves ample headroom for the native NDI agent, which runs outside Docker (§5).

### 3.2 NDI Runtime

Install **NDI Tools** from [ndi.video/tools](https://ndi.video/tools) — free, and it bundles the
runtime plus **Studio Monitor**, which you need for verification in §6.

Confirm it landed:

```powershell
Test-Path 'C:\Program Files\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll'
Get-ChildItem Env: | Where-Object { $_.Name -like '*NDI*' }
```

Expect `True` and `NDI_RUNTIME_DIR_V6` set.

### 3.3 GStreamer

**Must be run from an elevated (Administrator) PowerShell.** A non-elevated install fails with
exit code **1603** (HKLM writes denied, MSI errors 1708/1709) — verified.

```powershell
$msi = "$env:TEMP\gstreamer-1.26.11.msi"
Invoke-WebRequest -UseBasicParsing -OutFile $msi `
  'https://gstreamer.freedesktop.org/data/pkg/windows/1.26.11/msvc/gstreamer-1.0-msvc-x86_64-1.26.11.msi'
Start-Process msiexec.exe -Wait -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart', 'ADDLOCAL=ALL')
```

Installs to `C:\gstreamer\1.0\msvc_x86_64\`. Add its `bin` to `PATH`:

```powershell
[Environment]::SetEnvironmentVariable('PATH',
  "$env:PATH;C:\gstreamer\1.0\msvc_x86_64\bin", 'Machine')
```

> **No Rust, no Visual Studio Build Tools, no compilation.** The official GStreamer Windows build
> already ships the NDI plugin (`gst-plugin-ndi` 0.14.5, from gst-plugins-rs). This was verified;
> earlier estimates of a 5–8 GB toolchain were wrong.

**Portable alternative if you cannot get admin rights:** unpack the MSI without installing —

```powershell
Start-Process msiexec.exe -Wait -ArgumentList @('/a', "`"$msi`"", '/qn', 'TARGETDIR=C:\gst')
```

This needs no elevation and produces a working relocatable tree. Set `PATH` and `GST_PLUGIN_PATH`
manually. Verified working.

### 3.4 Firewall rules

Elevated PowerShell:

```powershell
netsh advfirewall firewall add rule name="NDI discovery" dir=in action=allow protocol=UDP localport=5353
netsh advfirewall firewall add rule name="NDI media"     dir=in action=allow protocol=TCP localport=5960-5970
```

Also allow inbound for the encoder-facing ports if contributors are remote:

```powershell
netsh advfirewall firewall add rule name="Live Bridge RTMP" dir=in action=allow protocol=TCP localport=1935
netsh advfirewall firewall add rule name="Live Bridge SRT"  dir=in action=allow protocol=UDP localport=9000
```

> **Honest note:** these NDI rules were added and verified enabled, but NDI worked in testing
> *before and after* with no observable difference, so their necessity is **unproven**. They are
> harmless and standard; keep them.

### 3.5 Live Bridge itself

```bash
cp .env.example .env
./scripts/gen-secrets.sh          # generates SRT passphrase + stream keys
./scripts/gen-selfsigned-cert.sh  # or install a real cert
docker compose up -d
```

Every variable is documented in `.env.example`. At minimum set `LIVEBRIDGE_HOST` and
`LIVEBRIDGE_PUBLIC_HOST` to the machine's LAN IP or hostname — **not `localhost`**, or the
connection strings the dashboard hands out will only work on the server itself.

Verify:

```powershell
docker ps --format '{{.Names}}`t{{.Status}}'
```

Expect four containers, all `(healthy)`: `livebridge_srs`, `livebridge_backend`,
`livebridge_dashboard`, `livebridge_nginx`.

---

## 4. Ports

| Port | Proto | Purpose | Exposure |
|---|---|---|---|
| 1935 | TCP | RTMP ingest | encoders |
| 9000 | UDP | SRT ingest | encoders |
| 443 | TCP | Dashboard (HTTPS) | ⚠️ no app-level login — restrict or add auth |
| 5353 | UDP | NDI discovery (mDNS) | LAN only |
| 5960–5970 | TCP | NDI media | LAN only |
| 1985, 8080 | TCP | SRS API / HLS | **internal only — never publish** |

---

## 5. ⚠️ NDI must run OUTSIDE Docker on Windows

**This is not a preference — a container physically cannot serve NDI on Windows.** Measured:

| Where | IPv4 seen |
|---|---|
| Container, bridge network | `172.17.0.2` |
| Container, `--network host` | `192.168.65.6` (Docker Desktop **VM** subnet) |
| Windows host, real LAN | `192.168.18.72` |
| Windows → `192.168.65.6` | **no route** |

NDI receivers connect **inbound** to a sender that advertises its own address. A container can only
advertise an address unreachable from the LAN **and from the Windows host itself**. `--network host`
attaches to the Linux VM, not to Windows. The NDI Discovery Server does not help — it fixes
*discovery*, not *reachability*.

**Therefore:** SRS/backend/dashboard/nginx run in Docker; the **NDI agent runs natively on Windows**,
pulling from `rtmp://127.0.0.1:1935/live/<KEY>` (already published to the host).

*(On native Linux this restriction disappears — `network_mode: host` genuinely joins the host LAN.)*

### The working pipeline

Verified end-to-end against a real ingested stream:

```
rtmpsrc location=rtmp://127.0.0.1:1935/live/<KEY>
  ! flvdemux name=d
  d.video ! queue ! h264parse ! avdec_h264 ! videoconvert
          ! video/x-raw,format=UYVY ! ndisinkcombiner name=c
          ! ndisink ndi-name="LIVEBRIDGE <KEY>"
  d.audio ! queue ! aacparse ! avdec_aac ! audioconvert ! audioresample
          ! audio/x-raw,format=F32LE,rate=48000,channels=2 ! c.audio
```

**Both `queue` elements are mandatory.** Without them `flvdemux` deadlocks — the pipeline hangs at
`PREROLLING`, never reaches `PLAYING`, and no NDI source is ever created.

---

## 6. Verification

### 6.1 Plugin loads

```powershell
gst-inspect-1.0 ndi
```

Expect 5 features: `ndisink`, `ndisinkcombiner`, `ndisrc`, `ndisrcdemux`, `ndideviceprovider`.

### 6.2 Send a test pattern

```powershell
gst-launch-1.0 videotestsrc is-live=true pattern=smpte `
  ! video/x-raw,format=UYVY,width=1280,height=720,framerate=30/1 `
  ! ndisinkcombiner name=c ! ndisink ndi-name="LIVEBRIDGE TEST" `
  audiotestsrc is-live=true ! audioconvert ! audioresample `
  ! audio/x-raw,format=F32LE,rate=48000,channels=2 ! c.audio
```

Must reach `Setting pipeline to PLAYING`. If it dies with `failed to allocate`, the machine is out
of memory.

### 6.3 Receive it back

In a second terminal — **use the full machine-qualified name**:

```powershell
gst-launch-1.0 -v ndisrc ndi-name="$env:COMPUTERNAME (LIVEBRIDGE TEST)" `
  ! ndisrcdemux name=e e.video ! queue `
  ! fpsdisplaysink video-sink=fakesink text-overlay=false sync=false
```

Success looks like:

```
rendered: 234, dropped: 0, current: 14.99, average: 15.12
```

### 6.4 Confirm on the receiving machine ✋

**No command substitutes for this.** On the vMix / OBS PC, open **NDI Studio Monitor** and confirm
`<MACHINE> (LIVEBRIDGE TEST)` appears in the source list.

> ⚠️ **Discovery by browsing is UNVERIFIED.** Every successful test so far connected by *explicit
> name*; `gst-device-monitor-1.0` never listed the source. Whether vMix/OBS can *find* sources by
> browsing is the one thing still untested. If they cannot, look at mDNS/firewall or configure an
> **NDI Discovery Server** on both ends.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Could not demultiplex stream` / `EOS without available srcpad(s)` on the **receiver** | **Two unrelated causes.** (a) wrong source name; (b) the *sender* never started. The message points at the receiver and is misleading. | Use the full `MACHINE (Source)` name; check the sender reached `PLAYING`. |
| Pipeline stuck at `PREROLLING`, never `PLAYING` | Missing `queue` after a `flvdemux` pad → demuxer deadlock | Add `queue` to **both** branches |
| `GLib-ERROR: failed to allocate <n> bytes` | Out of RAM (`n` ≈ width × height × 2) | Free memory, lower resolution, or add RAM |
| MSI install fails, exit **1603** | Not running as Administrator | Elevated shell, or use `msiexec /a` (§3.3) |
| NDI source invisible to LAN | Agent running inside Docker | Run it natively on Windows (§5) |
| Every publish rejected, nothing in logs | SRS hostname contains an underscore — its HTTP client rejects such hosts silently | Use hyphenated network aliases, never underscored `container_name` |
| SRT connects then drops, error 6006 | `srt { enabled on; }` missing from the **vhost** block | Listener-level `enabled` is not sufficient |

---

## 8. Known limitations

1. **One SRT passphrase for all contributors.** SRS supports a single listener-wide passphrase.
   Revoking one person means rotating it for everyone. Per-key `secret` is the better revocation
   lever.
2. **One stream key = one live stream.** Give two people the same key and the second is silently
   refused.
3. **Dashboard has no login.** Restrict port 443 by firewall/VPN, or add Basic Auth at nginx.
4. **NDI is LAN-only.** It does not traverse the internet; there is no point running it on a cloud
   host.
5. **NDI|HX is not available.** `ndisink` uses the standard SDK send API (full-bandwidth SpeedHQ).
   HX would cut bandwidth to ~8–20 Mbps but needs the Advanced SDK — **unverified whether `ndisink`
   supports it at all.**
