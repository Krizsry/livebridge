#!/bin/sh
# =============================================================================
# Live Bridge - SRS entrypoint
# =============================================================================
# Renders conf/livebridge.conf.template into a concrete config by substituting
# @@TOKENS@@ from the environment, then execs SRS.
#
# Uses plain `sed` on purpose: no extra packages are installed into the image
# (project rule 14). The rendered file lives in a tmpfs-ish writable dir and is
# never written back into the repo, so the passphrase stays out of git.
# =============================================================================
set -eu

TEMPLATE="/usr/local/srs/conf/livebridge.conf.template"
RENDERED="/tmp/livebridge.rendered.conf"

# --- Required variables -------------------------------------------------------
: "${SRT_PASSPHRASE:?SRT_PASSPHRASE is required - see .env.example}"

# --- Defaults for the optional ones ------------------------------------------
SRT_PBKEYLEN="${SRT_PBKEYLEN:-16}"
SRT_LATENCY_MS="${SRT_LATENCY_MS:-300}"
HLS_FRAGMENT_SEC="${HLS_FRAGMENT_SEC:-2}"
HLS_WINDOW_SEC="${HLS_WINDOW_SEC:-12}"
SRS_LOG_LEVEL="${SRS_LOG_LEVEL:-trace}"

# --- Validate the passphrase --------------------------------------------------
# SRT requires 10-79 characters. We additionally restrict the character set to
# alphanumerics because the value is substituted with sed - a passphrase
# containing `/`, `&`, `\` or a newline would silently corrupt the config.
passlen=$(printf '%s' "$SRT_PASSPHRASE" | wc -c | tr -d ' ')
if [ "$passlen" -lt 10 ] || [ "$passlen" -gt 79 ]; then
    echo '{"level":"fatal","service":"srs","msg":"SRT_PASSPHRASE must be 10-79 characters","length":'"$passlen"'}' >&2
    exit 1
fi
case "$SRT_PASSPHRASE" in
    *[!A-Za-z0-9_-]*)
        echo '{"level":"fatal","service":"srs","msg":"SRT_PASSPHRASE must contain only A-Z a-z 0-9 _ - (it is substituted into the SRS config)"}' >&2
        exit 1
        ;;
esac

# --- Validate the numerics ----------------------------------------------------
for pair in "SRT_PBKEYLEN=$SRT_PBKEYLEN" "SRT_LATENCY_MS=$SRT_LATENCY_MS" \
            "HLS_FRAGMENT_SEC=$HLS_FRAGMENT_SEC" "HLS_WINDOW_SEC=$HLS_WINDOW_SEC"; do
    name="${pair%%=*}"
    value="${pair#*=}"
    case "$value" in
        ''|*[!0-9]*)
            echo '{"level":"fatal","service":"srs","msg":"'"$name"' must be a positive integer","value":"'"$value"'"}' >&2
            exit 1
            ;;
    esac
done

case "$SRT_PBKEYLEN" in
    16|24|32) ;;
    *)
        echo '{"level":"fatal","service":"srs","msg":"SRT_PBKEYLEN must be 16, 24 or 32","value":"'"$SRT_PBKEYLEN"'"}' >&2
        exit 1
        ;;
esac

case "$SRS_LOG_LEVEL" in
    verbose|info|trace|warn|error) ;;
    *)
        echo '{"level":"fatal","service":"srs","msg":"SRS_LOG_LEVEL must be one of verbose|info|trace|warn|error","value":"'"$SRS_LOG_LEVEL"'"}' >&2
        exit 1
        ;;
esac

# --- Render -------------------------------------------------------------------
sed \
    -e "s|@@SRT_PASSPHRASE@@|${SRT_PASSPHRASE}|g" \
    -e "s|@@SRT_PBKEYLEN@@|${SRT_PBKEYLEN}|g" \
    -e "s|@@SRT_LATENCY_MS@@|${SRT_LATENCY_MS}|g" \
    -e "s|@@HLS_FRAGMENT_SEC@@|${HLS_FRAGMENT_SEC}|g" \
    -e "s|@@HLS_WINDOW_SEC@@|${HLS_WINDOW_SEC}|g" \
    -e "s|@@SRS_LOG_LEVEL@@|${SRS_LOG_LEVEL}|g" \
    "$TEMPLATE" > "$RENDERED"

# --- Fail loudly if anything was left unsubstituted ---------------------------
if grep -q '@@' "$RENDERED"; then
    echo '{"level":"fatal","service":"srs","msg":"unsubstituted tokens remain in rendered config","tokens":"'"$(grep -o '@@[A-Z_]*@@' "$RENDERED" | sort -u | tr '\n' ' ')"'"}' >&2
    exit 1
fi

chmod 600 "$RENDERED"

echo '{"level":"info","service":"srs","msg":"config rendered","srt_latency_ms":'"$SRT_LATENCY_MS"',"pbkeylen":'"$SRT_PBKEYLEN"',"hls_fragment_sec":'"$HLS_FRAGMENT_SEC"'}'
echo '{"level":"info","service":"srs","msg":"starting SRS","rtmp":1935,"srt":9000,"api":1985,"http":8080}'

exec /usr/local/srs/objs/srs -c "$RENDERED" "$@"
