import { createRevGeocoder, type RevGeocoder } from "@webkitty/geo-rev";

let revGeocoder: RevGeocoder | null = null;

const geoCache = new Map<string, [string, string]>();

const FALLBACK: [string, string] = ["Unknown", ""];

export async function initGeocoder(): Promise<void> {
  revGeocoder = await createRevGeocoder();
  console.log("[geocoder] GeoNames reverse geocoder ready");
}

export function geocode(lat: number, lng: number): [string, string] {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = geoCache.get(key);
  if (cached) return cached;

  if (!revGeocoder) {
    geoCache.set(key, FALLBACK);
    return FALLBACK;
  }

  try {
    const r = revGeocoder.lookup({ latitude: lat, longitude: lng });
    const entry: [string, string] = [
      r.record?.name || "Unknown",
      (r.record?.countryCode || "").toUpperCase(),
    ];
    geoCache.set(key, entry);
    return entry;
  } catch {
    geoCache.set(key, FALLBACK);
    return FALLBACK;
  }
}
