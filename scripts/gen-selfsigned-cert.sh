#!/usr/bin/env bash
# =============================================================================
# Live Bridge - generate a self-signed TLS certificate
# =============================================================================
# This exists so the stack comes up on first boot. A self-signed certificate
# means browsers will warn; that is acceptable for an internal, firewall- or
# VPN-restricted dashboard, but see the README for switching to Let's Encrypt.
# =============================================================================
set -euo pipefail

# Git Bash / MSYS on Windows rewrites arguments that look like absolute paths,
# turning openssl's "/CN=host/O=Live Bridge" subject into
# "C:/Program Files/Git/CN=host/O=Live Bridge" and failing the request. Exclude
# only the subject: the -keyout/-out paths still need normal conversion, so a
# blanket '*' would break those instead. A no-op on Linux.
export MSYS2_ARG_CONV_EXCL='/CN='

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/nginx/certs"
DAYS=825

HOSTNAME_ARG="${1:-}"
if [[ -z "$HOSTNAME_ARG" ]]; then
    if [[ -f "$ROOT/.env" ]]; then
        HOSTNAME_ARG="$(grep -E '^LIVEBRIDGE_HOST=' "$ROOT/.env" | cut -d= -f2- | tr -d '"' || true)"
    fi
fi
HOSTNAME_ARG="${HOSTNAME_ARG:-localhost}"

command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl is required." >&2; exit 1; }

mkdir -p "$CERT_DIR"

if [[ -f "$CERT_DIR/livebridge.crt" ]]; then
    echo "A certificate already exists at $CERT_DIR/livebridge.crt"
    read -r -p "Overwrite it? [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

echo "Generating a self-signed certificate for: $HOSTNAME_ARG"

openssl req -x509 -nodes \
    -newkey rsa:2048 \
    -days "$DAYS" \
    -keyout "$CERT_DIR/livebridge.key" \
    -out "$CERT_DIR/livebridge.crt" \
    -subj "/CN=${HOSTNAME_ARG}/O=Live Bridge" \
    -addext "subjectAltName=DNS:${HOSTNAME_ARG},DNS:localhost,IP:127.0.0.1"

# The key must be readable by the unprivileged nginx user inside the container
# (uid 101) but not by anyone else on the host.
chmod 644 "$CERT_DIR/livebridge.crt"
chmod 644 "$CERT_DIR/livebridge.key"

cat <<BANNER

  Certificate written:
      $CERT_DIR/livebridge.crt
      $CERT_DIR/livebridge.key
      Common name: $HOSTNAME_ARG
      Valid for:   $DAYS days

  NOTE: this is self-signed, so browsers will show a warning. That is expected
  for an internal dashboard. To use a real certificate instead, drop your
  fullchain and private key in as livebridge.crt / livebridge.key and run:

      docker compose restart nginx

  Both files are gitignored.

BANNER
