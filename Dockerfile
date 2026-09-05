# syntax=docker/dockerfile:1
FROM oven/bun:1.4.0 AS base
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4096

# Install system deps for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Dependencies stage
FROM base AS deps
COPY package.json bun.lock* ./
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/
COPY packages/tui/package.json ./packages/tui/
COPY packages/cli/package.json ./packages/cli/
COPY packages/slack/package.json ./packages/slack/
COPY packages/vscode-mira/package.json ./packages/vscode-mira/
RUN bun install --frozen-lockfile

# Build stage
FROM deps AS builder
COPY . .
RUN bun run build
# Smoke: verify server dist and web dist were produced (fail fast if build silently broke)
RUN test -f packages/server/dist/index.js && test -f packages/web/dist/index.html

# Runner stage
FROM base AS runner
RUN groupadd -r -g 1001 mira && useradd -r -u 1001 -g mira mira
WORKDIR /app

# Copy built artifacts — run from compiled dist, not TS source (prod hardening for Risk 1)
COPY --from=builder /app/package.json /app/bun.lock* ./
COPY --from=builder /app/packages/server ./packages/server
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/web/dist ./packages/web/dist

# Data volume
RUN mkdir -p /app/data && chown -R mira:mira /app

USER mira
EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD curl -f http://localhost:4096/healthz || exit 1

CMD ["bun", "packages/server/dist/index.js"]
