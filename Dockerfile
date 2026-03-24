# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first so Docker caches the install layer.
COPY package*.json ./

# Install production dependencies only; skip native build scripts for packages
# that don't need them, but better-sqlite3 requires a native build so we keep
# the default install here (node-gyp toolchain is included in node:alpine).
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy installed modules from deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy application source.
COPY src/     ./src/
COPY schemas/ ./schemas/

# The data directory is mounted as a volume at runtime.
# Pre-create it so the process can always write to it even if no volume is
# mounted (e.g. during integration tests / CI).
RUN mkdir -p /data && chown node:node /data

# Drop root privileges.
USER node

# Configuration — overridable at runtime via environment variables or a
# mounted .env file (see docker-compose.yml).
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/aep.db \
    LOG_LEVEL=info

EXPOSE 8787

# Liveness probe — used by Docker/compose healthcheck and K8s livenessProbe.
HEALTHCHECK \
  --interval=30s \
  --timeout=5s \
  --start-period=15s \
  --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

CMD ["node", "src/server.js"]
