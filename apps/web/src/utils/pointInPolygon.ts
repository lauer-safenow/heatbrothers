/**
 * Ray-casting point-in-polygon test.
 * @param point [lng, lat] to test
 * @param polygon Array of [lng, lat] vertices
 */
export function pointInPolygon(
  point: [number, number],
  polygon: [number, number][],
): boolean {
  const [px, py] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    if (
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Build a point-in-MultiPolygon test. Each part is [outer, ...holes]
 * (GeoJSON MultiPolygon coordinates). Per-part bounding boxes skip the
 * ring scan for points that are nowhere near a part.
 */
export function multiPolygonContains(
  parts: [number, number][][][],
): (point: [number, number]) => boolean {
  const prepared = parts.map(([outer, ...holes]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { outer, holes, minX, minY, maxX, maxY };
  });
  return (point) => {
    const [px, py] = point;
    return prepared.some((p) =>
      px >= p.minX && px <= p.maxX && py >= p.minY && py <= p.maxY &&
      pointInPolygon(point, p.outer) &&
      !p.holes.some((h) => pointInPolygon(point, h)),
    );
  };
}

/** Approximate area of a ring (shoelace on a sinusoidal equal-area projection); for comparing sizes only. */
function ringArea(ring: [number, number][]): number {
  const k = Math.PI / 180;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] * Math.cos(ring[i][1] * k), xj = ring[j][0] * Math.cos(ring[j][1] * k);
    sum += xj * ring[i][1] - xi * ring[j][1];
  }
  return Math.abs(sum / 2);
}

/** The part with the largest outer-ring area ("mainland"). */
export function largestPart(parts: [number, number][][][]): [number, number][][] {
  return parts.reduce((a, b) => (ringArea(b[0]) > ringArea(a[0]) ? b : a));
}

/** GeoJSON Polygon/MultiPolygon → MultiPolygon parts ([outer, ...holes] per part). */
export function geojsonToParts(
  g: { type: string; coordinates: unknown } | undefined,
): [number, number][][][] | null {
  if (g?.type === "Polygon") return [g.coordinates as [number, number][][]];
  if (g?.type === "MultiPolygon") return g.coordinates as [number, number][][][];
  return null;
}
