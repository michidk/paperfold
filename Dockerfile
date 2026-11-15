# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# Build the client on the host architecture; the output is plain static files.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# The game server: runs the TypeScript directly and serves the built client.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN groupadd --system --gid 1001 paperfold && \
    useradd --system --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin paperfold && \
    mkdir -p /data && chown paperfold:paperfold /data

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=paperfold:paperfold server ./server
COPY --chown=paperfold:paperfold shared ./shared
COPY --chown=paperfold:paperfold drizzle ./drizzle
COPY --from=builder --chown=paperfold:paperfold /app/dist ./dist

USER paperfold
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["bun", "-e", "fetch('http://localhost:' + (process.env.PORT ?? 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "server/index.ts"]
