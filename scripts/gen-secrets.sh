#!/usr/bin/env bash
# =============================================================================
# Live Bridge - generate strong random secrets into .env
# =============================================================================
# Project rule 5: never hardcode or reuse default passwords/stream keys.
# This generates cryptographically random values, writes them to .env (which is
# gitignored) and prints them ONCE so you can configure your encoders.
#
# Safe to re-run: it will refuse to overwrite an existing .env unless you pass
# --force, because regenerating the SRT passphrase breaks every encoder that is
# already configured.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
EXAMPLE_FILE="$ROOT/.env.example"
FORCE=0

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -h|--help)
            echo "Usage: $0 [--force]"
            echo "  --force  overwrite an existing .env (invalidates the current SRT passphrase)"
            exit 0
            ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

if [[ ! -f "$EXAMPLE_FILE" ]]; then
    echo "ERROR: $EXAMPLE_FILE not found - run this from a full checkout." >&2
    exit 1
fi

if [[ -f "$ENV_FILE" && $FORCE -eq 0 ]]; then
    echo "ERROR: $ENV_FILE already exists."
    echo
    echo "Regenerating secrets would invalidate the SRT passphrase that your"
    echo "encoders are already using. If that is what you want:"
    echo "    $0 --force"
    exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl is required." >&2; exit 1; }

# -----------------------------------------------------------------------------
# The SRT passphrase is restricted to hex characters on purpose: the SRS
# entrypoint substitutes it into the config with sed, so a value containing
# shell or regex metacharacters would corrupt the rendered config. 32 hex chars
# = 128 bits of entropy, comfortably inside SRT's 10-79 character limit.
# -----------------------------------------------------------------------------
SRT_PASSPHRASE="$(openssl rand -hex 16)"

# A suggested first stream key. Registering it is still a separate step - see
# the README - but having one ready saves a round trip.
SAMPLE_STREAM_KEY="stream_$(openssl rand -hex 8)"
SAMPLE_STREAM_SECRET="$(openssl rand -hex 16)"

cp "$EXAMPLE_FILE" "$ENV_FILE"

# Portable in-place edit (GNU sed and BSD sed disagree about -i).
replace() {
    local key="$1" value="$2"
    local tmp
    tmp="$(mktemp)"
    sed "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
}

replace "SRT_PASSPHRASE" "$SRT_PASSPHRASE"

chmod 600 "$ENV_FILE"

cat <<BANNER

===============================================================================
  Live Bridge - secrets generated
===============================================================================

  Written to: $ENV_FILE   (mode 600, gitignored)

  SRT PASSPHRASE
      $SRT_PASSPHRASE

      Enter this in every encoder that publishes over SRT (vMix, Kiloview, OBS,
      Resi). SRS supports ONE passphrase for the whole SRT listener, so this
      single value is shared by all SRT publishers. Per-stream identity is
      enforced separately by stream ID.

  SUGGESTED FIRST STREAM KEY (not yet registered)
      stream key    $SAMPLE_STREAM_KEY
      extra secret  $SAMPLE_STREAM_SECRET

      Register it from the dashboard, or with:

        curl -sk -X POST https://localhost/api/keys \\
          -H 'content-type: application/json' \\
          -d '{"stream_key":"$SAMPLE_STREAM_KEY","label":"Studio A","protocol":"ANY","secret":"$SAMPLE_STREAM_SECRET"}'

  STILL TO DO in $ENV_FILE:
      LIVEBRIDGE_HOST / LIVEBRIDGE_PUBLIC_HOST   your server's hostname
      SUPABASE_URL                                from your Supabase project
      SUPABASE_SERVICE_ROLE_KEY                   from your Supabase project

  This is the only time these values are printed. Store them in your password
  manager now.
===============================================================================

BANNER
