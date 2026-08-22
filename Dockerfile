FROM oven/bun:1.4 as base
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/
RUN bun install
COPY . .
RUN bun run build || echo "build warning"
EXPOSE 4096
CMD ["bun", "packages/server/src/index.ts"]
