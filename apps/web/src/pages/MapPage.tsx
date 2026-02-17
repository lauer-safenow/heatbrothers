import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import "../datepicker-dark.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { HeatmapLayer, PolygonLayer, PathLayer, ScatterplotLayer, type Layer } from "deck.gl";
import { pointInPolygon } from "../utils/pointInPolygon";
import { geohashEncode, geohashNeighbors, geohashToPolygon } from "../utils/geohash";
import { PolygonToolbar } from "../components/PolygonToolbar";
import { TimeHistogram } from "../components/TimeHistogram";
import { CITIES } from "../data/cities";
import "./MapPage.css";

type EventTuple = [number, number, number]; // [lng, lat, unixSeconds]
type LngLat = [number, number];
type DrawingState = "idle" | "drawing" | "complete";

const ZONE_AUTO_ZOOM = 13; // zoom level at which zones auto-appear in the viewport

interface EventType {
  event_type: string;
  count: number;
}

const DISPLAY_NAMES: Record<string, string> = {
  DETAILED_ALARM_STARTED_PRIVATE_GROUP: "Alarm started private",
  DETAILED_ATTENTION_STARTED_PRIVATE_GROUP: "Attention private",
  app_opening_ZONE: "App opening zone",
  FIRST_TIME_PHONE_STATUS_SENT: "Installs",
  DETAILED_ALARM_STARTED_ZONE: "Alarm started zone",
};

function displayName(eventType: string): string {
  return DISPLAY_NAMES[eventType] ?? eventType;
}

interface ZoneData {
  id: string;
  name: string;
  pss_image: { s3_location: string } | null;
  area_json: unknown;
  created_at: string;
  description: string | null;
  is_active: boolean;
  is_public: boolean;
  max_number_of_members_allowed: number | null;
  modified_at: string;
  number_of_members: number;
  number_of_members_reachable: number;
  safe_spot_type: string;
  valid_until: string | null;
  about: string | null;
}

interface ParsedZone {
  data: ZoneData;
  polygon: LngLat[];
}

function parseAreaJson(raw: unknown): LngLat[] | null {
  let parsed = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  if (obj.type === "Feature") {
    const geom = obj.geometry as Record<string, unknown>;
    return (geom.coordinates as number[][][])[0] as LngLat[];
  }
  if (obj.type === "Polygon") {
    return (obj.coordinates as number[][][])[0] as LngLat[];
  }
  if (Array.isArray(parsed)) {
    return parsed as LngLat[];
  }
  return null;
}

function polygonIntersectsViewport(polygon: LngLat[], bounds: maplibregl.LngLatBounds): boolean {
  const west = bounds.getWest(), east = bounds.getEast();
  const south = bounds.getSouth(), north = bounds.getNorth();
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of polygon) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return minLng >= west && maxLng <= east && minLat >= south && maxLat <= north;
}

function labelLeader(polygon: LngLat[]): {
  label: LngLat; path: LngLat[];
} {
  let topPoint: LngLat = polygon[0];
  let minLat = Infinity;
  for (const pt of polygon) {
    if (pt[1] > topPoint[1]) topPoint = pt;
    if (pt[1] < minLat) minLat = pt[1];
  }
  const h = topPoint[1] - minLat;
  const anchor: LngLat = topPoint;
  const label: LngLat = [topPoint[0], topPoint[1] + h * 0.5];

  return { label, path: [label, anchor] };
}

function s3Url(location: string): string {
  if (location.startsWith("http")) return location;
  return `https://${location}`;
}

function getHeatmapParams(zoom: number) {
  const REF_ZOOM = 5.5;
  const delta = REF_ZOOM - zoom; // positive = zoomed out

  const radiusPixels = Math.round(
    Math.min(100, Math.max(10, 30 * Math.pow(2, 0.4 * delta)))
  );
  const intensity = Math.min(5, Math.max(0.3, Math.pow(2, 0.5 * delta)));
  const threshold =
    delta > 0 ? Math.max(0.005, 0.05 * Math.pow(0.5, 0.6 * delta)) : 0.05;

  return { radiusPixels, intensity, threshold };
}

export function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const cityLabelRef = useRef<HTMLDivElement>(null);

  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [selected, setSelected] = useState("");
  const [allEvents, setAllEvents] = useState<EventTuple[]>([]);
  const [loading, setLoading] = useState(false);

  // polygon drawing
  const [drawingState, setDrawingState] = useState<DrawingState>("idle");
  const [vertices, setVertices] = useState<LngLat[]>([]);

  // zoom tracking for adaptive heatmap params
  const [zoom, setZoom] = useState(5.5);
  const [mapBounds, setMapBounds] = useState<maplibregl.LngLatBounds | null>(null);

  // time filter
  const [timeFrom, setTimeFrom] = useState<Date | null>(null);
  const [timeUntil, setTimeUntil] = useState<Date | null>(null);

  // zone overlays
  const [zones, setZones] = useState<ParsedZone[]>([]);
  const [zoneHover, setZoneHover] = useState<{ x: number; y: number; zone: ParsedZone } | null>(null);
  const [selectedZoneIds, setSelectedZoneIds] = useState<Set<string>>(new Set());
  const [zoneSearch, setZoneSearch] = useState("");
  const [zoneDropdownOpen, setZoneDropdownOpen] = useState(false);
  const [zoneFilterActive, setZoneFilterActive] = useState<boolean | null>(null);
  const [zoneFilterPublic, setZoneFilterPublic] = useState<boolean | null>(null);
  const [zoneAutoDiscover, setZoneAutoDiscover] = useState(true);
  const zoneDropdownRef = useRef<HTMLDivElement>(null);
  const zoneLabelRef = useRef<HTMLDivElement>(null);

  // geohash hover
  const [geohashEnabled, setGeohashEnabled] = useState(false);
  const [geohashPrecision, setGeohashPrecision] = useState<5 | 6>(5);
  const geohashPrecisionRef = useRef<5 | 6>(5);
  const [hoveredGeohash, setHoveredGeohash] = useState<string | null>(null);

  const autoZoneMode = zoneAutoDiscover && zoom >= ZONE_AUTO_ZOOM;

  const visibleZones = useMemo(() => {
    if (autoZoneMode && mapBounds) {
      const viewportZones = zones.filter((z) => polygonIntersectsViewport(z.polygon, mapBounds));
      // Also include manually selected zones that aren't already in the viewport set
      const viewportIds = new Set(viewportZones.map((z) => z.data.id));
      const manualExtra = zones.filter((z) => selectedZoneIds.has(z.data.id) && !viewportIds.has(z.data.id));
      return [...viewportZones, ...manualExtra];
    }
    return zones.filter((z) => selectedZoneIds.has(z.data.id));
  }, [zones, autoZoneMode, mapBounds, selectedZoneIds]);

  const filteredZoneList = zones.filter((z) => {
    if (!z.data.name.toLowerCase().includes(zoneSearch.toLowerCase())) return false;
    if (zoneFilterActive !== null && z.data.is_active !== zoneFilterActive) return false;
    if (zoneFilterPublic !== null && z.data.is_public !== zoneFilterPublic) return false;
    return true;
  });

  // city search
  const [searchQuery, setSearchQuery] = useState("");

  const flyToCity = (query: string) => {
    if (!query.trim() || !map.current) return;
    fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`,
    )
      .then((r) => r.json())
      .then((results: { lat: string; lon: string }[]) => {
        if (results.length === 0) return;
        map.current?.flyTo({
          center: [parseFloat(results[0].lon), parseFloat(results[0].lat)],
          zoom: 12,
          duration: 2000,
        });
      })
      .catch(() => {});
  };

  // histogram panel resize
  const [panelHeight, setPanelHeight] = useState(180);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStartY.current = e.clientY;
    dragStartH.current = panelHeight;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = dragStartY.current - ev.clientY;
      setPanelHeight(Math.max(100, Math.min(500, dragStartH.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [panelHeight]);

  // ---------- filtering pipeline ----------
  const filteredEvents = useMemo(() => {
    let events = allEvents;

    // time filter
    if (timeFrom) {
      const fromTs = Math.floor(timeFrom.getTime() / 1000);
      events = events.filter((e) => e[2] >= fromTs);
    }
    if (timeUntil) {
      const untilTs = Math.floor(timeUntil.getTime() / 1000) + 86400;
      events = events.filter((e) => e[2] < untilTs);
    }

    // polygon filter
    if (drawingState === "complete" && vertices.length >= 3) {
      events = events.filter((e) => pointInPolygon([e[0], e[1]], vertices));
    }

    return events;
  }, [allEvents, timeFrom, timeUntil, drawingState, vertices]);

  // ---------- data fetching ----------
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data: { byType: EventType[] }) => {
        setEventTypes(data.byType);
        const preferred = data.byType.find(
          (t) => t.event_type === "FIRST_TIME_PHONE_STATUS_SENT",
        );
        setSelected(preferred?.event_type ?? data.byType[0]?.event_type ?? "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setAllEvents([]);
    if (!selected) return;
    setLoading(true);
    fetch(`/api/events/${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((data: { events: EventTuple[] }) => setAllEvents(data.events))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selected]);

  // ---------- zone data fetching ----------
  useEffect(() => {
    fetch("/api/zones")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<{ zones: ZoneData[] }>;
      })
      .then(({ zones: list }) => {
        const parsed: ParsedZone[] = [];
        for (const data of list) {
          const polygon = parseAreaJson(data.area_json);
          if (polygon) parsed.push({ data, polygon });
        }
        setZones(parsed);
      })
      .catch((err) => console.warn("Zones fetch failed:", err));
  }, []);

  // ---------- map init ----------
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [10.4515, 51.1657],
      zoom: 5.5,
    });

    map.current.addControl(new maplibregl.NavigationControl(), "top-right");

    overlay.current = new MapboxOverlay({ layers: [] });
    map.current.addControl(overlay.current);

    // Hide city/place label layers (replaced by HTML labels), keep country labels
    map.current.on("load", () => {
      const style = map.current?.getStyle();
      if (style?.layers) {
        for (const layer of style.layers) {
          if (layer.type === "symbol" && !layer.id.startsWith("place_country")) {
            map.current!.setLayoutProperty(layer.id, "visibility", "none");
          }
        }
      }
      if (map.current) setMapBounds(map.current.getBounds());
    });

    map.current.on("moveend", () => {
      if (!map.current) return;
      setZoom(map.current.getZoom());
      setMapBounds(map.current.getBounds());
    });

    map.current.on("mousemove", (e) => {
      const z = map.current?.getZoom() ?? 5.5;
      if (z < 10) { setHoveredGeohash(null); return; }
      const hash = geohashEncode(e.lngLat.lat, e.lngLat.lng, geohashPrecisionRef.current);
      setHoveredGeohash((prev) => prev === hash ? prev : hash);
    });

    map.current.on("mouseout", () => {
      setHoveredGeohash(null);
    });

    // Note: geohashEnabled gating happens at render/layer level, not here,
    // so we always compute but only display when enabled.

    return () => {
      map.current?.remove();
      map.current = null;
      overlay.current = null;
    };
  }, []);

  // ---------- polygon click handler ----------
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      if (drawingState !== "drawing") return;

      const newPt: LngLat = [e.lngLat.lng, e.lngLat.lat];

      // snap to first vertex to close polygon
      if (vertices.length >= 3) {
        const firstPx = m.project(
          new maplibregl.LngLat(vertices[0][0], vertices[0][1]),
        );
        const clickPx = m.project(e.lngLat);
        const dist = Math.hypot(
          clickPx.x - firstPx.x,
          clickPx.y - firstPx.y,
        );
        if (dist < 20) {
          setDrawingState("complete");
          return;
        }
      }

      setVertices((prev) => [...prev, newPt]);
    };

    m.on("click", handleClick);
    return () => {
      m.off("click", handleClick);
    };
  }, [drawingState, vertices]);

  // escape to cancel drawing
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawingState === "drawing") {
        setVertices([]);
        setDrawingState("idle");
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [drawingState]);

  // close zone dropdown on outside click
  useEffect(() => {
    if (!zoneDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (zoneDropdownRef.current && !zoneDropdownRef.current.contains(e.target as Node)) {
        setZoneDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [zoneDropdownOpen]);

  // zone HTML labels – position via map.project() on every frame
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    const update = () => {
      const container = zoneLabelRef.current;
      if (!container) return;
      const children = container.children;
      visibleZones.forEach((z, i) => {
        const el = children[i] as HTMLElement | undefined;
        if (!el) return;
        const leader = labelLeader(z.polygon);
        const pos = m.project(new maplibregl.LngLat(leader.label[0], leader.label[1]));
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
      });
    };

    m.on("move", update);
    update();
    return () => { m.off("move", update); };
  }, [visibleZones]);

  // city HTML labels – positioned via map.project() on every frame
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    const update = () => {
      const container = cityLabelRef.current;
      if (!container) return;
      const z = m.getZoom();
      const children = container.children;
      for (let i = 0; i < CITIES.length; i++) {
        const el = children[i] as HTMLElement | undefined;
        if (!el) continue;
        const city = CITIES[i];
        if (z < city.minZoom) {
          el.style.display = "none";
          continue;
        }
        const pos = m.project(new maplibregl.LngLat(city.lng, city.lat));
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
        el.style.display = "";
      }
    };

    m.on("move", update);
    update();
    return () => { m.off("move", update); };
  }, []);

  // cursor style
  useEffect(() => {
    if (!map.current) return;
    map.current.getCanvas().style.cursor =
      drawingState === "drawing" ? "crosshair" : "";
  }, [drawingState]);

  // ---------- deck.gl layers ----------
  useEffect(() => {
    if (!overlay.current) return;

    const layers: Layer[] = [];

    // heatmap (params adapt to zoom level)
    const { radiusPixels, intensity, threshold } = getHeatmapParams(zoom);
    layers.push(
      new HeatmapLayer({
        id: "heatmap",
        data: filteredEvents,
        getPosition: (d: EventTuple) => [d[0], d[1]],
        getWeight: () => 1,
        radiusPixels,
        intensity,
        threshold,
      }),
    );

    // zone overlays
    for (const z of visibleZones) {
      const zId = z.data.id;
      layers.push(
        new PolygonLayer({
          id: `zone-fill-${zId}`,
          data: [{ polygon: z.polygon, zone: z }],
          getPolygon: (d: { polygon: LngLat[] }) => d.polygon,
          getFillColor: [0, 150, 255, 30],
          getLineColor: [0, 150, 255, 180],
          getLineWidth: 2,
          lineWidthUnits: "pixels" as const,
          filled: true,
          stroked: true,
          pickable: true,
          onHover: (info: { x: number; y: number; picked: boolean; object?: { zone: ParsedZone } }) => {
            setZoneHover(info.picked && info.object ? { x: info.x, y: info.y, zone: info.object.zone } : null);
          },
        }),
      );
    }

    // zone name labels with straight leader lines
    if (visibleZones.length > 0) {
      const labelData = visibleZones.map((z) => {
        const leader = labelLeader(z.polygon);
        return { ...leader, text: z.data.name };
      });

      layers.push(
        new PathLayer({
          id: "zone-leader-lines",
          data: labelData,
          getPath: (d: { path: LngLat[] }) => d.path,
          getColor: [255, 255, 255, 210],
          getWidth: 2,
          widthUnits: "pixels" as const,
          capRounded: true,
        }),
      );

    }

    // completed polygon
    if (drawingState === "complete" && vertices.length >= 3) {
      layers.push(
        new PolygonLayer({
          id: "polygon-fill",
          data: [{ polygon: vertices }],
          getPolygon: (d: { polygon: LngLat[] }) => d.polygon,
          getFillColor: [255, 140, 0, 35],
          getLineColor: [255, 140, 0, 200],
          getLineWidth: 2,
          lineWidthUnits: "pixels" as const,
          filled: true,
          stroked: true,
        }),
      );
    }

    // drawing in progress
    if (drawingState === "drawing" && vertices.length > 0) {
      layers.push(
        new PathLayer({
          id: "polygon-edges",
          data: [{ path: vertices }],
          getPath: (d: { path: LngLat[] }) => d.path,
          getColor: [255, 140, 0, 200],
          getWidth: 2,
          widthUnits: "pixels" as const,
        }),
      );
      layers.push(
        new ScatterplotLayer({
          id: "polygon-vertices",
          data: vertices,
          getPosition: (d: LngLat) => d,
          getFillColor: (_d: LngLat, o: { index: number }) =>
            o.index === 0 ? [255, 220, 50, 255] : [255, 140, 0, 255],
          getRadius: (_d: LngLat, o: { index: number }) =>
            o.index === 0 ? 8 : 5,
          radiusUnits: "pixels" as const,
        }),
      );
    }

    // geohash grid on hover
    if (geohashEnabled && hoveredGeohash) {
      const allCells = geohashNeighbors(hoveredGeohash);
      const cellData = allCells.map((h) => ({
        hash: h,
        polygon: geohashToPolygon(h),
        isCenter: h === hoveredGeohash,
      }));

      layers.push(
        new PolygonLayer({
          id: "geohash-cells",
          data: cellData,
          getPolygon: (d: { polygon: LngLat[] }) => d.polygon,
          getFillColor: (d: { isCenter: boolean }) =>
            d.isCenter ? [255, 255, 255, 25] : [255, 255, 255, 8],
          getLineColor: (d: { isCenter: boolean }) =>
            d.isCenter ? [255, 255, 255, 120] : [255, 255, 255, 40],
          getLineWidth: (d: { isCenter: boolean }) => d.isCenter ? 2 : 1,
          lineWidthUnits: "pixels" as const,
          filled: true,
          stroked: true,
        }),
      );
    }

    overlay.current.setProps({ layers });
  }, [filteredEvents, drawingState, vertices, zoom, visibleZones, geohashEnabled, hoveredGeohash]);

  // resize map after mount
  useEffect(() => {
    const t = setTimeout(() => map.current?.resize(), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="map-page">
      <div className="map-section">
        <div ref={mapContainer} className="map-container" />

        <div ref={cityLabelRef} className="city-label-container">
          {CITIES.map((c) => (
            <div key={c.name} className="city-html-label">
              {c.name}
            </div>
          ))}
        </div>

        <div ref={zoneLabelRef} className="zone-label-container">
          {visibleZones.map((z) => (
            <div
              key={z.data.id}
              className="zone-html-label"
              onClick={() => {
                if (!map.current) return;
                let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
                for (const [lng, lat] of z.polygon) {
                  if (lng < minLng) minLng = lng;
                  if (lng > maxLng) maxLng = lng;
                  if (lat < minLat) minLat = lat;
                  if (lat > maxLat) maxLat = lat;
                }
                map.current.fitBounds(
                  [[minLng, minLat], [maxLng, maxLat]],
                  { padding: 80, duration: 1500, maxZoom: 14 },
                );
              }}
            >
              {z.data.name}
            </div>
          ))}
        </div>

        {geohashEnabled && hoveredGeohash && drawingState !== "drawing" && (
          <div className="geohash-label">
            {hoveredGeohash}
          </div>
        )}

        {zoneHover && (() => {
          const z = zoneHover.zone.data;
          return (
            <div
              className="zone-tooltip"
              style={{ left: zoneHover.x + 12, top: zoneHover.y - 12 }}
            >
              <div className="zone-tooltip-name">{z.name}</div>
              {z.pss_image?.s3_location && (
                <img
                  className="zone-tooltip-img"
                  src={s3Url(z.pss_image.s3_location)}
                  alt={z.name}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              <div className="zone-tooltip-meta">
                <div className="zt-row"><span className="zt-label">ID</span> {z.id}</div>
                {z.description && <div className="zt-row"><span className="zt-label">Description</span> {z.description}</div>}
                {z.about && <div className="zt-row"><span className="zt-label">About</span> {z.about}</div>}
                <div className="zt-row"><span className="zt-label">Members</span> {z.number_of_members}{z.max_number_of_members_allowed ? ` / ${z.max_number_of_members_allowed}` : ""}</div>
                <div className="zt-row"><span className="zt-label">Reachable</span> {z.number_of_members_reachable}</div>
                <div className="zt-row"><span className="zt-label">Active</span> {z.is_active ? "Yes" : "No"}</div>
                <div className="zt-row"><span className="zt-label">Public</span> {z.is_public ? "Yes" : "No"}</div>
                <div className="zt-row"><span className="zt-label">Type</span> {z.safe_spot_type}</div>
                <div className="zt-row"><span className="zt-label">Created</span> {new Date(z.created_at).toLocaleDateString()}</div>
                <div className="zt-row"><span className="zt-label">Modified</span> {new Date(z.modified_at).toLocaleDateString()}</div>
                {z.valid_until && <div className="zt-row"><span className="zt-label">Valid until</span> {new Date(z.valid_until).toLocaleDateString()}</div>}
              </div>
            </div>
          );
        })()}

        <div className="map-controls">
          <select
            className="event-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">None</option>
            {eventTypes.map((t) => (
              <option key={t.event_type} value={t.event_type}>
                {displayName(t.event_type)} ({t.count.toLocaleString()})
              </option>
            ))}
          </select>
          {loading && <span className="loading-badge">Loading...</span>}
          <div className="zone-dropdown" ref={zoneDropdownRef}>
            <button
              className="zone-dropdown-btn"
              onClick={() => setZoneDropdownOpen((o) => !o)}
            >
              {autoZoneMode ? `Zones · ${visibleZones.length} in view` : `Zones${selectedZoneIds.size > 0 ? ` (${selectedZoneIds.size})` : ""}`}
            </button>
            {zoneDropdownOpen && (
              <div className="zone-dropdown-panel">
                <input
                  className="zone-dropdown-search"
                  type="text"
                  placeholder="Search zones..."
                  value={zoneSearch}
                  onChange={(e) => setZoneSearch(e.target.value)}
                  autoFocus
                />
                <div className="zone-dropdown-filters">
                  <button
                    className={`zone-filter-btn${zoneFilterActive === true ? " active" : ""}`}
                    onClick={() => setZoneFilterActive((v) => v === true ? null : true)}
                  >Active</button>
                  <button
                    className={`zone-filter-btn${zoneFilterActive === false ? " active" : ""}`}
                    onClick={() => setZoneFilterActive((v) => v === false ? null : false)}
                  >Inactive</button>
                  <button
                    className={`zone-filter-btn${zoneFilterPublic === true ? " active" : ""}`}
                    onClick={() => setZoneFilterPublic((v) => v === true ? null : true)}
                  >Public</button>
                  <button
                    className={`zone-filter-btn${zoneFilterPublic === false ? " active" : ""}`}
                    onClick={() => setZoneFilterPublic((v) => v === false ? null : false)}
                  >Not Public</button>
                </div>
                <div className="zone-dropdown-actions">
                  <button onClick={() => setSelectedZoneIds(new Set(filteredZoneList.map((z) => z.data.id)))}>All</button>
                  <button onClick={() => setSelectedZoneIds(new Set())}>None</button>
                </div>
                <div className="zone-dropdown-list">
                  {filteredZoneList.map((z) => {
                    const checked = selectedZoneIds.has(z.data.id);
                    return (
                      <label key={z.data.id} className="zone-dropdown-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            if (!checked && map.current) {
                              let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
                              for (const [lng, lat] of z.polygon) {
                                if (lng < minLng) minLng = lng;
                                if (lng > maxLng) maxLng = lng;
                                if (lat < minLat) minLat = lat;
                                if (lat > maxLat) maxLat = lat;
                              }
                              map.current.fitBounds(
                                [[minLng, minLat], [maxLng, maxLat]],
                                { padding: 80, duration: 1500, maxZoom: 14 },
                              );
                            }
                            setSelectedZoneIds((prev) => {
                              const next = new Set(prev);
                              if (checked) next.delete(z.data.id);
                              else next.add(z.data.id);
                              return next;
                            });
                          }}
                        />
                        <span className="zone-item-name">{z.data.name}</span>
                        <span className="zone-item-badge">{z.data.is_active ? "active" : "inactive"}</span>
                      </label>
                    );
                  })}
                  {filteredZoneList.length === 0 && (
                    <div className="zone-dropdown-empty">No zones match</div>
                  )}
                </div>
              </div>
            )}
          </div>
          <label className="geohash-toggle">
            <input
              type="checkbox"
              checked={zoneAutoDiscover}
              onChange={(e) => setZoneAutoDiscover(e.target.checked)}
            />
            Auto discover
          </label>
          <label className="geohash-toggle">
            <input
              type="checkbox"
              checked={geohashEnabled}
              onChange={(e) => setGeohashEnabled(e.target.checked)}
            />
            Geohashes
          </label>
          <input
            className="city-search"
            type="text"
            placeholder="Search city..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                flyToCity(searchQuery);
                setSearchQuery("");
              }
            }}
          />
          {geohashEnabled && (
            <div className="geohash-precision-toggle">
              {([5, 6] as const).map((p) => (
                <button
                  key={p}
                  className={`geohash-precision-btn${geohashPrecision === p ? " active" : ""}`}
                  onClick={() => {
                    setGeohashPrecision(p);
                    geohashPrecisionRef.current = p;
                    setHoveredGeohash(null);
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        <div
          className="event-count-badge"
          style={drawingState === "complete" ? { bottom: `calc(${panelHeight + 16}px + 4.5rem)` } : undefined}
        >
          {filteredEvents.length.toLocaleString()} events
        </div>

        <div
          className="bottom-toolbar"
          style={drawingState === "complete" ? { bottom: panelHeight + 16 } : undefined}
        >
          <PolygonToolbar
            drawingState={drawingState}
            vertexCount={vertices.length}
            onStartDraw={() => {
              setVertices([]);
              setDrawingState("drawing");
            }}
            onFinishDraw={() => {
              if (vertices.length >= 3) setDrawingState("complete");
            }}
            onClear={() => {
              setVertices([]);
              setDrawingState("idle");
            }}
          />

          <div className="date-filters">
            <label>
              From
              <DatePicker
                selected={timeFrom}
                onChange={(d: Date | null) => setTimeFrom(d)}
                dateFormat="dd.MM.yyyy"
                isClearable
                placeholderText="Select date"
              />
            </label>
            <label>
              Until
              <DatePicker
                selected={timeUntil}
                onChange={(d: Date | null) => setTimeUntil(d)}
                dateFormat="dd.MM.yyyy"
                isClearable
                placeholderText="Select date"
              />
            </label>
            {(timeFrom || timeUntil) && (
              <button
                className="time-reset-btn"
                onClick={() => {
                  setTimeFrom(null);
                  setTimeUntil(null);
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {drawingState === "complete" && (
          <div className="bottom-panel" style={{ height: panelHeight }}>
            <div className="panel-drag-handle" onMouseDown={onDragStart} />
            <TimeHistogram
              events={allEvents}
              filteredEvents={filteredEvents}
              onTimeRangeSelect={(from, until) => {
                setTimeFrom(new Date(from));
                setTimeUntil(new Date(until));
              }}
              onClose={() => {
                setVertices([]);
                setDrawingState("idle");
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
