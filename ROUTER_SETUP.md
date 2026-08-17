# Live Bridge — Router Port Forwarding (PLDT ZTE)

Step-by-step for **this** setup. No DNS — contributors connect to the raw public IP.

| | |
|---|---|
| Router | PLDT ZTE, admin at `http://192.168.18.1` |
| This PC (LAN) | `192.168.18.72` |
| Public IP | `103.91.141.41` |
| Ports to open | **UDP 9000** (SRT), **TCP 1935** (RTMP) |
| Do **not** open | 443 — the dashboard has no login |

Everything on the PC is already done — Docker publishes on `0.0.0.0`, Windows Firewall allows
both ports, the passphrase is rotated. **Only the router is left.**

---

## Step 1 — Log in as superadmin

Go to `http://192.168.18.1`.

PLDT's ZTE units ship with a **limited `admin` account that has no Port Forwarding menu at
all**. If you log in and can't find it, you're not looking in the wrong place — it's hidden
from that account. Try these:

| Username | Password |
|---|---|
| `adminpldt` | `1234567890` |
| `admin` | (printed on the router sticker) |
| `adminpldt` | `pldtadmin` |
| `admin` | `1234` |

If none work, call **PLDT 171** and ask for the superadmin credentials for your ONT. It's your
device; they can provide or reset them.

---

## Step 2 — Check the WAN IP ⛔ STOP-OR-GO

**Do this before anything else.** If PLDT has you behind carrier-grade NAT, no forwarding rule
can ever work and steps 3–5 are wasted effort.

Go to **Status → WAN** (or Network → WAN → Connection Status) and read the IPv4 address.

| What you see | Meaning |
|---|---|
| `103.91.141.41` | ✅ **Go.** Continue to step 3. |
| `100.64.x.x` … `100.127.x.x` | ❌ **CGNAT. Stop.** |
| `10.x.x.x` / `192.168.x.x` / `172.16–31.x.x` | ❌ **Double NAT. Stop.** |

**If it's CGNAT:** call PLDT and ask for a **public/static IP** — it's a paid add-on, and it is
the only fix that keeps this design. Otherwise tell me and we'll switch to a Tailscale-based
setup, which works fine behind CGNAT but needs software installed on each contributor's machine.

---

## Step 3 — Reserve this PC's IP

`192.168.18.72` came from DHCP and **can change when the PC reboots**. A forward points at a
fixed address, so if the IP moves, your rules silently start pointing at some other device —
and that failure looks exactly like a broken forward.

**DHCP → DHCP Binding / Address Reservation** → bind `192.168.18.72` to this PC's MAC.

Find the MAC with:

```powershell
Get-NetAdapter -Name Ethernet | Select-Object MacAddress
```

---

## Step 4 — Add the two forwards

Menu is usually **Internet → Security → Port Forwarding**, sometimes **Application → Port
Forwarding** or **Advanced → NAT → Virtual Server**.

### Rule 1 — SRT

| Field | Value |
|---|---|
| Name | `livebridge-srt` |
| WAN Connection | the **INTERNET** one — see warning below |
| Protocol | **UDP** ⚠️ |
| WAN Start Port | `9000` |
| WAN End Port | `9000` |
| LAN Host IP | `192.168.18.72` |
| LAN Start Port | `9000` |
| LAN End Port | `9000` |

### Rule 2 — RTMP

Identical, except: Name `livebridge-rtmp`, Protocol **TCP**, all four ports `1935`.

### Two traps that will cost you an hour

**⚠️ The Protocol dropdown defaults to TCP. SRT is UDP.** A TCP rule on 9000 fails *silently* —
the encoder times out and **nothing appears in the SRS log at all**, because no packet ever
reaches the server. If SRT won't connect, check this first.

**⚠️ The WAN Connection dropdown lists several interfaces** — typically an INTERNET one, a
`TR069` (remote management), and sometimes VOIP. Picking the wrong one creates a rule that looks
completely correct in the table and does nothing. Choose the one carrying your internet
connection (usually named `omci_ipv4_pppoe_1`, `INTERNET`, or similar).

---

## Step 5 — Lower the firewall level if needed

ZTE's built-in firewall can override forwarding rules. If step 6 still shows closed, go to
**Security → Firewall** and set the level to **Low**, or disable SPI. Leave it as-is if things
already work.

---

## Step 6 — Verify

From this PC:

```powershell
cd c:\Users\PC\Desktop\2026-2027\RTMP
.\scripts\check-reachability.ps1 -External
```

`-External` asks a third-party service to probe TCP 1935 from the internet — that's the only
part that can genuinely test the router. You want:

```
PASS  TCP 1935 is OPEN from the internet - the router forward works.
```

**There is no free UDP probe**, so SRT/9000 can only be proven by a real remote connection. The
quickest real test: put a phone on **mobile data** (WiFi OFF — on WiFi it's inside your LAN and
proves nothing) and have it publish, or just have your contributor try.

Watch the server side live while they connect:

```powershell
docker logs -f livebridge_srs
```

| What you see | Meaning |
|---|---|
| Nothing at all | Packets never arrived — forward wrong, TCP-instead-of-UDP, or CGNAT |
| `srt disabled` | Server config problem, not the router |
| Handshake/rejection error | Wrong passphrase |
| `on_publish` denied | Stream key not registered |

---

## Step 7 — What to send your contributor

Three things, over **Signal or a password-manager link** — the URL contains the passphrase, so
treat it as a secret:

1. **The SRT URL** — copy it from the dashboard's *"SRT for OBS / FFmpeg (passphrase included)"*
   field. It now reads:

   ```
   srt://103.91.141.41:9000?streamid=#!::r=live/<KEY>,m=publish&latency=800&passphrase=<PASSPHRASE>
   ```

2. **Their encoder settings** — Caller mode, **latency 800** (must be ≥ the server's, which is
   now 800).

3. **OBS specifically** — paste the whole URL into **Settings → Stream → Service: Custom →
   Server**, and leave **Stream Key empty**. OBS has no passphrase field; it's already in the URL.

---

## Because you're skipping DNS

Contributors connect to `103.91.141.41` directly. That works, with one consequence worth
knowing:

**PLDT home IPs rotate.** When it changes — after an outage, a router reboot, or a lease renewal
— every contributor's URL breaks at once, with a plain connection timeout that looks identical
to a firewall problem. There is no warning.

So when SRT suddenly stops working for everyone, **check your public IP first**:

```powershell
(Invoke-RestMethod https://api.ipify.org?format=json).ip
```

If it differs from `103.91.141.41`, update `LIVEBRIDGE_PUBLIC_HOST` in `.env`, run
`docker compose up -d`, and re-send the new URL.

If that becomes annoying, DDNS removes the problem entirely and is already built —
see [PORT_FORWARDING.md](PORT_FORWARDING.md) §5. Your domain is already on Cloudflare, so it's
about ten minutes of work.
