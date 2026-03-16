# ─── Build stage ────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace config first (cache layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/daemon/package.json packages/daemon/
COPY packages/validator/package.json packages/validator/
COPY packages/escalation-mcp/package.json packages/escalation-mcp/

# Install dependencies
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/daemon/ packages/daemon/
COPY packages/validator/ packages/validator/
COPY packages/escalation-mcp/ packages/escalation-mcp/
COPY tsconfig.base.json ./

# Build all packages
RUN pnpm run build

# ─── Production stage ──────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache tini git docker-cli

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/packages/daemon/dist ./packages/daemon/dist
COPY --from=builder /app/packages/daemon/package.json ./packages/daemon/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/validator/dist ./packages/validator/dist
COPY --from=builder /app/packages/validator/package.json ./packages/validator/
COPY --from=builder /app/packages/escalation-mcp/dist ./packages/escalation-mcp/dist
COPY --from=builder /app/packages/escalation-mcp/package.json ./packages/escalation-mcp/

# Copy workspace config for production install
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./

# Install production dependencies only
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# Create non-root user
RUN addgroup -g 1000 autopod && \
    adduser -u 1000 -G autopod -s /bin/sh -D autopod

# Create data directory for SQLite
RUN mkdir -p /data && chown autopod:autopod /data

USER autopod

EXPOSE 3000

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/daemon/dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
