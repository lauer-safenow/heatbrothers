import { Router, type Router as RouterType } from "express";
import { getEventsByType, type CachedEvent } from "../cache.js";
import { geocode } from "../geocode.js";

export const hotspotsRouter: RouterType = Router();

const ALARM_TYPES = [
  "DETAILED_ALARM_STARTED_PRIVATE_GROUP",
  "DETAILED_ALARM_STARTED_ZONE",
];
const EDGE_DISTANCE_KM = 3;
const MIN_PTS = 3; // DBSCAN: minimum neighbors (incl. self) for a core point
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
  nodes: [number, number][]; // [lng, lat]
  edges: [number, number, number, number][]; // [srcLng, srcLat, dstLng, dstLat]
}

const LOOKBACK_DAYS = 5;

const DACH_NO_DE = new Set(["AT", "CH"]);

interface HotspotResult {
  from: string;
  to: string;
  totalAlarms: number;
  countDE: number;
  countDACH: number;
  countWorld: number;
  hotspotsDE: HotspotEntry[];
  hotspotsDACH: HotspotEntry[];
  hotspotsWorld: HotspotEntry[];
}

/** DBSCAN clustering: extract density-connected hotspots, return up to maxResults. */
function extractHotspots(events: CachedEvent[], maxResults: number, minPts: number = MIN_PTS): HotspotEntry[] {
  if (events.length === 0) return [];

  const eps = EDGE_DISTANCE_KM;

  // 1. Spatial grid for efficient range queries
  // 0.045° ≈ 3.2km at 55°N — ensures ±1 cell covers eps at European latitudes
  const CELL_SIZE = 0.045;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const key = `${Math.floor(events[i].latitude / CELL_SIZE)},${Math.floor(events[i].longitude / CELL_SIZE)}`;
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  }

  // 2. Range query: all indices within eps km of point idx
  function rangeQuery(idx: number): number[] {
    const ev = events[idx];
    const r = Math.floor(ev.latitude / CELL_SIZE);
    const c = Math.floor(ev.longitude / CELL_SIZE);
    const result: number[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cell = grid.get(`${r + dr},${c + dc}`);
        if (!cell) continue;
        for (const j of cell) {
          if (haversineKm(ev.latitude, ev.longitude, events[j].latitude, events[j].longitude) <= eps) {
            result.push(j);
          }
        }
      }
    }
    return result;
  }

  // 3. DBSCAN
  const NOISE = -1;
  const UNVISITED = -2;
  const label = new Int32Array(events.length).fill(UNVISITED);
  let clusterId = 0;

  for (let i = 0; i < events.length; i++) {
    if (label[i] !== UNVISITED) continue;

    const neighbors = rangeQuery(i);
    if (neighbors.length < minPts) {
      label[i] = NOISE;
      continue;
    }

    // New cluster
    const cId = clusterId++;
    label[i] = cId;

    const seedQueue = neighbors.filter((j) => j !== i);
    let head = 0;

    while (head < seedQueue.length) {
      const q = seedQueue[head++];

      if (label[q] === NOISE) {
        label[q] = cId; // reclaim noise as border point
        continue;
      }
      if (label[q] !== UNVISITED) continue; // already assigned

      label[q] = cId;
      const qNeighbors = rangeQuery(q);
      if (qNeighbors.length >= minPts) {
        // Core point — expand
        for (const n of qNeighbors) {
          if (label[n] === UNVISITED || label[n] === NOISE) {
            seedQueue.push(n);
          }
        }
      }
    }
  }

  // 4. Group indices by cluster label (skip noise)
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < events.length; i++) {
    if (label[i] < 0) continue;
    const list = clusters.get(label[i]);
    if (list) list.push(i);
    else clusters.set(label[i], [i]);
  }

  // 5. Build HotspotEntry per cluster
  const result: HotspotEntry[] = [];

  for (const [, members] of clusters) {
    // Seed = densest point (most neighbors within eps)
    let seedIdx = members[0];
    let maxCount = 0;
    for (const m of members) {
      const count = rangeQuery(m).length;
      if (count > maxCount) { maxCount = count; seedIdx = m; }
    }

    // Bounding box
    let minLat = events[members[0]].latitude, maxLat = minLat;
    let minLng = events[members[0]].longitude, maxLng = minLng;
    for (const n of members) {
      const { latitude, longitude } = events[n];
      if (latitude < minLat) minLat = latitude;
      if (latitude > maxLat) maxLat = latitude;
      if (longitude < minLng) minLng = longitude;
      if (longitude > maxLng) maxLng = longitude;
    }
    const MIN_PAD = 0.1;
    if (maxLat - minLat < MIN_PAD) {
      const mid = (minLat + maxLat) / 2;
      minLat = mid - MIN_PAD / 2;
      maxLat = mid + MIN_PAD / 2;
    }
    if (maxLng - minLng < MIN_PAD) {
      const mid = (minLng + maxLng) / 2;
      minLng = mid - MIN_PAD / 2;
      maxLng = mid + MIN_PAD / 2;
    }

    // Nodes & edges for visualization
    const nodes: [number, number][] = members.map((n) => [events[n].longitude, events[n].latitude]);
    const memberSet = new Set(members);
    const edges: [number, number, number, number][] = [];
    for (const n of members) {
      for (const m of rangeQuery(n)) {
        if (m > n && memberSet.has(m)) {
          edges.push([events[n].longitude, events[n].latitude, events[m].longitude, events[m].latitude]);
        }
      }
    }

    const [city, countryCode] = geocode(events[seedIdx].latitude, events[seedIdx].longitude);
    result.push({
      rank: 0,
      lat: events[seedIdx].latitude,
      lng: events[seedIdx].longitude,
      degree: members.length,
      city,
      countryCode,
      timestamp: events[seedIdx].timestamp,
      bbox: [minLng, minLat, maxLng, maxLat],
      nodes,
      edges,
    });
  }

  // 6. Sort by cluster size, assign ranks, return top N
  result.sort((a, b) => b.degree - a.degree);
  const top = result.slice(0, maxResults);
  for (let r = 0; r < top.length; r++) top[r].rank = r + 1;
  return top;
}

let cached: { result: HotspotResult; expiresAt: number; cacheKey: string } | null = null;

hotspotsRouter.get("/hotspots", (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string) || DEFAULT_LIMIT));
  const minPts = Math.min(20, Math.max(2, parseInt(req.query.minPts as string) || MIN_PTS));

  // 10-day window ending yesterday
  const toDate = new Date();
  toDate.setUTCDate(toDate.getUTCDate() - 1);
  const fromDate = new Date(toDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - (LOOKBACK_DAYS - 1));

  const toKey = toDate.toISOString().slice(0, 10);
  const fromKey = fromDate.toISOString().slice(0, 10);
  const cacheKey = `${fromKey}_${toKey}_mp${minPts}`;

  // Check cache
  if (cached && cached.cacheKey === cacheKey && Date.now() < cached.expiresAt) {
    res.json({
      ...cached.result,
      hotspotsDE: cached.result.hotspotsDE.slice(0, limit),
      hotspotsDACH: cached.result.hotspotsDACH.slice(0, limit),
      hotspotsWorld: cached.result.hotspotsWorld.slice(0, limit),
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

  // 2. Split into DE, DACH (AT+CH), and World
  const deOnly: CachedEvent[] = [];
  const dachOnly: CachedEvent[] = [];
  const world: CachedEvent[] = [];
  for (const alarm of allAlarms) {
    const [, cc] = geocode(alarm.latitude, alarm.longitude);
    if (cc === "DE") deOnly.push(alarm);
    else if (DACH_NO_DE.has(cc)) dachOnly.push(alarm);
    else world.push(alarm);
  }

  // 3. DBSCAN clustering on all three sets
  console.log(`[hotspots] DBSCAN minPts=${minPts} eps=${EDGE_DISTANCE_KM}km — ${totalAlarms} alarms (DE:${deOnly.length} DACH:${dachOnly.length} World:${world.length})`);
  const hotspotsDE = extractHotspots(deOnly, 20, minPts);
  const hotspotsDACH = extractHotspots(dachOnly, 20, minPts);
  const hotspotsWorld = extractHotspots(world, 20, minPts);
  console.log(`[hotspots] DBSCAN done — DE:${hotspotsDE.length} DACH:${hotspotsDACH.length} World:${hotspotsWorld.length} clusters`);

  const result: HotspotResult = {
    from: fromKey,
    to: toKey,
    totalAlarms,
    countDE: deOnly.length,
    countDACH: dachOnly.length,
    countWorld: world.length,
    hotspotsDE,
    hotspotsDACH,
    hotspotsWorld,
  };

  cached = { result, expiresAt: Date.now() + CACHE_TTL_MS, cacheKey };
  res.json({
    ...result,
    hotspotsDE: hotspotsDE.slice(0, limit),
    hotspotsDACH: hotspotsDACH.slice(0, limit),
    hotspotsWorld: hotspotsWorld.slice(0, limit),
  });
});
