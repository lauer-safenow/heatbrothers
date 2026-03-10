# ===========================================================
# Stage 1: builder — install deps, compile natives, build web
# ===========================================================
FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy workspace config + lockfile first (layer caching)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy all package.json files for workspace resolution
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile

# Copy all source
COPY . .

# Generate Prisma client + build web app
RUN pnpm db:generate
RUN pnpm --filter @heatbrothers/web build

# ===========================================================
# Stage 2: runtime — no build tools, non-root user
# ===========================================================
FROM node:24-alpine AS runtime

RUN apk add --no-cache libstdc++

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy workspace config and package manifests
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# Copy node_modules (multi-stage COPY already excludes web dist/build tools)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/packages/db/node_modules ./packages/db/node_modules

# Copy API source (tsx runs TypeScript directly)
COPY --from=builder /app/apps/api/src ./apps/api/src

# Copy built web assets
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Copy DB package: Prisma config, migrations, generated client, source
COPY --from=builder /app/packages/db/prisma.config.ts ./packages/db/
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/src ./packages/db/src

# Copy shared package source
COPY --from=builder /app/packages/shared/src ./packages/shared/src

# Data directory for SQLite (volume-mounted in compose)
RUN mkdir -p /app/data && chown -R node:node /app/data

COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

USER node

ENTRYPOINT ["/app/docker-entrypoint.sh"]
