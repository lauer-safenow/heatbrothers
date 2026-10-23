/** Sync interval in seconds — used by cron, API polling, and live UI countdown */
export const SYNC_INTERVAL_S = 60;

/** Slow sync interval in minutes — used by cron for background event types */
export const SLOW_SYNC_INTERVAL_M = 5;

/** The event type used by the live map */
export const LIVE_EVENT_TYPE = "DETAILED_ALARM_STARTED_PRIVATE_GROUP";

/** The event type used for zone-specific replay */
export const ZONE_EVENT_TYPE = "DETAILED_ALARM_STARTED_ZONE";

/** Max events returned by the replay between endpoint */
export const REPLAY_MAX_EVENTS = 5_000;

/** Areas tool: what kind of place an area ref points at */
export type AreaKind = "country" | "city";

/** Border simplification per kind (degrees): ~1 km for countries, ~100 m for cities */
const AREA_SIMPLIFY: Record<AreaKind, number> = { country: 0.01, city: 0.001 };

/**
 * Area ref: "<kind>:<osm type><osm id>[:mainland]", e.g. "city:R62428" or
 * "country:R2202162:mainland". `mainland` keeps only the largest part of a
 * multi-part border (drops islands / overseas territories).
 */
export function parseAreaRef(ref: string): { kind: AreaKind; osmId: string; mainland: boolean } | null {
  const m = /^(country|city):([RW]\d+)(:mainland)?$/.exec(ref);
  if (!m) return null;
  return { kind: m[1] as AreaKind, osmId: m[2], mainland: !!m[3] };
}

/**
 * Nominatim lookup URL for an area's border (GeoJSON Polygon/MultiPolygon).
 * Returns null for a malformed ref. Used by the map Areas tool and the CSV
 * export so both filter by the exact same border.
 */
export function areaBorderUrl(ref: string): string | null {
  const a = parseAreaRef(ref);
  if (!a) return null;
  return (
    `https://nominatim.openstreetmap.org/lookup?format=json&osm_ids=${a.osmId}` +
    `&accept-language=en&polygon_geojson=1&polygon_threshold=${AREA_SIMPLIFY[a.kind]}`
  );
}
