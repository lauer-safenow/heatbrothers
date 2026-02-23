import { Router, type Router as RouterType } from "express";
import { getEventsByType, type CachedEvent } from "../cache.js";
import { geocode } from "../geocode.js";
import { getZonesMap } from "./zones.js";

export const hotspotsRouter: RouterType = Router();

const DEFAULT_TYPE = "DETAILED_ALARM_STARTED_PRIVATE_GROUP";
function isZoneType(t: string) { return t.endsWith("_ZONE"); }
const EDGE_DISTANCE_KM = 3;
const EPS_TEMPORAL_S = 2 * 3600; // ST-DBSCAN: temporal epsilon (2 hours in seconds)
const MIN_PTS = 3; // ST-DBSCAN: minimum neighbors (incl. self) for a core point
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
  nearbyCities: string[];
  zoneName?: string;
  zoneId?: string;
  zonePolygon?: number[][];
}

function parseAreaJson(raw: unknown): number[][] | null {
  let parsed = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "Feature") {
    const geom = obj.geometry as Record<string, unknown>;
    return (geom.coordinates as number[][][])[0];
  }
  if (obj.type === "Polygon") {
    return (obj.coordinates as number[][][])[0];
  }
  if (Array.isArray(parsed)) return parsed as number[][];
  return null;
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

/** ST-DBSCAN: spatiotemporal density clustering. Neighbors must be close in both space AND time. */
function extractHotspots(events: CachedEvent[], maxResults: number, minPts: number = MIN_PTS, epsTemporal: number = EPS_TEMPORAL_S, epsKm: number = EDGE_DISTANCE_KM): HotspotEntry[] {
  if (events.length === 0) return [];

  const eps = epsKm;

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

  // 2. Range query: all indices within eps km AND epsTemporal seconds of point idx
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
          if (
            Math.abs(ev.timestamp - events[j].timestamp) <= epsTemporal &&
            haversineKm(ev.latitude, ev.longitude, events[j].latitude, events[j].longitude) <= eps
          ) {
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

    // Sample up to 8 evenly-spaced nodes to get nearby city names
    const citySet = new Set<string>([city]);
    const step = Math.max(1, Math.floor(members.length / 8));
    for (let i = 0; i < members.length; i += step) {
      const [c] = geocode(events[members[i]].latitude, events[members[i]].longitude);
      if (c !== "Unknown") citySet.add(c);
    }
    // Also sample offset points (~20km) from cluster center in 8 directions
    // to capture nearby larger cities beyond the cluster's own extent
    const centerLat = events[seedIdx].latitude;
    const centerLng = events[seedIdx].longitude;
    const OFFSET = 0.2; // ~22km N/S, ~14km E/W at European latitudes
    const D = OFFSET * 0.707; // diagonal offset
    for (const [dLat, dLng] of [
      [OFFSET, 0], [-OFFSET, 0], [0, OFFSET], [0, -OFFSET],
      [D, D], [D, -D], [-D, D], [-D, -D],
    ]) {
      const [c] = geocode(centerLat + dLat, centerLng + dLng);
      if (c !== "Unknown") citySet.add(c);
    }
    const nearbyCities = [...citySet].filter((c) => c !== "Unknown");

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
      nearbyCities,
    });
  }

  // 6. Sort by cluster size, assign ranks, return top N
  result.sort((a, b) => b.degree - a.degree);
  const top = result.slice(0, maxResults);
  for (let r = 0; r < top.length; r++) top[r].rank = r + 1;
  return top;
}

let cached: { result: HotspotResult; expiresAt: number; cacheKey: string } | null = null;

hotspotsRouter.get("/hotspots", async (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string) || DEFAULT_LIMIT));
  const minPts = Math.min(20, Math.max(2, parseInt(req.query.minPts as string) || MIN_PTS));
  const epsHours = Math.min(120, Math.max(0.5, parseFloat(req.query.epsHours as string) || (EPS_TEMPORAL_S / 3600)));
  const epsTemporal = Math.round(epsHours * 3600);
  const lookbackDays = Math.min(30, Math.max(1, parseInt(req.query.lookbackDays as string) || LOOKBACK_DAYS));
  const epsKm = Math.min(50, Math.max(0.5, parseFloat(req.query.epsKm as string) || EDGE_DISTANCE_KM));
  const typeParam = req.query.type as string | undefined;
  const alarmType = typeParam && getEventsByType(typeParam).length > 0 ? typeParam : DEFAULT_TYPE;
  const isZoneMode = isZoneType(alarmType);

  // Lookback window ending yesterday
  const toDate = new Date();
  toDate.setUTCDate(toDate.getUTCDate() - 1);
  const fromDate = new Date(toDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - (lookbackDays - 1));

  const toKey = toDate.toISOString().slice(0, 10);
  const fromKey = fromDate.toISOString().slice(0, 10);
  const cacheKey = `${fromKey}_${toKey}_mp${minPts}_et${epsTemporal}_ek${epsKm}_t${alarmType}`;

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

  // 1. Gather all alarms for the lookback window
  const allAlarms: CachedEvent[] = [];
  {
    const events = getEventsByType(alarmType);
    const start = lowerBound(events, startTs);
    const end = lowerBound(events, endTs);
    for (let i = start; i < end; i++) {
      allAlarms.push(events[i]);
    }
  }
  const totalAlarms = allAlarms.length;

  let hotspotsDE: HotspotEntry[];
  let hotspotsDACH: HotspotEntry[];
  let hotspotsWorld: HotspotEntry[];
  let countDE: number;
  let countDACH: number;
  let countWorld: number;

  if (isZoneMode) {
    // Zone mode: partition by pssId, cluster within each zone independently
    const byZone = new Map<string, CachedEvent[]>();
    for (const alarm of allAlarms) {
      if (!alarm.pssId) continue;
      const list = byZone.get(alarm.pssId);
      if (list) list.push(alarm);
      else byZone.set(alarm.pssId, [alarm]);
    }

    const zonesMap = await getZonesMap();
    const allZoneHotspots: HotspotEntry[] = [];

    for (const [pssId, zoneEvents] of byZone) {
      const zoneHotspots = extractHotspots(zoneEvents, 20, minPts, epsTemporal, epsKm);
      const zoneRow = zonesMap.get(pssId);
      const zoneName = zoneRow?.name || zoneEvents[0]?.pssName || "Unknown Zone";
      if (/test/i.test(zoneName) || zoneName.startsWith("ST_")) continue;
      const polygon = zoneRow ? parseAreaJson(zoneRow.area_json) : null;

      for (const h of zoneHotspots) {
        h.zoneName = zoneName;
        h.zoneId = pssId;
        if (polygon) h.zonePolygon = polygon;
      }
      allZoneHotspots.push(...zoneHotspots);
    }

    // Split into DE/DACH/World by geocoding, then rank
    const deList: HotspotEntry[] = [];
    const dachList: HotspotEntry[] = [];
    const worldList: HotspotEntry[] = [];
    for (const h of allZoneHotspots) {
      const cc = h.countryCode;
      if (cc === "DE") deList.push(h);
      else if (DACH_NO_DE.has(cc)) dachList.push(h);
      else worldList.push(h);
    }

    const rankSlice = (arr: HotspotEntry[]) => {
      arr.sort((a, b) => b.degree - a.degree);
      const top = arr.slice(0, 20);
      for (let r = 0; r < top.length; r++) top[r].rank = r + 1;
      return top;
    };

    hotspotsDE = rankSlice(deList);
    hotspotsDACH = rankSlice(dachList);
    hotspotsWorld = rankSlice(worldList);
    countDE = deList.reduce((s, h) => s + h.degree, 0);
    countDACH = dachList.reduce((s, h) => s + h.degree, 0);
    countWorld = worldList.reduce((s, h) => s + h.degree, 0);

    console.log(`[hotspots] Zone-mode ST-DBSCAN ${byZone.size} zones, minPts=${minPts} eps=${epsKm}km epsT=${epsHours}h — ${totalAlarms} alarms → DE:${hotspotsDE.length} DACH:${hotspotsDACH.length} World:${hotspotsWorld.length} clusters`);
  } else {
    // Private mode: cluster all events together (existing behavior)
    const deOnly: CachedEvent[] = [];
    const dachOnly: CachedEvent[] = [];
    const world: CachedEvent[] = [];
    for (const alarm of allAlarms) {
      const [, cc] = geocode(alarm.latitude, alarm.longitude);
      if (cc === "DE") deOnly.push(alarm);
      else if (DACH_NO_DE.has(cc)) dachOnly.push(alarm);
      else world.push(alarm);
    }

    console.log(`[hotspots] ST-DBSCAN minPts=${minPts} eps=${epsKm}km epsT=${epsHours}h lookback=${lookbackDays}d — ${totalAlarms} alarms (DE:${deOnly.length} DACH:${dachOnly.length} World:${world.length})`);
    hotspotsDE = extractHotspots(deOnly, 20, minPts, epsTemporal, epsKm);
    hotspotsDACH = extractHotspots(dachOnly, 20, minPts, epsTemporal, epsKm);
    hotspotsWorld = extractHotspots(world, 20, minPts, epsTemporal, epsKm);
    console.log(`[hotspots] ST-DBSCAN done — DE:${hotspotsDE.length} DACH:${hotspotsDACH.length} World:${hotspotsWorld.length} clusters`);

    countDE = deOnly.length;
    countDACH = dachOnly.length;
    countWorld = world.length;
  }

  const result: HotspotResult = {
    from: fromKey,
    to: toKey,
    totalAlarms,
    countDE,
    countDACH,
    countWorld,
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
