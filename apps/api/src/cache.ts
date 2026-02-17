import { sqlite } from "@heatbrothers/db";

export interface CachedEvent {
  id: number;
  latitude: number;
  longitude: number;
  geohash: string | null;
  timestamp: number;
  distinctId: string;
  eventSource: string | null;
  pssId: string | null;
  pssName: string | null;
  pssType: string | null;
  companyName: string | null;
  alarmSource: string | null;
}

const eventCache = new Map<string, CachedEvent[]>();
let maxId = 0;

const SELECT_COLS = `
  id, event_type, latitude, longitude, geohash, timestamp,
  distinct_id, event_source, pss_id, pss_name, pss_type,
  company_name, alarm_source
`;

interface EventRow {
  id: number;
  event_type: string;
  latitude: number;
  longitude: number;
  geohash: string | null;
  timestamp: number;
  distinct_id: string;
  event_source: string | null;
  pss_id: string | null;
  pss_name: string | null;
  pss_type: string | null;
  company_name: string | null;
  alarm_source: string | null;
}

function rowToCached(row: EventRow): CachedEvent {
  return {
    id: row.id,
    latitude: row.latitude,
    longitude: row.longitude,
    geohash: row.geohash,
    timestamp: row.timestamp,
    distinctId: row.distinct_id,
    eventSource: row.event_source,
    pssId: row.pss_id,
    pssName: row.pss_name,
    pssType: row.pss_type,
    companyName: row.company_name,
    alarmSource: row.alarm_source,
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
}

const BATCH_SIZE = 50_000;

const batchStmt = sqlite.prepare(
  `SELECT ${SELECT_COLS} FROM events WHERE id > @maxId ORDER BY id ASC LIMIT @limit`,
);

export function loadCache() {
  console.log("[cache] Starting cache load from SQLite...");
  const start = Date.now();

  eventCache.clear();
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
    }
  }

  loadBatch();
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

export function getStats(): { total: number; byType: { event_type: string; count: number }[] } {
  const byType = [...eventCache.entries()]
    .map(([event_type, events]) => ({ event_type, count: events.length }))
    .sort((a, b) => b.count - a.count);

  const total = byType.reduce((sum, r) => sum + r.count, 0);
  return { total, byType };
}
