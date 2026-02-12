# Heatbrothers

PostHog event geo-visualization tool. Syncs events from PostHog to local SQLite, will display them as heatmaps later.

## Architecture

pnpm workspaces monorepo:
- `apps/api` - Express API server + PostHog sync service (node-cron)
- `packages/db` - Prisma ORM schema + client (SQLite)

## Setup

```bash
pnpm install
cp .env.example .env  # fill in PostHog credentials
pnpm db:generate      # generate Prisma client
pnpm db:push          # create SQLite tables
pnpm seed             # optional: seed with demo data
pnpm dev              # starts API server on port 3001
```

## Key Commands

- `pnpm dev` - run API server with watch mode
- `pnpm build` - build all packages
- `pnpm sync` - run a one-off PostHog sync
- `pnpm seed` - seed database with demo data
- `pnpm db:generate` - regenerate Prisma client after schema changes
- `pnpm db:push` - push schema changes to SQLite

## PostHog Sync

- Uses the HogQL Query API (`POST /api/projects/:id/query/`)
- Requires a personal API key with "Query Read" permission
- Incremental sync using timestamp watermark in `sync_state` table
- Cron runs every 5 minutes when API server is running
- Manual trigger: `POST /api/sync` or `pnpm sync`
- Rate limit: 120 queries/hour, max 50k rows per query

## API Endpoints

- `GET /api/health` - health check
- `POST /api/sync` - trigger manual sync

## Conventions

- TypeScript strict mode, ESM modules (`"type": "module"`)
- Prisma for all DB access
- SQLite database stored at `data/heatbrothers.db`
- Environment variables in `.env` (never committed)
