import { Router } from "express";
import { getEventsByType, type CachedEvent } from "../cache.js";
import { geocode } from "../geocode.js";
import { REPLAY_MAX_EVENTS } from "@heatbrothers/shared";

export const eventsRouter = Router();

function eventTuple(e: CachedEvent): [number, number, number, number, string, string] {
  const [city, cc] = geocode(e.latitude, e.longitude);
  return [e.longitude, e.latitude, e.timestamp, e.id, city, cc];
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
