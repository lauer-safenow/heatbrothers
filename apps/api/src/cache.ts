import { sqlite } from "@heatbrothers/db";
import { geocode } from "./geocode.js";

export interface CachedEvent {
  id: number;
  latitude: number;
  longitude: number;
  timestamp: number;
  pssId: string | null;
  pssName: string | null;
  distinctId: string;
}

const eventCache = new Map<string, CachedEvent[]>();
// event_type → country → count, built incrementally as events are cached
const countryCache = new Map<string, Map<string, number>>();
let maxId = 0;

const SELECT_COLS = `id, event_type, latitude, longitude, timestamp, pss_id, pss_name, distinct_id`;

interface EventRow {
  id: number;
  event_type: string;
  latitude: number;
  longitude: number;
  timestamp: number;
  pss_id: string | null;
  pss_name: string | null;
  distinct_id: string;
}

function rowToCached(row: EventRow): CachedEvent {
  return {
    id: row.id,
    latitude: row.latitude,
    longitude: row.longitude,
    timestamp: row.timestamp,
    pssId: row.pss_id,
    pssName: row.pss_name,
    distinctId: row.distinct_id,
  };
}

function appendRow(row: EventRow) {
  const list = eventCache.get(row.event_type);
  if (list) {
    list.push(rowToCached(row));
  } else {
    eventCache.set(row.event_type, [rowToCached(row)]);
  }
  if (row.id > maxId) maxId = row.id;

  const [, cc] = geocode(row.latitude, row.longitude);
  const country = cc || "Unknown";
  let typeMap = countryCache.get(row.event_type);
  if (!typeMap) { typeMap = new Map(); countryCache.set(row.event_type, typeMap); }
  typeMap.set(country, (typeMap.get(country) ?? 0) + 1);
}

const BATCH_SIZE = 50_000;

const batchStmt = sqlite.prepare(
  `SELECT ${SELECT_COLS} FROM events WHERE id > @maxId ORDER BY id ASC LIMIT @limit`,
);

export function loadCache(): Promise<void> {
  return new Promise((resolve) => {
    console.log("[cache] Starting cache load from SQLite...");
    const start = Date.now();

    eventCache.clear();
    countryCache.clear();
    maxId = 0;
    let total = 0;

    function loadBatch() {
      const rows = batchStmt.all({ maxId, limit: BATCH_SIZE }) as EventRow[];
      for (const row of rows) {
        appendRow(row);
      }
      total += rows.length;

      if (rows.length > 0) {
        console.log(`[cache]   ...${total.toLocaleString()} rows loaded (${Date.now() - start}ms)`);
      }

      if (rows.length === BATCH_SIZE) {
        // yield to event loop so Express can serve requests, then continue
        setImmediate(loadBatch);
      } else {
        const elapsed = Date.now() - start;
        const types = [...eventCache.entries()].map(([t, es]) => `${t}: ${es.length.toLocaleString()}`).join(", ");
        console.log(`[cache] Done: ${total.toLocaleString()} events in ${elapsed}ms (${types})`);
        resolve();
      }
    }

    loadBatch();
  });
}

export function refreshCache() {
  const rows = batchStmt.all({ maxId, limit: -1 }) as EventRow[];

  if (rows.length > 0) {
    for (const row of rows) appendRow(row);
    console.log(`Cache refreshed: +${rows.length} events (maxId=${maxId})`);
  }
}

export function getEventsByType(eventType: string): CachedEvent[] {
  return eventCache.get(eventType) ?? [];
}

export function getAllEvents(): Map<string, CachedEvent[]> {
  return eventCache;
}

export function getCountryStats(eventTypes?: string[]): { country: string; count: number }[] {
  const totals = new Map<string, number>();
  const types = eventTypes ?? [...countryCache.keys()];
  for (const et of types) {
    const typeMap = countryCache.get(et);
    if (!typeMap) continue;
    for (const [country, count] of typeMap) {
      totals.set(country, (totals.get(country) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count);
}

export function getStats(): { total: number; byType: { event_type: string; count: number }[] } {
  const byType = [...eventCache.entries()]
    .map(([event_type, events]) => ({ event_type, count: events.length }))
    .sort((a, b) => b.count - a.count);

  const total = byType.reduce((sum, r) => sum + r.count, 0);
  return { total, byType };
}
