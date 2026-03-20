import { Router } from "express";
import { getEventsByType, type CachedEvent } from "../cache.js";
import { geocode } from "../geocode.js";
import { pointInPolygon } from "../pointInPolygon.js";
import { sqlite } from "@heatbrothers/db";
import { REPLAY_MAX_EVENTS } from "@heatbrothers/shared";

export const eventsRouter = Router();

function eventTuple(e: CachedEvent): [number, number, number, number, string, string, string] {
  const [city, cc] = geocode(e.latitude, e.longitude);
  return [e.longitude, e.latitude, e.timestamp, e.id, city, cc, e.distinctId];
}

/** Returns the first index where arr[i][field] >= key. Array must be sorted ascending by field. */
function lowerBound(arr: CachedEvent[], field: "id" | "timestamp", key: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid][field] as number) < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const DISPLAY_NAMES: Record<string, string> = {
  DETAILED_ALARM_STARTED_PRIVATE_GROUP: "Alarm",
  DETAILED_ATTENTION_STARTED_PRIVATE_GROUP: "Attention",
  app_opening_ZONE: "App opening (zone)",
  FIRST_TIME_PHONE_STATUS_SENT: "Installed",
  DETAILED_ALARM_STARTED_ZONE: "Alarm (zone)",
};

const userEventsStmt = sqlite.prepare(
  `SELECT event_type, timestamp, latitude, longitude, pss_name, alarm_source, event_source FROM events WHERE distinct_id = ? ORDER BY timestamp ASC`,
);

interface UserEventRow {
  event_type: string;
  timestamp: number;
  latitude: number;
  longitude: number;
  pss_name: string | null;
  alarm_source: string | null;
  event_source: string | null;
}

eventsRouter.get("/events/user/:distinctId", (req, res) => {
  const rows = userEventsStmt.all(req.params.distinctId) as UserEventRow[];
  const events = rows.map((r) => {
    const [city, cc] = geocode(r.latitude, r.longitude);
    return {
      type: r.event_type,
      displayName: DISPLAY_NAMES[r.event_type] ?? r.event_type,
      timestamp: r.timestamp,
      city,
      countryCode: cc,
      pssName: r.pss_name ?? undefined,
      alarmSource: r.alarm_source ?? undefined,
      eventSource: r.event_source ?? undefined,
    };
  });
  res.json({ count: events.length, events });
});

// ── CSV export (all columns from DB) ──

interface ExportRow {
  id: number;
  posthog_id: string;
  event_type: string;
  latitude: number;
  longitude: number;
  geohash: string | null;
  timestamp: number;
  posthog_ts: string;
  distinct_id: string;
  env: string;
  event_source: string | null;
  pss_id: string | null;
  pss_name: string | null;
  pss_type: string | null;
  company_name: string | null;
  alarm_source: string | null;
  created_at: number;
}

const CSV_HEADER = "id,eventType,latitude,longitude,pssId,pssName,companyName,alarmSource,createdAt";

function csvEscape(val: string | number | null | undefined): string {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

eventsRouter.get("/events/export", (req, res) => {
  const type = (req.query.type as string) || null;
  const from = req.query.from ? parseInt(req.query.from as string, 10) : null;
  const to = req.query.to ? parseInt(req.query.to as string, 10) : null;

  let poly: [number, number][] | null = null;
  if (req.query.poly) {
    try {
      poly = JSON.parse(req.query.poly as string);
    } catch { /* ignore */ }
  }

  // Build SQL query with optional type + time filter
  let sql = `SELECT * FROM events`;
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (type) {
    clauses.push(`event_type = ?`);
    params.push(type);
  }
  if (from != null && !isNaN(from)) {
    clauses.push(`timestamp >= ?`);
    params.push(from);
  }
  if (to != null && !isNaN(to)) {
    clauses.push(`timestamp < ?`);
    params.push(to);
  }

  if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += ` ORDER BY timestamp ASC`;

  const rows = sqlite.prepare(sql).all(...params) as ExportRow[];

  // Apply polygon filter if provided
  let filtered = rows;
  if (poly && poly.length >= 3) {
    filtered = rows.filter((r) => pointInPolygon([r.longitude, r.latitude], poly!));
  }

  // Generate filename: SafeNow_World_EventType_timestamp.csv
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `SafeNow_World_${now}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  res.write(CSV_HEADER + "\n");

  for (const r of filtered) {
    const line = [
      r.id,
      csvEscape(DISPLAY_NAMES[r.event_type] ?? r.event_type),
      r.latitude,
      r.longitude,
      csvEscape(r.pss_id),
      csvEscape(r.pss_name),
      csvEscape(r.company_name),
      csvEscape(r.alarm_source),
      csvEscape(new Date(r.created_at * 1000).toISOString()),
    ].join(",");
    res.write(line + "\n");
  }

  res.end();
});

eventsRouter.get("/events/:type", (req, res) => {
  const events = getEventsByType(req.params.type);
  res.json({
    count: events.length,
    events: events.map((e) => [e.longitude, e.latitude, e.timestamp]),
  });
});

eventsRouter.get("/events/:type/since/:ts", (req, res) => {
  const since = parseInt(req.params.ts, 10);
  if (isNaN(since)) { res.status(400).json({ error: "invalid timestamp" }); return; }
  const all = getEventsByType(req.params.type);
  const newer = all.slice(lowerBound(all, "timestamp", since + 1));
  res.json({
    count: newer.length,
    events: newer.map(eventTuple),
  });
});

eventsRouter.get("/events/:type/after/:id", (req, res) => {
  const afterId = parseInt(req.params.id, 10);
  if (isNaN(afterId)) { res.status(400).json({ error: "invalid id" }); return; }
  const all = getEventsByType(req.params.type);
  const newer = all.slice(lowerBound(all, "id", afterId + 1));
  res.json({
    count: newer.length,
    events: newer.map(eventTuple),
  });
});

eventsRouter.get("/events/:type/between/:from/:to", (req, res) => {
  const from = parseInt(req.params.from, 10);
  const to = parseInt(req.params.to, 10);
  if (isNaN(from) || isNaN(to)) { res.status(400).json({ error: "invalid timestamps" }); return; }
  const all = getEventsByType(req.params.type);
  const start = lowerBound(all, "timestamp", from);
  const end = lowerBound(all, "timestamp", to + 1);
  let range = all.slice(start, end);

  // Optional bounding-box filter (minLng,minLat,maxLng,maxLat)
  const bboxParam = req.query.bbox as string | undefined;
  if (bboxParam) {
    const parts = bboxParam.split(",").map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      const [minLng, minLat, maxLng, maxLat] = parts;
      range = range.filter((e) =>
        e.longitude >= minLng && e.longitude <= maxLng &&
        e.latitude >= minLat && e.latitude <= maxLat,
      );
    }
  }

  const total = range.length;
  const capped = total > REPLAY_MAX_EVENTS;
  const events = capped ? range.slice(0, REPLAY_MAX_EVENTS) : range;
  res.json({
    count: events.length,
    total,
    capped,
    events: events.map(eventTuple),
  });
});

eventsRouter.get("/events/:type/maxid", (req, res) => {
  const all = getEventsByType(req.params.type);
  const maxId = all.length > 0 ? all[all.length - 1].id : 0;
  res.json({ maxId });
});
