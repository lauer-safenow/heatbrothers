# Design

- Every corner has 60% smoothing
- Buttons use squircle shape: `border-radius: 14px`, `padding: 4px`, size `40x40px`

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
- Incremental sync: cursor = `MAX(timestamp) - 600s` per event type (10-min lookback for ingestion delay)
- Rate limit: 120 queries/hour — fast cron at 60s uses 60/hour, slow cron uses ~48/hour
- Manual trigger: `POST /api/sync` or `pnpm sync`
- Backfill (re-sync from N days ago): `POST /api/sync/backfill?days=30` (fires in background, watch with `journalctl -f | grep backfill`)

### Two-tier cron (job queue, no skips)
- **Fast** (`*/60 * * * * *`): syncs `DETAILED_ALARM_STARTED_PRIVATE_GROUP` every 60s
- **Slow** (`0 0,5,10,...,55 * * * *`): syncs the other 4 types every 5 minutes
- Jobs are queued, not dropped — slow job runs immediately after fast completes if they overlap
- **node-cron 3.0.3 bug**: `*/N` step syntax in the minutes field is broken — it collapses to `0` only (fires at top of hour only). Fix: generate explicit minutes list `0,5,10,...,55`; never use `*/5 * * * *` style for minute-level schedules with this version

### Data consistency across environments
- Each server (local/dev/prod) has its own SQLite — counts will differ by recent events
- Gaps caused by missed syncs cannot be recovered if the cursor advanced past the ingestion window
- Use `POST /api/sync/backfill?days=N` on a server that's behind to catch up

## In-Memory Cache

- `Map<string, CachedEvent[]>` keyed by event_type, loaded from SQLite on startup
- Batched loading (50k rows per batch) with `setImmediate` between batches to not block event loop
- Incremental refresh after each sync via `id > maxId`
- Excludes `properties` blob to keep memory footprint small

## API Endpoints

- `GET /api/health` - health check
- `GET /api/stats` - event counts by type (from cache)
- `GET /api/events/:type` - all events for a type as `[lng, lat, weight]` tuples (from cache)
- `POST /api/sync` - trigger manual sync (all event types, incremental)
- `POST /api/sync/backfill?days=N` - re-sync all types from N days ago (default 30, max 365); fires in background
- `GET /api/quiz` - random quiz question (country or zone, random time period)
- `GET /api/dashboard` - aggregated stats by type/country/language/zone

## Frontend Routes

- `/` - landing page with navigation
- `/map` - full-screen MapLibre GL map with deck.gl HeatmapLayer, cinematic mode, event type dropdown
- `/dashboard` - aggregated stats by type, country, language, zones
- `/quiz` - country/zone trivia quiz with click-to-guess, confetti, history, shareable links
- `/live` - live event stream
- `/hot-right-now` - ST-DBSCAN hotspot clustering

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

## Deploy Pipeline

Visual explainer: https://visual-plans.safenow-experiments.com/others/heatbrothers-deploy-pipeline.html

### Servers

| | Dev | Prod |
|---|---|---|
| IP | 91.99.152.244 | 91.98.82.133 |
| SSH alias | `map-analytics-sn-old` | `jupyter-hetzner-sn` |
| SSH command | `ssh map-analytics-sn-old` | `ssh jupyter-hetzner-sn` |
| SSH port | 2222 | 2222 |
| User | ubuntu | ubuntu |
| Deploy strategy | Push-based (poll main) | Tag-based (poll for `v*` tags on main) |

### Deploy Mechanism

Both servers use **systemd user timers** polling every 2 minutes.

| File | Dev | Prod |
|---|---|---|
| Script | `/home/ubuntu/ci/deploy.sh` | `/home/ubuntu/ci/deploy.sh` |
| Timer | `~/.config/systemd/user/deploy.timer` | `~/.config/systemd/user/deploy.timer` |
| Service | `~/.config/systemd/user/deploy.service` | `~/.config/systemd/user/deploy.service` |
| Log | `/home/ubuntu/ci/deploy.log` | `/home/ubuntu/ci/deploy.log` |
| Tag tracker | N/A | `/home/ubuntu/ci/.current-tag` |

### How to Deploy

- **Dev**: Push to `main`. Timer picks it up within 2 min.
- **Prod**: Create a semver tag on main and push it.
  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```

### Common Operations

```bash
# Check timer status
ssh <server> 'systemctl --user status deploy.timer'

# Check last deploy run
ssh <server> 'systemctl --user status deploy.service'

# View recent deploy logs
ssh <server> 'tail -20 /home/ubuntu/ci/deploy.log'

# Check currently deployed tag (prod only)
ssh <server> 'cat /home/ubuntu/ci/.current-tag'

# Manually trigger a deploy
ssh <server> 'systemctl --user start deploy.service'

# Check app service
ssh <server> 'systemctl --user status heatbrothers'
```

### Log Rotation

Both `deploy.sh` scripts rotate `deploy.log` when it exceeds 100 MB (`mv deploy.log deploy.log.old`).

### Static HTML Files (Prod)

Visual explainers and static HTML are served from `/home/ubuntu/static-html-files/html/others/` on prod. To copy a new file:
```bash
scp -P 2222 docs/visuals/<file>.html ubuntu@91.98.82.133:/home/ubuntu/static-html-files/html/others/
```
