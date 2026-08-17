# =============================================================================
# Live Bridge - backend image
# =============================================================================
# Node 22 LTS on Alpine + FFmpeg (needed for the relay and SRT ingest jobs).
# Runs as a NON-ROOT user (project rule 3).
#
# Packages installed and why (project rule 14):
#   ffmpeg  - the relay/bridging pipeline (requirements 7 and 8)
#   curl    - the container healthcheck
#   tini    - PID 1 that reaps zombie FFmpeg children and forwards signals
# Nothing else.
# =============================================================================
FROM node:22-alpine

LABEL org.opencontainers.image.title="livebridge-backend" \
      org.opencontainers.image.description="Live Bridge API, WebSocket hub and FFmpeg relay manager"

RUN apk add --no-cache \
        ffmpeg \
        curl \
        tini

WORKDIR /app

# Dependencies first so a source change doesn't invalidate the npm layer.
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present, `npm install` otherwise.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

COPY src ./src

# -----------------------------------------------------------------------------
# Non-root user. The `node` user (uid 1000) ships with the base image.
# The app writes nothing to disk - all state is in memory or in Supabase - so it
# needs no writable volume.
# -----------------------------------------------------------------------------
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 8000

# Liveness only. /api/health is the deep check and includes SRS + Supabase, which
# we deliberately do NOT gate the container on: a Supabase outage must not cause
# a restart loop (requirement 21).
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS --max-time 4 http://127.0.0.1:8000/healthz || exit 1

# tini reaps the FFmpeg children the relay manager spawns. Without it, every
# stopped relay leaves a zombie under PID 1.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
