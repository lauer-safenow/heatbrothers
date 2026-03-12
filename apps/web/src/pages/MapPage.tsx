import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
  person: { person_account: { display_name: string } | null } | null;
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

function dateToDateParam(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function paramToDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parsePolyParam(s: string | null): LngLat[] | null {
  if (!s) return null;
  const nums = s.split(",").map(Number);
  if (nums.length < 6 || nums.length % 2 !== 0 || nums.some(isNaN)) return null;
  const verts: LngLat[] = [];
  for (let i = 0; i < nums.length; i += 2) {
    verts.push([nums[i], nums[i + 1]]);
  }
  return verts;
}

export function MapPage() {
  const navigate = useNavigate();
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);

  // URL state persistence
  const [searchParams, setSearchParams] = useSearchParams();
  const initType = useRef<string | null>(searchParams.get("type"));
  const initFrom = useRef(paramToDate(searchParams.get("from")));
  const initTo = useRef(paramToDate(searchParams.get("to")));
  const initZones = useRef(searchParams.get("zones")?.split(",").filter(Boolean) ?? null);
  const initPoly = useRef(parsePolyParam(searchParams.get("poly")));
  const initialized = useRef(false);

  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [selected, setSelected] = useState("");
  const [allEvents, setAllEvents] = useState<EventTuple[]>([]);
  const [loading, setLoading] = useState(false);

  // polygon drawing
  const [drawingState, setDrawingState] = useState<DrawingState>(
    initPoly.current ? "complete" : "idle"
  );
  const [vertices, setVertices] = useState<LngLat[]>(initPoly.current ?? []);

  // zoom tracking for adaptive heatmap params (quantized to 0.5 steps to reduce re-renders)
  const [zoom, setZoom] = useState(5.5);
  const mapBoundsRef = useRef<maplibregl.LngLatBounds | null>(null);
  const [boundsVersion, setBoundsVersion] = useState(0);

  // time filter
  const [timeFrom, setTimeFrom] = useState<Date | null>(initFrom.current);
  const [timeUntil, setTimeUntil] = useState<Date | null>(initTo.current);

  // zone overlays
  const [zones, setZones] = useState<ParsedZone[]>([]);
  const [zoneHover, setZoneHover] = useState<{ x: number; y: number; zone: ParsedZone } | null>(null);
  const [zoneContextMenu, setZoneContextMenu] = useState<{ x: number; y: number; zone: ParsedZone } | null>(null);
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
  const geohashEnabledRef = useRef(false);
  const [geohashPrecision, setGeohashPrecision] = useState<5 | 6>(5);
  const geohashPrecisionRef = useRef<5 | 6>(5);
  const [hoveredGeohash, setHoveredGeohash] = useState<string | null>(null);
  const zoneAutoDiscoverRef = useRef(true);

  const autoZoneMode = zoneAutoDiscover && zoom >= ZONE_AUTO_ZOOM;

  const visibleZones = useMemo(() => {
    if (autoZoneMode && mapBoundsRef.current) {
      const bounds = mapBoundsRef.current;
      const viewportZones = zones.filter((z) => polygonIntersectsViewport(z.polygon, bounds));
      // Also include manually selected zones that aren't already in the viewport set
      const viewportIds = new Set(viewportZones.map((z) => z.data.id));
      const manualExtra = zones.filter((z) => selectedZoneIds.has(z.data.id) && !viewportIds.has(z.data.id));
      return [...viewportZones, ...manualExtra];
    }
    return zones.filter((z) => selectedZoneIds.has(z.data.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, autoZoneMode, boundsVersion, selectedZoneIds]);

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

  const handleExport = useCallback(() => {
    window.print();
  }, []);

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
        // URL param takes priority over default
        const urlType = initType.current;
        if (urlType) {
          const found = data.byType.find((t) => t.event_type === urlType);
          if (found) {
            setSelected(found.event_type);
            initialized.current = true;
            return;
          }
        }
        const preferred = data.byType.find(
          (t) => t.event_type === "FIRST_TIME_PHONE_STATUS_SENT",
        );
        setSelected(preferred?.event_type ?? data.byType[0]?.event_type ?? "");
        initialized.current = true;
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
        if (!Array.isArray(list)) throw new Error("zones response is not an array");
        const parsed: ParsedZone[] = [];
        for (const data of list) {
          const polygon = parseAreaJson(data.area_json);
          if (polygon) parsed.push({ data, polygon });
        }
        setZones(parsed);
        // Restore zone selection from URL
        const urlZones = initZones.current;
        if (urlZones && urlZones.length > 0) {
          const validIds = new Set(parsed.map((z) => z.data.id));
          const restored = urlZones.filter((id) => validIds.has(id));
          if (restored.length > 0) setSelectedZoneIds(new Set(restored));
          initZones.current = null;
        }
      })
      .catch((err) => console.warn("Zones fetch failed:", err));
  }, []);

  // ---------- sync state → URL ----------
  useEffect(() => {
    if (!initialized.current) return;
    const params: Record<string, string> = {};
    if (selected) params.type = selected;
    if (timeFrom) params.from = dateToDateParam(timeFrom);
    if (timeUntil) params.to = dateToDateParam(timeUntil);
    if (selectedZoneIds.size > 0) params.zones = [...selectedZoneIds].join(",");
    if (drawingState === "complete" && vertices.length >= 3) {
      params.poly = vertices
        .map(([lng, lat]) => `${lng.toFixed(4)},${lat.toFixed(4)}`)
        .join(",");
    }
    setSearchParams(params, { replace: true });
  }, [selected, timeFrom, timeUntil, selectedZoneIds, drawingState, vertices, setSearchParams]);

  // ---------- map init ----------
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [10.4515, 51.1657],
      zoom: 5.5,
      // preserveDrawingBuffer lets getCanvas().toDataURL() work for PDF export
      ...({ preserveDrawingBuffer: true } as {}),
    });

    map.current.addControl(new maplibregl.NavigationControl(), "top-right");

    overlay.current = new MapboxOverlay({ layers: [] });
    map.current.addControl(overlay.current);

    // Hide non-essential symbol layers, keep country + city/town labels
    map.current.on("load", () => {
      const keepPrefixes = ["place_country", "place_city", "place_capital", "place_town"];
      const style = map.current?.getStyle();
      if (style?.layers) {
        for (const layer of style.layers) {
          if (
            layer.type === "symbol" &&
            !keepPrefixes.some((p) => layer.id.startsWith(p))
          ) {
            map.current!.setLayoutProperty(layer.id, "visibility", "none");
          }
        }
      }
      mapBoundsRef.current = map.current?.getBounds() ?? null;
    });

    map.current.on("moveend", () => {
      if (!map.current) return;
      const raw = map.current.getZoom();
      const quantized = Math.round(raw * 2) / 2;
      setZoom(quantized);
      mapBoundsRef.current = map.current.getBounds();
      if (zoneAutoDiscoverRef.current && raw >= ZONE_AUTO_ZOOM) {
        setBoundsVersion((v) => v + 1);
      }
    });

    map.current.on("mousemove", (e) => {
      if (!geohashEnabledRef.current) return;
      const z = map.current?.getZoom() ?? 5.5;
      if (z < 10) { setHoveredGeohash(null); return; }
      const hash = geohashEncode(e.lngLat.lat, e.lngLat.lng, geohashPrecisionRef.current);
      setHoveredGeohash((prev) => prev === hash ? prev : hash);
    });

    map.current.on("mouseout", () => {
      if (!geohashEnabledRef.current) return;
      setHoveredGeohash(null);
    });

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

  // right-click context menu on zone polygons
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    const handleContextMenu = (e: maplibregl.MapMouseEvent) => {
      const clickPt: LngLat = [e.lngLat.lng, e.lngLat.lat];
      for (const zone of visibleZones) {
        if (pointInPolygon(clickPt, zone.polygon)) {
          e.preventDefault();
          setZoneContextMenu({ x: e.point.x, y: e.point.y, zone });
          return;
        }
      }
      setZoneContextMenu(null);
    };

    const handleDismiss = () => setZoneContextMenu(null);

    m.on("contextmenu", handleContextMenu);
    m.on("click", handleDismiss);
    document.addEventListener("keydown", handleDismiss);
    return () => {
      m.off("contextmenu", handleContextMenu);
      m.off("click", handleDismiss);
      document.removeEventListener("keydown", handleDismiss);
    };
  }, [visibleZones]);

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

    // heatmap (params adapt to zoom level) — skip when no data
    if (filteredEvents.length > 0) {
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
    }

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
        <button className="map-home-btn" onClick={() => navigate("/")}>&#8592; Home</button>


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
                {z.person?.person_account?.display_name && <div className="zt-row"><span className="zt-label">Owner</span> {z.person.person_account.display_name}</div>}
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

        {zoneContextMenu && (
          <div
            className="zone-context-menu"
            style={{ left: zoneContextMenu.x, top: zoneContextMenu.y }}
          >
            <div className="zone-context-menu-title">{zoneContextMenu.zone.data.name}</div>
            <button
              className="zone-context-menu-item"
              onClick={() => {
                setVertices(zoneContextMenu.zone.polygon);
                setDrawingState("complete");
                setZoneContextMenu(null);
              }}
            >
              Draw polygon
            </button>
            <button
              className="zone-context-menu-item"
              onClick={() => {
                navigator.clipboard.writeText(zoneContextMenu.zone.data.id);
                setZoneContextMenu(null);
              }}
            >
              Copy ID
            </button>
          </div>
        )}

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
              onChange={(e) => {
                setZoneAutoDiscover(e.target.checked);
                zoneAutoDiscoverRef.current = e.target.checked;
                if (e.target.checked && map.current && map.current.getZoom() >= ZONE_AUTO_ZOOM) {
                  setBoundsVersion((v) => v + 1);
                }
              }}
            />
            Discover Zones
          </label>
          <div className="geohash-group">
            <label className="geohash-toggle">
              <input
                type="checkbox"
                checked={geohashEnabled}
                onChange={(e) => {
                  setGeohashEnabled(e.target.checked);
                  geohashEnabledRef.current = e.target.checked;
                }}
              />
              Geohashes
            </label>
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
            onExport={handleExport}
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
