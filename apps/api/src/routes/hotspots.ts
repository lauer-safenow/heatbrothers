import { Router, type Router as RouterType } from "express";
import { getEventsByType, type CachedEvent } from "../cache.js";
import { geocode } from "../geocode.js";

export const hotspotsRouter: RouterType = Router();

const ALARM_TYPES = [
  "DETAILED_ALARM_STARTED_PRIVATE_GROUP",
  "DETAILED_ALARM_STARTED_ZONE",
];
const EDGE_DISTANCE_KM = 50;
const DEFAULT_LIMIT = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function lowerBound(arr: CachedEvent[], key: number): number {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface HotspotEntry {
  rank: number;
  lat: number;
  lng: number;
  degree: number;
  city: string;
  countryCode: string;
  timestamp: number;
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
}

const LOOKBACK_DAYS = 1;

interface HotspotResult {
  from: string;
  to: string;
  totalAlarms: number;
  countDE: number;
  countNonDE: number;
  hotspots: HotspotEntry[];
  hotspotsDE: HotspotEntry[];
}

/** Run graph + greedy extraction on a set of alarms, return up to maxResults hotspots. */
function extractHotspots(events: CachedEvent[], maxResults: number): HotspotEntry[] {
  if (events.length === 0) return [];

  // Spatial grid (~50km cells)
  const CELL_SIZE = 0.45;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const key = `${Math.floor(events[i].latitude / CELL_SIZE)},${Math.floor(events[i].longitude / CELL_SIZE)}`;
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  }

  // Degrees + adjacency
  const degree = new Int32Array(events.length);
  const adj: Set<number>[] = Array.from({ length: events.length }, () => new Set());
  for (const [key, indices] of grid) {
    const [r, c] = key.split(",").map(Number);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const neighborIndices = grid.get(`${r + dr},${c + dc}`);
        if (!neighborIndices) continue;
        for (const i of indices) {
          for (const j of neighborIndices) {
            if (j <= i) continue;
            if (haversineKm(events[i].latitude, events[i].longitude, events[j].latitude, events[j].longitude) <= EDGE_DISTANCE_KM) {
              degree[i]++;
              degree[j]++;
              adj[i].add(j);
              adj[j].add(i);
            }
          }
        }
      }
    }
  }

  // Greedy cluster extraction
  const consumed = new Set<number>();
  const candidates = Array.from({ length: events.length }, (_, i) => i)
    .filter((i) => degree[i] > 0)
    .sort((a, b) => degree[b] - degree[a]);

  const result: HotspotEntry[] = [];
  for (const i of candidates) {
    if (consumed.has(i)) continue;
    // Collect cluster members (this node + its neighbors)
    const cluster = [i, ...adj[i]];
    let minLat = events[i].latitude, maxLat = minLat;
    let minLng = events[i].longitude, maxLng = minLng;
    for (const n of adj[i]) {
      const { latitude, longitude } = events[n];
      if (latitude < minLat) minLat = latitude;
      if (latitude > maxLat) maxLat = latitude;
      if (longitude < minLng) minLng = longitude;
      if (longitude > maxLng) maxLng = longitude;
    }
    // Ensure bbox has a minimum visible size (~10km padding)
    const MIN_PAD = 0.1;
    if (maxLat - minLat < MIN_PAD) {
      const midLat = (minLat + maxLat) / 2;
      minLat = midLat - MIN_PAD / 2;
      maxLat = midLat + MIN_PAD / 2;
    }
    if (maxLng - minLng < MIN_PAD) {
      const midLng = (minLng + maxLng) / 2;
      minLng = midLng - MIN_PAD / 2;
      maxLng = midLng + MIN_PAD / 2;
    }
    const [city, countryCode] = geocode(events[i].latitude, events[i].longitude);
    result.push({
      rank: result.length + 1,
      lat: events[i].latitude,
      lng: events[i].longitude,
      degree: degree[i],
      city,
      countryCode,
      timestamp: events[i].timestamp,
      bbox: [minLng, minLat, maxLng, maxLat],
    });
    consumed.add(i);
    for (const n of cluster) consumed.add(n);
    if (result.length >= maxResults) break;
  }
  return result;
}

let cached: { result: HotspotResult; expiresAt: number; cacheKey: string } | null = null;

hotspotsRouter.get("/hotspots", (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string) || DEFAULT_LIMIT));

  // 10-day window ending yesterday
  const toDate = new Date();
  toDate.setUTCDate(toDate.getUTCDate() - 1);
  const fromDate = new Date(toDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - (LOOKBACK_DAYS - 1));

  const toKey = toDate.toISOString().slice(0, 10);
  const fromKey = fromDate.toISOString().slice(0, 10);
  const cacheKey = `${fromKey}_${toKey}`;

  // Check cache
  if (cached && cached.cacheKey === cacheKey && Date.now() < cached.expiresAt) {
    res.json({
      ...cached.result,
      hotspots: cached.result.hotspots.slice(0, limit),
      hotspotsDE: cached.result.hotspotsDE.slice(0, limit),
    });
    return;
  }

  // Timestamp range (UTC)
  const startTs = Math.floor(new Date(fromKey + "T00:00:00Z").getTime() / 1000);
  const endTs = Math.floor(new Date(toKey + "T00:00:00Z").getTime() / 1000) + 86400;

  // 1. Gather all alarms for the 10-day window
  const allAlarms: CachedEvent[] = [];
  for (const type of ALARM_TYPES) {
    const events = getEventsByType(type);
    const start = lowerBound(events, startTs);
    const end = lowerBound(events, endTs);
    for (let i = start; i < end; i++) {
      allAlarms.push(events[i]);
    }
  }
  const totalAlarms = allAlarms.length;

  // 2. Split into DE and non-DE
  const nonDE: CachedEvent[] = [];
  const deOnly: CachedEvent[] = [];
  for (const alarm of allAlarms) {
    const [, cc] = geocode(alarm.latitude, alarm.longitude);
    if (cc === "DE") deOnly.push(alarm);
    else nonDE.push(alarm);
  }

  // 3. Run graph extraction on both sets
  const hotspots = extractHotspots(nonDE, 20);
  const hotspotsDE = extractHotspots(deOnly, 20);

  const result: HotspotResult = {
    from: fromKey,
    to: toKey,
    totalAlarms,
    countDE: deOnly.length,
    countNonDE: nonDE.length,
    hotspots,
    hotspotsDE,
  };

  cached = { result, expiresAt: Date.now() + CACHE_TTL_MS, cacheKey };
  res.json({
    ...result,
    hotspots: hotspots.slice(0, limit),
    hotspotsDE: hotspotsDE.slice(0, limit),
  });
});
