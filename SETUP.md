# Live Bridge — Setup on a New PC

Two commands on the old machine, two on the new one.

---

## On the OLD machine (skip if this is a fresh install)

Export the things that cannot be regenerated — above all the Supabase
service-role key, which is a ~200-character JWT nobody wants to retype:

```powershell
.\scripts\export-config.ps1 -IncludePassphrase
```

Writes `livebridge-config.json`. Add `-Protect` to encrypt it with a password.

> **This file contains live secrets.** Move it on a USB stick — not over chat or
> email — and delete it once the new machine is running. It is gitignored.

`-IncludePassphrase` carries the SRT passphrase across so **existing encoders keep
working untouched**. Omit it and the new machine generates a fresh one, which
means reconfiguring every encoder.

---

## On the NEW machine

### 1. Prerequisites

From an **elevated** PowerShell:

```powershell
.\scripts\install-windows.ps1
```

Installs WSL2, Docker Desktop, Git, and (unless `-SkipNdi`) the NDI runtime and
GStreamer. **Reboot if it asks** — WSL2 needs one before Docker can start.

### 2. Live Bridge

```powershell
.\scripts\setup.ps1                                    # dry run - shows the plan
.\scripts\setup.ps1 -Apply -ImportConfig .\livebridge-config.json
```

That does everything: creates `.env`, generates the SRT passphrase, imports your
Supabase credentials, generates a TLS certificate, sets bind addresses, builds and
starts the stack, and health-checks it.

Then open **https://localhost/** (the browser warning is expected — self-signed).

---

## Options

| Flag | Effect |
|---|---|
| *(none)* | Dry run. Reports what it would do, changes nothing. |
| `-Apply` | Actually do it. |
| `-ImportConfig <path>` | Carry credentials over from the old machine. |
| `-Expose local` | **Default.** Loopback only — this PC alone. |
| `-Expose lan` | Reachable from your local network. |
| `-Expose wan` | Ingest open to the internet; prints the router steps. |
| `-SkipFirewall` | Don't touch Windows Firewall. |

For a machine that will take remote contributors:

```powershell
.\scripts\setup.ps1 -Apply -ImportConfig .\livebridge-config.json -Expose wan
.\scripts\setup-port-forwarding.ps1 -Apply      # elevated
```

Then follow **[ROUTER_SETUP.md](ROUTER_SETUP.md)** — the router is the one part no
script can do.

---

## What it will not overwrite

`setup.ps1` is idempotent and re-runnable. It **never** replaces:

- an existing `.env` (it updates individual values in place)
- an existing SRT passphrase — rotating it breaks every configured encoder
- an existing TLS certificate

So re-running it to change `-Expose` is safe.

---

## Verify

```powershell
.\scripts\check-reachability.ps1        # add -External once the router is done
docker compose ps                       # all four containers healthy
```

Read the SRT passphrase to give to encoders:

```powershell
Select-String -Path .env -Pattern '^SRT_PASSPHRASE='
```

---

## If something goes wrong

| Symptom | Cause |
|---|---|
| `docker CLI not found` | Run `install-windows.ps1` first. |
| Engine won't start | Docker Desktop may be waiting on a dialog — check its window. Also confirm WSL2 is installed and you rebooted. |
| `cannot generate a certificate` | openssl is missing. `winget install Git.Git`, then re-run. |
| nginx won't start | Missing/invalid cert in `nginx\certs\`. Delete both files and re-run `setup.ps1 -Apply`. |
| Dashboard 400 "Header Or Cookie Too Large" | Known, already fixed in `nginx\livebridge.conf` — make sure you copied the whole repo. |
| Supabase shows "history unavailable" | Credentials missing or wrong. Live streaming is unaffected by design. |

---

## Notes on this project specifically

- **Docker Desktop may install per-user**, not into Program Files. `setup.ps1`
  checks both locations; anything else that needs to launch it should too.
- **NDI cannot run inside Docker on Windows.** It runs as a native process — see
  [WINDOWS_SETUP.md](WINDOWS_SETUP.md) §5. This is a measured limitation, not a
  configuration problem.
- **NDI needs RAM.** 1080p NDI output died on an 8 GB machine at 720p. 16 GB is a
  realistic floor, 32 GB comfortable.
- **The dashboard has no login.** Port 443 must stay LAN-only and must never be
  forwarded on the router. `setup.ps1` and the firewall script both enforce this.
