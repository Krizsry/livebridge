# =============================================================================
# Live Bridge - SRS engine image
# =============================================================================
# Base: official SRS 6 (SRT + RTMP + HLS all compiled in - no extra build step).
# Adds: our config template, entrypoint, and a NON-ROOT user (project rule 3).
#
# No additional packages are installed. The entrypoint uses only sed/grep/wc,
# which are already present in the base image (project rule 14).
# =============================================================================
FROM ossrs/srs:6

LABEL org.opencontainers.image.title="livebridge-srs" \
      org.opencontainers.image.description="Live Bridge SRT+RTMP ingest engine with HLS output"

# -----------------------------------------------------------------------------
# Non-root user. Ports 1935/9000/1985/8080 are all above 1024, so no privileged
# bind is needed.
# -----------------------------------------------------------------------------
ARG LIVEBRIDGE_UID=10001
ARG LIVEBRIDGE_GID=10001
RUN set -eux; \
    groupadd --gid "${LIVEBRIDGE_GID}" livebridge; \
    useradd --uid "${LIVEBRIDGE_UID}" --gid "${LIVEBRIDGE_GID}" \
            --home-dir /usr/local/srs --no-create-home --shell /usr/sbin/nologin livebridge

WORKDIR /usr/local/srs

COPY --chown=root:root conf/livebridge.conf.template /usr/local/srs/conf/livebridge.conf.template
COPY --chown=root:root docker-entrypoint.sh          /usr/local/srs/docker-entrypoint.sh
RUN chmod 0755 /usr/local/srs/docker-entrypoint.sh \
 && chmod 0444 /usr/local/srs/conf/livebridge.conf.template

# SRS writes HLS segments and its pid file at runtime - those dirs must be
# writable by the non-root user. Everything else stays root-owned/read-only.
RUN set -eux; \
    mkdir -p /usr/local/srs/objs/nginx/html/live; \
    chown -R "${LIVEBRIDGE_UID}:${LIVEBRIDGE_GID}" /usr/local/srs/objs

USER livebridge

# 1935/tcp  RTMP ingest + playback      (published to host)
# 9000/udp  SRT  ingest + playback      (published to host)
# 1985/tcp  HTTP API for the backend    (internal network only)
# 8080/tcp  HLS / HTTP-FLV output       (internal network only, via Nginx)
EXPOSE 1935/tcp 9000/udp 1985/tcp 8080/tcp

# Healthcheck hits the SRS API's version endpoint over bash's /dev/tcp.
#
# This previously used curl, which the ossrs/srs:6 image does NOT ship - the
# probe could only ever fail, so the image reported permanently unhealthy when
# run outside Compose. It went unnoticed because docker-compose.yml overrides
# the healthcheck with exactly this /dev/tcp probe; the two files disagreed and
# only the compose one was ever exercised. They now match.
#
# Note this speaks HTTP/1.0 with no Host header, so it does not exercise SRS's
# URI parser the way a real caller does - see the 2026-08-15 12:52 entry in
# PROGRESS.md, where that gap let a total API outage report as healthy.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/1985 && printf "GET /api/v1/versions HTTP/1.0\r\n\r\n" >&3 && head -1 <&3 | grep -q "200 OK"' || exit 1

ENTRYPOINT ["/usr/local/srs/docker-entrypoint.sh"]
