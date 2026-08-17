# Live Bridge — systemd (non-Docker) deployment

Docker Compose is the primary, recommended deployment. This directory is the
**alternative** for hosts where Docker is not available or not wanted.

| File | Purpose |
|---|---|
| `livebridge.service` | Main unit — the backend API, WebSocket hub and FFmpeg relay manager |
| `livebridge-srs.service` | The SRS engine (SRT + RTMP ingest, HLS output) |
| `livebridge-compose.service` | *Optional* — lets systemd own the **Docker** stack instead. Do not combine with the two units above. |

---

## Why Docker Compose is the default

Requirement 13 asks for "Docker restart policies or systemd, whichever is more
robust". For this stack, Compose is the better default:

- **Failure isolation is per-process.** `restart: unless-stopped` restarts only
  the container that died. A backend crash leaves SRT/RTMP ingest completely
  untouched — which is the single most important property here. The
  `livebridge-compose.service` wrapper, by contrast, restarts the whole stack.
- **Dependency ordering with health gates.** Compose's
  `depends_on: condition: service_healthy` is more precise than systemd's
  `After=`, which only orders *starts*, not *readiness*.
- **Pinned runtime.** SRS, FFmpeg and Node versions come from images rather than
  from whatever the distro ships, so a `apt upgrade` cannot silently change your
  encoder compatibility mid-season.

The systemd path is here for hosts where that trade is worth making — bare metal
with existing config management, or a policy against container runtimes.

---

## Non-Docker install on Ubuntu 22.04 / 24.04

### 1. Create the service user

Never run any of this as root (project rule 3).

```bash
sudo useradd --system --home-dir /opt/livebridge --shell /usr/sbin/nologin livebridge
sudo mkdir -p /opt/livebridge /var/lib/livebridge/hls
sudo chown -R livebridge:livebridge /opt/livebridge /var/lib/livebridge
```

### 2. Install dependencies

Exactly these, and why (project rule 14):

```bash
# Node 22 - runs the backend
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# FFmpeg - the relay and SRT ingest pipeline
sudo apt-get install -y ffmpeg

# Nginx - TLS termination and reverse proxy
sudo apt-get install -y nginx
```

### 3. Install SRS with SRT support

Ubuntu's repositories do not package SRS. Build it, enabling SRT:

```bash
sudo apt-get install -y git build-essential autoconf automake libtool pkg-config \
                        libssl-dev cmake

cd /usr/local/src
sudo git clone -b 6.0release --depth 1 https://github.com/ossrs/srs.git
cd srs/trunk
sudo ./configure --srt=on --hls=on --http-api=on --http-server=on
sudo make -j"$(nproc)"

sudo mkdir -p /opt/livebridge/srs/objs
sudo cp objs/srs /opt/livebridge/srs/objs/srs
```

> Verify SRT actually compiled in — this is the step that most often silently
> fails and leaves you with an RTMP-only server:
> ```bash
> /opt/livebridge/srs/objs/srs -v
> ldd /opt/livebridge/srs/objs/srs | grep -i srt   # should print a libsrt line
> ```

### 4. Deploy the Live Bridge files

```bash
sudo cp -r srs/conf srs/docker-entrypoint.sh  /opt/livebridge/srs/
sudo cp -r backend                            /opt/livebridge/
sudo cp .env                                  /opt/livebridge/.env

sudo chmod 700 /opt/livebridge/srs/docker-entrypoint.sh
sudo chmod 600 /opt/livebridge/.env
sudo chown -R livebridge:livebridge /opt/livebridge

cd /opt/livebridge/backend && sudo -u livebridge npm ci --omit=dev
```

Build the dashboard and hand the static files to nginx:

```bash
cd dashboard && npm ci && npm run build
sudo mkdir -p /var/www/livebridge
sudo cp -r dist/* /var/www/livebridge/
```

### 5. Nginx

`nginx/livebridge.conf` targets the Docker service names and the unprivileged
ports. For a bare-metal install, change:

| Docker value | Bare-metal value |
|---|---|
| `listen 8443 ssl` | `listen 443 ssl` |
| `listen 8080` | `listen 80` |
| `server livebridge_backend:8000` | `server 127.0.0.1:8000` |
| `server livebridge_srs:8080` | `server 127.0.0.1:8080` |
| `proxy_pass http://livebridge_dashboard_up` | `root /var/www/livebridge; try_files $uri $uri/ /index.html;` |

Then:

```bash
sudo cp nginx/livebridge.conf /etc/nginx/sites-available/livebridge
sudo ln -s /etc/nginx/sites-available/livebridge /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 6. Install and start the units

```bash
sudo cp systemd/livebridge.service systemd/livebridge-srs.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now livebridge-srs.service livebridge.service
```

### 7. Verify

```bash
systemctl status livebridge-srs livebridge

# Structured JSON logs, pretty-printed
journalctl -u livebridge -o cat -f | jq .

# Engine and backend health
curl -s http://127.0.0.1:1985/api/v1/versions | jq .
curl -s http://127.0.0.1:8000/api/health | jq .

# Ports actually listening
sudo ss -lunp | grep 9000     # SRT  (UDP)
sudo ss -ltnp | grep 1935     # RTMP (TCP)
sudo ss -ltnp | grep 443      # dashboard
```

---

## Restart behaviour

Both units use `Restart=always` with `RestartSec=2`–`3` and a
`StartLimitBurst=10` / `StartLimitIntervalSec=60` window. That tolerates a burst
of restarts during an incident while still surfacing a genuine crash loop rather
than hiding it behind infinite retries.

`KillMode=control-group` on `livebridge.service` matters specifically because the
backend spawns FFmpeg children — without it, stopping the unit orphans every
running relay.

The two units are intentionally **not** bound together with `Requires=` or
`BindsTo=`. A backend failure must never stop the SRS engine, because that would
drop live SRT and RTMP ingest for a metadata-layer problem.

## Log rotation

journald handles rotation. To cap Live Bridge's share:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=2G\nMaxRetentionSec=30day\n' \
  | sudo tee /etc/systemd/journald.conf.d/livebridge.conf
sudo systemctl restart systemd-journald
```
