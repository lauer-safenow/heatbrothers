const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const BASE32_INV: Record<string, number> = {};
for (let i = 0; i < BASE32.length; i++) BASE32_INV[BASE32[i]] = i;

/** Encode lat/lng to a geohash string of given precision. */
export function geohashEncode(lat: number, lng: number, precision: number): string {
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;
  let hash = "";
  let isLng = true;

  while (hash.length < precision) {
    let bits = 0;
    for (let bit = 4; bit >= 0; bit--) {
      if (isLng) {
        const mid = (lngMin + lngMax) / 2;
        if (lng >= mid) { bits |= 1 << bit; lngMin = mid; }
        else { lngMax = mid; }
      } else {
        const mid = (latMin + latMax) / 2;
        if (lat >= mid) { bits |= 1 << bit; latMin = mid; }
        else { latMax = mid; }
      }
      isLng = !isLng;
    }
    hash += BASE32[bits];
  }
  return hash;
}

/** Decode geohash to bounding box: [minLat, minLng, maxLat, maxLng]. */
export function geohashBounds(hash: string): [number, number, number, number] {
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;
  let isLng = true;

  for (const c of hash) {
    const bits = BASE32_INV[c];
    for (let bit = 4; bit >= 0; bit--) {
      if (isLng) {
        const mid = (lngMin + lngMax) / 2;
        if (bits & (1 << bit)) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bits & (1 << bit)) latMin = mid;
        else latMax = mid;
      }
      isLng = !isLng;
    }
  }
  return [latMin, lngMin, latMax, lngMax];
}

/** Get all 8 neighbor geohashes plus the center one (9 total). */
export function geohashNeighbors(hash: string): string[] {
  const [latMin, lngMin, latMax, lngMax] = geohashBounds(hash);
  const latStep = latMax - latMin;
  const lngStep = lngMax - lngMin;
  const centerLat = (latMin + latMax) / 2;
  const centerLng = (lngMin + lngMax) / 2;
  const precision = hash.length;

  const result: string[] = [];
  for (let dlat = -1; dlat <= 1; dlat++) {
    for (let dlng = -1; dlng <= 1; dlng++) {
      const lat = centerLat + dlat * latStep;
      const lng = centerLng + dlng * lngStep;
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        result.push(geohashEncode(lat, lng, precision));
      }
    }
  }
  return result;
}

/** Convert a geohash to a polygon ring [[lng,lat], ...] for rendering. */
export function geohashToPolygon(hash: string): [number, number][] {
  const [latMin, lngMin, latMax, lngMax] = geohashBounds(hash);
  return [
    [lngMin, latMin],
    [lngMax, latMin],
    [lngMax, latMax],
    [lngMin, latMax],
    [lngMin, latMin],
  ];
}

/** Deterministic pseudo-random [0,1) from an integer seed. */
function seededRandom(seed: number): number {
  let x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Geohash precision used by PostHog for each event type. null = no jitter (real coords). */
const GEOHASH_PRECISIONS: Record<string, number | null> = {
  FIRST_TIME_PHONE_STATUS_SENT: 5,
  app_opening_ZONE: null,
  DETAILED_ALARM_STARTED_ZONE: null,
};
const DEFAULT_PRECISION = 6;

export function geohashPrecisionForType(eventType: string): number | null {
  if (eventType in GEOHASH_PRECISIONS) return GEOHASH_PRECISIONS[eventType];
  return DEFAULT_PRECISION;
}

/**
 * Scatter a geohash-center-snapped point randomly within its cell.
 * Uses a deterministic seed so positions are stable across re-renders.
 */
export function jitterWithinCell(
  lat: number, lng: number, precision: number, seed: number,
): [number, number] {
  const hash = geohashEncode(lat, lng, precision);
  const [latMin, lngMin, latMax, lngMax] = geohashBounds(hash);
  const r1 = seededRandom(seed);
  const r2 = seededRandom(seed + 99991); // second independent dimension
  return [
    latMin + r1 * (latMax - latMin),
    lngMin + r2 * (lngMax - lngMin),
  ];
}

/** Choose geohash precision based on map zoom level. */
export function precisionForZoom(zoom: number): number {
  if (zoom < 4) return 2;
  if (zoom < 7) return 3;
  if (zoom < 10) return 4;
  if (zoom < 13) return 5;
  if (zoom < 16) return 6;
  return 7;
}
