import { getNearestCity } from "offline-geocode-city";

const geoCache = new Map<string, [string, string]>();

export function geocode(lat: number, lng: number): [string, string] {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
  const cached = geoCache.get(key);
  if (cached) return cached;
  const r = getNearestCity(lat, lng);
  const entry: [string, string] = [r.cityName || "Unknown", (r.countryIso2 || "").toUpperCase()];
  geoCache.set(key, entry);
  return entry;
}
