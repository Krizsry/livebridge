# Live Bridge — Remote Contributor Access (Port Forwarding)

How to let someone in another province publish to this server, when Live Bridge
runs on a personal PC behind a home router.

---

## 1. Why it is local right now

Nothing was broken — the server was deliberately closed. There are **three
independent walls** between a remote encoder and SRS, and every one of them
blocks inbound traffic by default. Opening one or two is the usual reason
"I forwarded the port and it still doesn't work".

```
  Contributor (another province)
        |
        |  (1) ISP / CGNAT ......... is your public IP really yours?
        v
  Router  103.91.141.41  (WAN)
        |
        |  (2) NAT port forward .... router must be told where to send it
        v
  This PC  192.168.18.72  (LAN)
        |
        |  (3) Windows Firewall .... must allow the port inbound
        v
  Docker publish binding ........... .env SRT_BIND_ADDR / RTMP_BIND_ADDR
        |
        v
  SRS  :9000/udp  :1935/tcp
```

**Wall 1 — the stack bound to loopback.** `.env` had all three ports on
`127.0.0.1`. That is not "local network only" — it is *this PC only*. Another
laptop on the same desk could not reach it either.

**Wall 2 — NAT.** This PC's address, `192.168.18.72`, is private and does not
exist on the internet. Everything leaving the house appears to come from the
router's single public address. Inbound packets arriving at that address have no
way of knowing which machine inside the house they were meant for, so the router
drops them — unless you add a forwarding rule that says "UDP 9000 goes to
`192.168.18.72`".

**Wall 3 — Windows Firewall.** Blocks unsolicited inbound connections by default,
including ones the router forwarded correctly.

There is also a fourth issue that is not a wall but a moving target: **home IP
addresses change**. Whatever address you give a contributor today may belong to
someone else next week. That is what DDNS in §5 is for.

---

## 2. What changed

| Item | Before | After |
|---|---|---|
| `SRT_BIND_ADDR` | `127.0.0.1` | `0.0.0.0` |
| `RTMP_BIND_ADDR` | `127.0.0.1` | `0.0.0.0` |
| `HTTPS_BIND_ADDR` | `127.0.0.1` | `0.0.0.0`, firewalled to LAN only |
| Windows Firewall | no rules | `scripts/setup-port-forwarding.ps1` |
| Router forward | none | **manual — you must do this** |

### Exposure is deliberately asymmetric

| Port | Reach | Why |
|---|---|---|
| `9000/udp` SRT | **Internet** | Guarded by the SRT passphrase *and* the `on_publish` stream-key check. |
| `1935/tcp` RTMP | **Internet** | Guarded by the stream key only. RTMP is unencrypted — the key travels in clear. Prefer SRT for remote contributors. |
| `443/tcp` Dashboard | **LAN only** | **There is no login on the dashboard.** Anyone reaching it could create and delete stream keys, and add relay destinations pointed at their own server. It is scoped to `LocalSubnet` in the firewall, and you must **not** add a router forward for it. |

To reach the dashboard from outside the house, use a VPN (Tailscale) rather than
forwarding 443. Project rule 2 requires at least network-level restriction, and
with no password there is nothing else protecting it.

---

## 3. Setup

### Step 1 — check you are not behind CGNAT (do this first)

If your ISP puts you behind carrier-grade NAT, **no amount of port forwarding
will ever work**, and everything below is wasted effort. Check before you start:

1. Open the router admin page — `http://192.168.18.1`.
2. Find the **WAN** / **Internet** status page and read its IP address.
3. Compare it to your public IP: `103.91.141.41` (re-check at
   <https://api.ipify.org>).

| Router WAN IP | Meaning |
|---|---|
| Same as your public IP | Good — forwarding will work. |
| `100.64.x.x` – `100.127.x.x` | **CGNAT.** Forwarding is impossible. |
| `10.x.x.x`, `192.168.x.x`, `172.16–31.x.x` | Another NAT layer. Impossible as-is. |

If it is CGNAT, your options are: ask the ISP for a public/static IP (often a
small monthly fee, and the cleanest fix), or route contributors through
something with a real public address — Tailscale, or a small cloud VPS relay.

> This could not be checked automatically: the router has UPnP disabled, so it
> would not answer a `GetExternalIPAddress` query. It needs a human to look.

### Step 2 — reserve this PC's LAN IP

`192.168.18.72` came from DHCP and **can change when the PC reboots**. A router
forward points at a fixed address, so if the IP moves, the forward silently
starts pointing at some other device — and the failure looks exactly like a
broken forward.

In the router: **DHCP → Address Reservation** (names vary), bind
`192.168.18.72` to this PC's MAC address. Alternatively set a static IP on
Windows, but the reservation is harder to get wrong.

### Step 3 — Windows Firewall

Preview first — this changes nothing:

```powershell
.\scripts\setup-port-forwarding.ps1
```

Then, in an **elevated** PowerShell:

```powershell
.\scripts\setup-port-forwarding.ps1 -Apply
```

Creates three inbound rules: UDP 9000 and TCP 1935 from anywhere, TCP 443 from
the local subnet only. `-Remove` deletes them again.

### Step 4 — router forwarding

At `http://192.168.18.1`, find **Port Forwarding** / **Virtual Server** /
**NAT**. Add exactly these two:

| Protocol | External port | Internal IP | Internal port | Name |
|---|---|---|---|---|
| **UDP** | 9000 | 192.168.18.72 | 9000 | livebridge-srt |
| **TCP** | 1935 | 192.168.18.72 | 1935 | livebridge-rtmp |

> **SRT is UDP.** The protocol dropdown almost always defaults to TCP, and a TCP
> forward on 9000 fails *silently* — the encoder times out and nothing at all
> appears in the SRS log, because no packet ever arrives. This is the single most
> common mistake here. Check that dropdown twice.

Do **not** add a rule for 443.

### Step 5 — set the public hostname

The dashboard builds the connection strings it hands to contributors from
`LIVEBRIDGE_PUBLIC_HOST`. It is currently `localhost`, so a remote contributor
would be told to publish to `srt://localhost:9000` — which resolves to their own
machine and fails with no useful error.

Set it in `.env` to your DDNS hostname (§5) or your public IP:

```
LIVEBRIDGE_PUBLIC_HOST=stream.krzn.site
```

### Step 6 — restart and verify

```powershell
docker compose up -d
.\scripts\check-reachability.ps1
```

The checker walks all four layers and reports which one is blocking. Add
`-External` to have a third-party service probe TCP 1935 from the internet —
note that this discloses your IP and port to that service, which is why it is
off by default.

---

## 4. What a contributor uses

Replace `<HOST>` with your DDNS hostname or public IP.

**SRT — recommended for remote contributors** (encrypted, and survives packet
loss over long distances, which is exactly the inter-province case):

```
srt://<HOST>:9000?streamid=#!::r=live/<STREAM_KEY>,m=publish&passphrase=<SRT_PASSPHRASE>&latency=300
```

Raise `latency` for a worse link — 300 ms is a reasonable start for cross-country,
800–2000 ms for an unstable connection. Latency here buys retransmission time; too
low and packet loss becomes visible corruption.

**RTMP** — simpler, works everywhere, but unencrypted:

```
rtmp://<HOST>:1935/live/<STREAM_KEY>
```

In OBS: **Settings → Stream → Service: Custom**, put the URL in **Server** and
leave **Stream Key** empty for SRT (it is inside the `streamid`).

---

## 5. DNS / DDNS — `stream.krzn.site`

Home IPs rotate. Without this you will be messaging contributors a new IP address
every few days. `krzn.site` is already on Cloudflare nameservers
(`haley` / `ricardo.ns.cloudflare.com`), so the updater talks to the Cloudflare API.

Current state: the apex `krzn.site` points at Vercel (`64.29.17.65`,
`216.198.79.65`) — **untouched by any of this** — and `stream.krzn.site` does not
exist yet.

### 5.1 The one thing that will break it

**The record must be DNS-only (grey cloud), never proxied (orange cloud).**

Cloudflare's proxy only carries HTTP/HTTPS on a fixed port list. It cannot carry
SRT (UDP) or RTMP (1935/tcp) at all. A proxied record resolves to Cloudflare's
own IPs, so encoders connect to Cloudflare, which has no idea what to do with the
packets — and both protocols fail with nothing useful in any log.

The tradeoff is real and unavoidable: DNS-only publishes your home IP address to
anyone who resolves the hostname. That is inherent to self-hosting SRT; the proxy
is not an option here.

`scripts/ddns-update.ps1` always sets `proxied: false`, and warns loudly if it
finds an existing record proxied.

### 5.2 Create the API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Edit zone DNS**:

| Field | Value |
|---|---|
| Permissions | `Zone` · `DNS` · **Edit** |
| Permissions (add a 2nd row) | `Zone` · `Zone` · **Read** |
| Zone Resources | **Include → Specific zone → `krzn.site`** |

Scope it to that one zone. **Do not use the Global API Key** — that key has full
account access and cannot be limited or revoked independently.

Paste it into `.env`:

```
CLOUDFLARE_API_TOKEN=<the token>
CLOUDFLARE_ZONE=krzn.site
DDNS_RECORD=stream.krzn.site
```

`.env` is gitignored. The token is never printed by the script, and is redacted
from API error output.

### 5.3 Create the record

Preview — changes nothing:

```powershell
.\scripts\ddns-update.ps1
```

Then create it:

```powershell
.\scripts\ddns-update.ps1 -Apply
```

This creates `A stream.krzn.site → <your public IP>`, TTL 60, DNS-only. TTL 60 is
Cloudflare's floor and is what you want — when the IP rotates, contributors pick
up the new one within a minute.

### 5.4 Keep it updated automatically

In an **elevated** PowerShell:

```powershell
.\scripts\ddns-update.ps1 -Install
```

Registers a Scheduled Task running every 5 minutes as `SYSTEM`, so it updates
whether or not anyone is logged in. It only calls the API when the IP has actually
changed. Remove it with `-Uninstall`.

Check on it:

```powershell
Get-ScheduledTaskInfo -TaskName 'Live Bridge DDNS'
```

### 5.5 Point the stack at the hostname

In `.env`:

```
LIVEBRIDGE_PUBLIC_HOST=stream.krzn.site
```

Then `docker compose up -d`. The dashboard's Encoder Endpoints panel now hands
contributors a usable URL instead of `srt://localhost:9000`.

### 5.6 Verify

```powershell
Resolve-DnsName stream.krzn.site -Server 1.1.1.1
```

You want a single `A` record holding **your** public IP. If you see two addresses
in Cloudflare's ranges (`104.x`, `172.67.x`), the record is still proxied — turn
the cloud grey.

> **DNS alone proves nothing about reachability.** A correct record just means
> encoders now aim at the right address; the router forward still has to exist.
> DNS resolving is not the same as the port being open.

---

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Encoder times out, **nothing** in `docker logs livebridge_srs` | Packets never arrived. Router forward missing, set to TCP instead of UDP, or pointing at a stale LAN IP. Or CGNAT. |
| Works on the LAN, fails from outside | Router forward or CGNAT. Layers 1–3 are fine — `check-reachability.ps1` will confirm. |
| `srt disabled, vhost=__defaultVhost__` | SRS config regression, not a network problem. |
| Handshake / rejection immediately | Wrong SRT passphrase. |
| `on_publish` denied in the backend log | Stream key not registered, or wrong. |
| Was working, suddenly stopped | Public IP rotated (needs DDNS), or this PC's DHCP lease moved (needs the reservation from step 2). |

Watch the ingest live while a contributor tries:

```powershell
docker logs -f livebridge_srs
```

---

## 7. Security notes

- **Exposing ingest to the internet exposes it to everyone**, not just your
  contributor. The stream key and SRT passphrase are the only things standing in
  front of it. Treat them as passwords: strong, rotated when leaked, and never
  committed.
- **The SRT passphrase is currently one shared value for the whole listener** —
  SRS supports only one. Every contributor who has it can decrypt any other
  contributor's session. Per-contributor separation is by stream key only.
- **The passphrase in `.env` has been exposed in an earlier session transcript
  and still has not been rotated.** Rotate it with `scripts/gen-secrets.sh`
  before opening the port to the internet, and re-issue it to encoders.
- **Prefer SRT over RTMP for remote contributors.** RTMP sends its stream key in
  clear over the open internet.
- **Never forward 443.** The dashboard has no login.
- Watch upload bandwidth: each relay destination costs a full copy of the stream
  (~2.7 GB/hour at 6 Mbps). Inbound contribution costs download, which is usually
  the abundant direction on a home line — but outbound relays are not.
