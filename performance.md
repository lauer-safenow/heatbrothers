# Performance Improvements Plan

## Context

The heatbrothers app serves ~1M cached events to a deck.gl heatmap frontend, runs ST-DBSCAN clustering for hotspot detection, and syncs from PostHog every 30s. It runs on a 2GB Ubuntu VM via Docker (1.5GB memory limit).

A Bun migration was evaluated and rejected — the runtime isn't the bottleneck. These are the changes that actually matter.

---

## Tasks

### 1. Add gzip compression (5 min)

**Problem:** The Express server has zero response compression. `/api/events/:type` returns ~1M 3-tuples as raw JSON — roughly 25-35MB uncompressed per request.

**File:** `apps/api/src/index.ts`

```bash
pnpm --filter @heatbrothers/api add compression
pnpm --filter @heatbrothers/api add -D @types/compression
```

```ts
import compression from "compression";
app.use(compression()); // add before routes
```

**Expected impact:** 3-4x smaller responses (35MB → ~8MB).

**Verify:** `curl -H 'Accept-Encoding: gzip' -sD- http://localhost:3000/api/events/FIRST_TIME_PHONE_STATUS_SENT | head -20` — look for `Content-Encoding: gzip` header.

- [ ] Done

---

### 2. Add composite DB index (event_type, timestamp) (10 min)

**Problem:** Time-range queries filter by event_type + timestamp. These columns have separate indexes but no composite index, so SQLite can only use one.

**File:** `packages/db/prisma/schema.prisma`

Add to the `Event` model:

```prisma
@@index([eventType, timestamp], name: "idx_event_type_timestamp")
```

Then run:

```bash
pnpm db:migrate
```

**Verify:** `sqlite3 data/heatbrothers.db ".indexes events"` — confirm `idx_event_type_timestamp` exists.

- [ ] Done

---

### 3. Cache rangeQuery() results in ST-DBSCAN (30 min)

**Problem:** In `apps/api/src/routes/hotspots.ts`, `extractHotspots()` calls `rangeQuery()` in three phases:

1. DBSCAN expansion (lines 138, 161) — necessary
2. Find densest seed point (line 190) — re-calls `rangeQuery(m)` for every cluster member
3. Build edges (line 221) — re-calls `rangeQuery(n)` for every cluster member again

For a 200-member cluster, that's ~400 redundant range queries.

**Fix:** Add a cache inside `extractHotspots()`:

```ts
const neighborCache = new Map<number, number[]>();
function cachedRangeQuery(idx: number): number[] {
  let result = neighborCache.get(idx);
  if (!result) {
    result = rangeQuery(idx);
    neighborCache.set(idx, result);
  }
  return result;
}
```

Replace all `rangeQuery()` calls with `cachedRangeQuery()`.

**Verify:** Add `console.time("hotspots")` / `console.timeEnd("hotspots")` around `extractHotspots()` — compare before/after.

- [ ] Done

---

### 4. Replace https.get with fetch() in news.ts (15 min)

**Problem:** `apps/api/src/routes/news.ts` (lines 48-71) uses a hand-rolled `https.get()` wrapper with manual redirect following, timeout handling, and stream concatenation. Node 22 has native `fetch()`.

**Fix:** Replace the `httpsGet()` function:

```ts
async function httpsGet(url: string, timeoutMs = 10_000): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  return res.text();
}
```

Remove `import https from "https";` at the top.

**Verify:** Hit `GET /api/news?city=Berlin&country=DE` — confirm articles still return.

- [ ] Done

---

### 5. Cap news cache to prevent memory leak (10 min)

**Problem:** The news cache at `apps/api/src/routes/news.ts:34` is an unbounded `Map`. Each unique query combination creates an entry that only expires by TTL. Over weeks, this grows without limit on the 2GB VM.

**Fix:** Add size check before inserting:

```ts
const MAX_CACHE_SIZE = 500;

// Before each cache.set():
if (cache.size >= MAX_CACHE_SIZE) {
  const firstKey = cache.keys().next().value;
  if (firstKey) cache.delete(firstKey);
}
```

**Verify:** Confirm `cache.size` stays bounded after many varied requests.

- [ ] Done

---

### 6. Avoid object copy in cache load (20 min)

**Problem:** `apps/api/src/cache.ts:27-36` — `rowToCached()` creates a new object per row just to rename `pss_id` → `pssId`. With 1M rows, that's 1M unnecessary allocations.

**Fix:** Use SQL column aliases so the query returns the right field names directly:

```ts
const SELECT_COLS = `id, event_type, latitude, longitude, timestamp, pss_id as pssId, pss_name as pssName`;
```

Then push rows directly without `rowToCached()`:

```ts
function appendRow(row: CachedEvent & { event_type: string }) {
  const list = eventCache.get(row.event_type);
  if (list) list.push(row);
  else eventCache.set(row.event_type, [row]);
  if (row.id > maxId) maxId = row.id;
}
```

Update the `EventRow` interface or remove it entirely.

**Verify:** Check `[cache] Done:` log — compare load time before/after.

- [ ] Done

---

### 7. Pre-warm geocode cache at startup (15 min)

**Problem:** `apps/api/src/routes/events.ts:8-11` — the `/since` and `/between` endpoints call `geocode()` per event. The geocode function has its own Map cache, but the first request after startup hits cold cache for all coordinates.

**Fix:** After `loadCache()` completes in `apps/api/src/index.ts`, iterate all cached events and call `geocode()` once per unique coordinate:

```ts
await loadCache();

// Pre-warm geocode cache
const allEvents = getAllEvents();
for (const [, events] of allEvents) {
  for (const e of events) {
    geocode(e.latitude, e.longitude);
  }
}
console.log("[geocoder] Cache pre-warmed");
```

This is idempotent — the geocode function deduplicates by `lat.toFixed(2),lng.toFixed(2)`.

**Verify:** First request to `/api/events/:type/since/:ts` should be fast (no cold-start penalty).

- [ ] Done

---

### 8. Replace tsx with Node 22 --experimental-strip-types (30 min)

**Problem:** `tsx` is a dev dependency used solely to run TypeScript without building. Node 22.6+ has built-in `--experimental-strip-types` that does the same thing natively.

**Files to change:**

`apps/api/package.json`:
```json
"dev": "node --experimental-strip-types --watch --watch-ignore '../web/node_modules/**' src/index.ts",
"serve": "NODE_ENV=production node --experimental-strip-types src/index.ts",
"sync": "node --experimental-strip-types src/sync/run-sync.ts"
```

Then remove `tsx` from devDependencies in `apps/api/package.json` and `packages/db/package.json`.

Update the Dockerfile if `tsx` is referenced anywhere.

**Caveat:** The codebase uses `.js` extensions in imports (e.g., `./env.js`). Node's type stripping resolves `.ts` files imported as `.js`, so this should just work. If it doesn't, try `--experimental-transform-types` instead.

**Verify:** `pnpm serve` starts correctly, `GET /api/health` returns `{"status":"ok"}`.

- [ ] Done

---

## Summary

| # | Task | Effort | Impact |
|---|---|---|---|
| 1 | gzip compression | 5 min | **HIGH** — 3-4x smaller responses |
| 2 | Composite DB index | 10 min | Medium — faster time-range queries |
| 3 | Cache rangeQuery() in ST-DBSCAN | 30 min | **HIGH** — 2-3x faster hotspots |
| 4 | Replace https.get with fetch() | 15 min | Medium — cleaner, fewer bugs |
| 5 | Cap news cache size | 10 min | Medium — prevents memory leak |
| 6 | Avoid object copy in cache load | 20 min | Medium — faster startup, less GC |
| 7 | Pre-warm geocode cache | 15 min | Low-Medium — faster first request |
| 8 | Replace tsx with strip-types | 30 min | Low — fewer deps, slightly faster |

**Total: ~2.5 hours, zero architectural risk.**
