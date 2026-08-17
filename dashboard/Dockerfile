# =============================================================================
# Live Bridge - dashboard image
# =============================================================================
# Stage 1 builds the React bundle; stage 2 serves it as static files.
# The runtime stage uses nginx-unprivileged, which runs as a NON-ROOT user
# (project rule 3) and listens on 8080 rather than 80.
#
# Nothing sensitive is baked into the bundle. The frontend never receives a
# Supabase key, a stream passphrase or a platform stream key (project rule 25).
# =============================================================================

# --- Stage 1: build ----------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

# --- Stage 2: serve ----------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine

LABEL org.opencontainers.image.title="livebridge-dashboard" \
      org.opencontainers.image.description="Live Bridge React dashboard (static bundle)"

# The base image already switched to uid 101 (nginx). Copy as root-owned,
# world-readable content; nginx only ever reads it.
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:8080/_health || exit 1
