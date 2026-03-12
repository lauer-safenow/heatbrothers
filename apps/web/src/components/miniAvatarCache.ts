/**
 * Caches avatar SVGs as Image objects for canvas rendering.
 * Uses the same buildAvatarSvg as UserAvatar — single source of truth.
 */
import { buildAvatarSvg } from "./avatarSvg";

const imageCache = new Map<string, HTMLImageElement | null>();
const pendingLoads = new Set<string>();

export function getAvatarImage(distinctId: string, countryCode?: string, eventCount?: number): HTMLImageElement | null {
  const key = `${distinctId}:${countryCode ?? ""}:${eventCount ?? ""}`;
  const cached = imageCache.get(key);
  if (cached !== undefined) return cached;

  if (pendingLoads.has(key)) return null;
  pendingLoads.add(key);

  const svg = buildAvatarSvg(distinctId, countryCode, eventCount);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    imageCache.set(key, img);
    URL.revokeObjectURL(url);
    pendingLoads.delete(key);
  };
  img.onerror = () => {
    pendingLoads.delete(key);
  };
  img.src = url;

  imageCache.set(key, null);
  return null;
}

export function avatarCacheSize(): number {
  return imageCache.size;
}
