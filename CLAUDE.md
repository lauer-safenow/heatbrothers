# Heatbrothers

PostHog event geo-visualization tool. Syncs events from PostHog to local SQLite, displays them as heatmaps on a map.

## Architecture

pnpm workspaces monorepo:
- `apps/api` - Express 5 API server + PostHog sync service (node-cron) + in-memory event cache
- `apps/web` - React 19 + Vite SPA with MapLibre GL + deck.gl heatmap visualization
- `packages/db` - Prisma ORM schema + client (SQLite via better-sqlite3)

## Setup

```bash
pnpm install
cp .env.example .env  # fill in PostHog credentials
pnpm db:generate      # generate Prisma client
pnpm db:deploy        # run migrations
pnpm dev              # starts API + Vite dev server on port 3001
```

## Key Commands

- `pnpm dev` - run API server with Vite dev middleware + watch mode (local only)
- `pnpm serve` - run API server in production mode (NODE_ENV=production, serves static files)
- `pnpm prodbs` - full production bootstrap: install, db setup, web build, serve
- `pnpm bootstrap` - full dev bootstrap: install, db setup, dev server
- `pnpm build` - build all packages
- `pnpm sync` - run a one-off PostHog sync
- `pnpm seed` - seed database with demo data
- `pnpm db:generate` - regenerate Prisma client after schema changes
- `pnpm db:deploy` - run pending migrations

## Production / Remote Deployment

- Remote is a 2GB Ubuntu VM — Vite dev server causes OOM, always use `pnpm prodbs`
- `prodbs` builds the web app first (`vite build`), then runs with `NODE_ENV=production` (no Vite in memory)
- Never use `tsx watch` on remote — it can't cleanly kill processes with SQLite/Vite handles

## PostHog Sync

- Uses the HogQL Query API (`POST /api/projects/:id/query/`)
- Requires a personal API key with "Query Read" permission
- Incremental sync using `MAX(posthog_ts)` per event type as cursor
- Cron runs every 60 seconds when API server is running
- Manual trigger: `POST /api/sync` or `pnpm sync`
- Rate limit: 120 queries/hour, max 50k rows per query
- Exponential backoff (2s base) on 429 and 5xx errors

## In-Memory Cache

- `Map<string, CachedEvent[]>` keyed by event_type, loaded from SQLite on startup
- Batched loading (50k rows per batch) with `setImmediate` between batches to not block event loop
- Incremental refresh after each sync via `id > maxId`
- Excludes `properties` blob to keep memory footprint small

## API Endpoints

- `GET /api/health` - health check
- `GET /api/stats` - event counts by type (from cache)
- `GET /api/events/:type` - all events for a type as `[lng, lat, weight]` tuples (from cache)
- `POST /api/sync` - trigger manual sync

## Frontend Routes

- `/` - landing page with HEAT BROTHERS logo + event stats
- `/map` - full-screen MapLibre GL map with deck.gl HeatmapLayer + event type dropdown

## Event Types & Display Names

- `DETAILED_ALARM_STARTED_PRIVATE_GROUP` → "Alarm started private"
- `app_opening_ZONE` → "App opening zone"
- `FIRST_TIME_PHONE_STATUS_SENT` → "Installs"
- `DETAILED_ALARM_STARTED_ZONE` → "Alarm started zone"

## Conventions

- TypeScript strict mode, ESM modules (`"type": "module"`)
- Express 5 with `path-to-regexp` v8: wildcard routes use `"/{*splat}"` not `"*"`
- Raw better-sqlite3 for bulk reads (cache), Prisma for schema/migrations
- SQLite database stored at `data/heatbrothers.db` (WAL mode)
- Environment variables in `.env` (never committed)
