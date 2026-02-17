import { Router } from "express";
import { getEventsByType, type CachedEvent } from "../cache.js";
import { REPLAY_MAX_EVENTS } from "@heatbrothers/shared";

export const eventsRouter = Router();

/** Returns the first index where arr[i][field] >= key. Array must be sorted ascending by field. */
function lowerBound(arr: CachedEvent[], field: "id" | "timestamp", key: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid][field] as number) < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}

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
    events: newer.map((e) => [e.longitude, e.latitude, e.timestamp, e.id]),
  });
});

eventsRouter.get("/events/:type/after/:id", (req, res) => {
  const afterId = parseInt(req.params.id, 10);
  if (isNaN(afterId)) { res.status(400).json({ error: "invalid id" }); return; }
  const all = getEventsByType(req.params.type);
  const newer = all.slice(lowerBound(all, "id", afterId + 1));
  res.json({
    count: newer.length,
    events: newer.map((e) => [e.longitude, e.latitude, e.timestamp, e.id]),
  });
});

eventsRouter.get("/events/:type/between/:from/:to", (req, res) => {
  const from = parseInt(req.params.from, 10);
  const to = parseInt(req.params.to, 10);
  if (isNaN(from) || isNaN(to)) { res.status(400).json({ error: "invalid timestamps" }); return; }
  const all = getEventsByType(req.params.type);
  const start = lowerBound(all, "timestamp", from);
  const end = lowerBound(all, "timestamp", to + 1);
  const range = all.slice(start, end);
  const capped = range.length > REPLAY_MAX_EVENTS;
  const events = capped ? range.slice(0, REPLAY_MAX_EVENTS) : range;
  res.json({
    count: events.length,
    total: range.length,
    capped,
    events: events.map((e) => [e.longitude, e.latitude, e.timestamp, e.id]),
  });
});

eventsRouter.get("/events/:type/maxid", (req, res) => {
  const all = getEventsByType(req.params.type);
  const maxId = all.length > 0 ? all[all.length - 1].id : 0;
  res.json({ maxId });
});
