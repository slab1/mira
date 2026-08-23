# syntax=docker/dockerfile:1
FROM oven/bun:1.4 AS base
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
RUN bun install --frozen-lockfile

# Build stage
FROM deps AS builder
COPY . .
RUN bun run build || echo "build warning"

# Runner stage
FROM base AS runner
RUN addgroup --system --gid 1001 mira && adduser --system --uid 1001 mira
WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/package.json /app/bun.lock* ./
COPY --from=builder /app/packages/server ./packages/server
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/packages/server/dist ./packages/server/dist

# Data volume
RUN mkdir -p /app/data && chown -R mira:mira /app

USER mira
EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -f http://localhost:4096/health || exit 1

CMD ["bun", "packages/server/src/index.ts"]
