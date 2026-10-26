# One Dockerfile, one target per process:
#   docker build --target audit-consumer -t proba-audit-consumer .
# Targets: audit-consumer, audit-api, metrics-ingester, rollup, migrate

# Stage 1: build every workspace
FROM node:26-alpine AS builder
# The protocol package is installed from a git commit (see package.json), which needs git.
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/audit-consumer/package.json apps/audit-consumer/
COPY apps/audit-api/package.json apps/audit-api/
COPY apps/metrics-ingester/package.json apps/metrics-ingester/
COPY apps/rollup/package.json apps/rollup/
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build

# Stage 2: production dependencies only
FROM node:26-alpine AS prod-deps
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/audit-consumer/package.json apps/audit-consumer/
COPY apps/audit-api/package.json apps/audit-api/
COPY apps/metrics-ingester/package.json apps/metrics-ingester/
COPY apps/rollup/package.json apps/rollup/
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3: shared runtime base (no git, non-root user)
FROM node:26-alpine AS runtime
RUN addgroup -g 1001 -S proba && adduser -u 1001 -S proba -G proba
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/packages/core/package.json /app/packages/core/
COPY --from=builder /app/packages/core/dist /app/packages/core/dist
COPY --from=builder /app/packages/adapters/package.json /app/packages/adapters/
COPY --from=builder /app/packages/adapters/dist /app/packages/adapters/dist
USER proba

# --- app targets ---
FROM runtime AS audit-consumer
COPY --from=builder --chown=proba:proba /app/apps/audit-consumer/package.json /app/apps/audit-consumer/
COPY --from=builder --chown=proba:proba /app/apps/audit-consumer/dist /app/apps/audit-consumer/dist
ENV PORT=3101
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "apps/audit-consumer/dist/index.js"]

FROM runtime AS audit-api
COPY --from=builder --chown=proba:proba /app/apps/audit-api/package.json /app/apps/audit-api/
COPY --from=builder --chown=proba:proba /app/apps/audit-api/dist /app/apps/audit-api/dist
ENV PORT=3100
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "apps/audit-api/dist/index.js"]

FROM runtime AS metrics-ingester
COPY --from=builder --chown=proba:proba /app/apps/metrics-ingester/package.json /app/apps/metrics-ingester/
COPY --from=builder --chown=proba:proba /app/apps/metrics-ingester/dist /app/apps/metrics-ingester/dist
ENV PORT=3102
EXPOSE 3102
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "apps/metrics-ingester/dist/index.js"]

# One-shot report of what the metrics flow stored (used by the metrics-e2e compose profile).
FROM metrics-ingester AS metrics-report
HEALTHCHECK NONE
CMD ["node", "apps/metrics-ingester/dist/report-cli.js", "--wait-seconds=90"]

FROM runtime AS rollup
COPY --from=builder --chown=proba:proba /app/apps/rollup/package.json /app/apps/rollup/
COPY --from=builder --chown=proba:proba /app/apps/rollup/dist /app/apps/rollup/dist
ENV PORT=3103
EXPOSE 3103
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "apps/rollup/dist/index.js"]

# One-shot job: create the database and apply ClickHouse migrations.
FROM runtime AS migrate
COPY --chown=proba:proba migrations ./migrations
CMD ["node", "packages/adapters/dist/clickhouse/migrate-cli.js"]
