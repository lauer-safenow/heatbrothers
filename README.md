# Heatbrothers

Syncs geo-located events from PostHog into a local SQLite database for heatmap visualization.

## Architecture

pnpm monorepo with three packages:

```
heatbrothers/
├── apps/
│   ├── api/          Express 5 server — API, sync engine, cron
│   └── web/          React 19 + Vite frontend
├── packages/
│   └── db/           Prisma 7 schema, migrations, SQLite via better-sqlite3
└── data/             SQLite database (gitignored, created at runtime)
```

## Stack

- **Runtime:** Node 22 (LTS)
- **Monorepo:** pnpm workspaces
- **API:** Express 5, tsx watch (dev)
- **Frontend:** React 19, Vite 6
- **Database:** SQLite (better-sqlite3, WAL mode)
- **ORM:** Prisma 7 with `@prisma/adapter-better-sqlite3`
- **Data source:** PostHog HogQL Query API

## Synced Event Types

| Event | Description |
|---|---|
| `FIRST_TIME_PHONE_STATUS_SENT` | First registration from a device |
| `app_opening_ZONE` | App opened in a zone |
| `DETAILED_ALARM_STARTED_ZONE` | Alarm triggered in a zone |
| `DETAILED_ALARM_STARTED_PRIVATE_GROUP` | Alarm triggered in a private group |

Events are filtered to `env='prod'` and must have app-reported `properties.latitude` / `properties.longitude`.

## Sync Engine

- **Cursor pagination:** Uses `MAX(posthog_ts)` per event type as cursor — no OFFSET (times out at scale), no separate sync state table
- **Bulk insert:** Raw better-sqlite3 `INSERT OR IGNORE` in transactions (Prisma's `createMany` has bugs with this adapter)
- **Retry:** Exponential backoff (2s/4s/8s/16s) for 429 and 5xx errors, up to 5 attempts
- **Cron:** Incremental sync every 5 minutes via node-cron
- **Manual sync:** `POST /api/sync` or `pnpm sync`

## Environment Variables

Create a `.env` file in the repo root:

```env
POSTHOG_API_KEY=phx_...
POSTHOG_HOST=https://eu.posthog.com
POSTHOG_PROJECT_ID=12345
```

## Getting Started

```bash
pnpm install
pnpm db:generate    # generate Prisma client
pnpm db:deploy      # apply migrations
pnpm dev            # start API + Vite dev server on :3001
```

Or all at once:

```bash
pnpm bootstrap      # install + generate + deploy + dev
```

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start dev server (API + Vite HMR) |
| `pnpm build` | Build all packages for production |
| `pnpm sync` | Run a one-off full sync |
| `pnpm db:migrate` | Create a new migration from schema changes |
| `pnpm db:deploy` | Apply pending migrations |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm bootstrap` | Full setup: install, generate, deploy, dev |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/stats` | Event counts by type |
| `POST` | `/api/sync` | Trigger manual sync |
