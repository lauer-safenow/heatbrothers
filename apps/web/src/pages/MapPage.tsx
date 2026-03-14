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
import { TimeHistogram } from "../components/TimeHistogram";
import { usePersistedSettings, DEFAULT_OVERRIDE_COLORS } from "../hooks/usePersistedSettings";
import { useCurrentUser } from "../hooks/useCurrentUser";
import "./MapPage.css";

const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const LIGHT_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

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

/* ── Custom event-type dropdown (always opens downward, theme-aware) ── */
function EventDropdown({
  eventTypes,
  selected,
  onSelect,
  displayName: dn,
}: {
  eventTypes: EventType[];
  selected: string;
  onSelect: (v: string) => void;
  displayName: (t: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const label = selected ? `${dn(selected)} (${eventTypes.find((t) => t.event_type === selected)?.count.toLocaleString() ?? ""})` : "None";

  return (
    <div className="event-dropdown" ref={ref}>
      <button className="event-dropdown-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="event-dropdown-label">{label}</span>
        <span className={`event-dropdown-chevron${open ? " open" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="event-dropdown-menu">
          <div
            className={`event-dropdown-item${!selected ? " active" : ""}`}
            onClick={() => { onSelect(""); setOpen(false); }}
          >
            None
          </div>
          {eventTypes.map((t) => (
            <div
              key={t.event_type}
              className={`event-dropdown-item${t.event_type === selected ? " active" : ""}`}
              onClick={() => { onSelect(t.event_type); setOpen(false); }}
            >
              {dn(t.event_type)} ({t.count.toLocaleString()})
            </div>
          ))}
        </div>
      )}
    </div>
  );
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

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(rgb: [number, number, number]): string {
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

const DARK_HEATMAP_DEFAULTS = ["#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026"];


// Standard heatmap gradient for light mode — #0995FF → #0869D8 → #0034E3
const LIGHT_HEATMAP_COLORS: [number, number, number][] = [
  [60, 160, 255],
  [5, 120, 230],
  [6, 88, 210],
  [4, 78, 220],
  [0, 52, 227],
  [0, 30, 160],
];

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
  const currentUser = useCurrentUser();
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
  const initZoom = useRef(searchParams.get("z") ? parseFloat(searchParams.get("z")!) : null);
  const initLat = useRef(searchParams.get("lat") ? parseFloat(searchParams.get("lat")!) : null);
  const initLng = useRef(searchParams.get("lng") ? parseFloat(searchParams.get("lng")!) : null);
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
  const [polyAnchorPx, setPolyAnchorPx] = useState<{ x: number; y: number } | null>(null);

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
  const [zoneFilterActive, setZoneFilterActive] = useState<boolean | null>(null);
  const [zoneFilterPublic, setZoneFilterPublic] = useState<boolean | null>(null);
  // persisted settings (localStorage)
  const [settings, updateSettings] = usePersistedSettings();
  const { mapTheme, geohashEnabled, geohashPrecision, zoneAutoDiscover, showZoomControls, colorOverride, heatmapColors, showActiveZones } = settings;

  const zoneLabelRef = useRef<HTMLDivElement>(null);

  // bottom bar panels: which panel is open (null = none)
  const [bottomPanel, setBottomPanel] = useState<"zones" | "date" | null>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);

  // settings menu
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // share toast
  const [showCopiedToast, setShowCopiedToast] = useState(false);

  // saved views
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveDescription, setSaveDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedViewsOpen, setSavedViewsOpen] = useState(false);
  const [savedViews, setSavedViews] = useState<{ id: number; description: string; params: string; is_home: number; created_at: number }[]>([]);
  const [savedViewCopiedId, setSavedViewCopiedId] = useState<number | null>(null);
  const [editingViewId, setEditingViewId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

  async function loadSavedViews() {
    const res = await fetch("/api/saved-views");
    if (res.ok) {
      const data = await res.json();
      setSavedViews(data.views);
    }
  }

  async function handleSaveView() {
    if (!saveDescription.trim()) return;
    setSaving(true);
    await fetch("/api/saved-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: saveDescription.trim(), params: searchParams.toString() }),
    });
    setSaving(false);
    setSaveDialogOpen(false);
    setSaveDescription("");
  }

  async function handleRename(id: number) {
    if (!editingName.trim()) return;
    await fetch(`/api/saved-views/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: editingName.trim() }),
    });
    setEditingViewId(null);
    loadSavedViews();
  }

  async function handleToggleHome(id: number, currentlyHome: boolean) {
    if (currentlyHome) {
      await fetch(`/api/saved-views/${id}/home`, { method: "DELETE" });
    } else {
      await fetch(`/api/saved-views/${id}/home`, { method: "POST" });
    }
    loadSavedViews();
  }

  // Auto-redirect to home view if no params on /map
  const homeChecked = useRef(false);
  useEffect(() => {
    if (homeChecked.current || searchParams.size > 0) return;
    homeChecked.current = true;
    fetch("/api/saved-views/home").then((r) => r.json()).then((data) => {
      if (data.home) {
        window.location.href = `/map?${data.home.params}`;
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // geohash hover
  const geohashEnabledRef = useRef(geohashEnabled);
  const geohashPrecisionRef = useRef<5 | 6>(geohashPrecision);
  const [hoveredGeohash, setHoveredGeohash] = useState<string | null>(null);
  const zoneAutoDiscoverRef = useRef(zoneAutoDiscover);

  useEffect(() => {
    geohashEnabledRef.current = geohashEnabled;
    geohashPrecisionRef.current = geohashPrecision;
    zoneAutoDiscoverRef.current = zoneAutoDiscover;
  }, [geohashEnabled, geohashPrecision, zoneAutoDiscover]);

  // close settings menu / saved views / save dialog on outside click
  useEffect(() => {
    if (!settingsOpen && !savedViewsOpen && !saveDialogOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
        setSavedViewsOpen(false);
        setSaveDialogOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen, savedViewsOpen, saveDialogOpen]);

  // close bottom bar panels on outside click
  useEffect(() => {
    if (!bottomPanel) return;
    const handler = (e: MouseEvent) => {
      if (bottomBarRef.current && !bottomBarRef.current.contains(e.target as Node)) {
        setBottomPanel(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [bottomPanel]);

  const autoZoneMode = zoneAutoDiscover && zoom >= ZONE_AUTO_ZOOM;

  const visibleZones = useMemo(() => {
    const result: ParsedZone[] = [];
    const seen = new Set<string>();

    const add = (z: ParsedZone) => {
      if (!seen.has(z.data.id)) {
        seen.add(z.data.id);
        result.push(z);
      }
    };

    // Active public zones (always visible when setting is on)
    if (showActiveZones) {
      zones.filter((z) => z.data.is_active && z.data.is_public).forEach(add);
    }

    // Auto-discovered zones in viewport
    if (autoZoneMode && mapBoundsRef.current) {
      const bounds = mapBoundsRef.current;
      zones.filter((z) => polygonIntersectsViewport(z.polygon, bounds)).forEach(add);
    }

    // Manually selected zones
    zones.filter((z) => selectedZoneIds.has(z.data.id)).forEach(add);

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, autoZoneMode, boundsVersion, selectedZoneIds, showActiveZones]);

  const filteredZoneList = zones.filter((z) => {
    if (!z.data.name.toLowerCase().includes(zoneSearch.toLowerCase())) return false;
    if (zoneFilterActive !== null && z.data.is_active !== zoneFilterActive) return false;
    if (zoneFilterPublic !== null && z.data.is_public !== zoneFilterPublic) return false;
    return true;
  });

  // city search
  const [searchQuery, setSearchQuery] = useState("");

  const anyFilterActive =
    drawingState !== "idle" ||
    selectedZoneIds.size > 0 ||
    timeFrom !== null ||
    timeUntil !== null ||
    searchQuery.trim() !== "";

  const handleResetAllFilters = () => {
    setDrawingState("idle");
    setVertices([]);
    setSelectedZoneIds(new Set());
    setTimeFrom(null);
    setTimeUntil(null);
    setSearchQuery("");
    setBottomPanel(null);
  };

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

  const legendColors = useMemo(() => {
    if (colorOverride) return heatmapColors;
    if (mapTheme === "light") return LIGHT_HEATMAP_COLORS.map(rgbToHex);
    return DARK_HEATMAP_DEFAULTS;
  }, [colorOverride, heatmapColors, mapTheme]);

  const maxCellDensity = useMemo(() => {
    void boundsVersion; // reactive dependency
    const b = mapBoundsRef.current;
    if (!b || filteredEvents.length === 0) return 0;

    const { radiusPixels } = getHeatmapParams(zoom);
    const pxPerDeg = (256 * Math.pow(2, zoom)) / 360;
    const cellSizeDeg = radiusPixels / pxPerDeg;

    const w = b.getWest(), s = b.getSouth();
    const cells = new Map<string, number>();
    let max = 0;

    for (const ev of filteredEvents) {
      if (ev[0] < b.getWest() || ev[0] > b.getEast() || ev[1] < b.getSouth() || ev[1] > b.getNorth()) continue;
      const col = Math.floor((ev[0] - w) / cellSizeDeg);
      const row = Math.floor((ev[1] - s) / cellSizeDeg);
      const key = `${col},${row}`;
      const count = (cells.get(key) ?? 0) + 1;
      cells.set(key, count);
      if (count > max) max = count;
    }
    return max;
  }, [filteredEvents, boundsVersion, zoom]);

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
    if (map.current) {
      const center = map.current.getCenter();
      params.z = map.current.getZoom().toFixed(2);
      params.lat = center.lat.toFixed(4);
      params.lng = center.lng.toFixed(4);
    }
    setSearchParams(params, { replace: true });
  }, [selected, timeFrom, timeUntil, selectedZoneIds, drawingState, vertices, zoom, setSearchParams]);

  // ---------- map init ----------
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: mapTheme === "dark" ? DARK_STYLE : LIGHT_STYLE,
      center: [initLng.current ?? 10.4515, initLat.current ?? 51.1657],
      zoom: initZoom.current ?? 5.5,
      attributionControl: false,
      // preserveDrawingBuffer lets getCanvas().toDataURL() work for PDF export
      ...({ preserveDrawingBuffer: true } as {}),
    });

    map.current.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.current.addControl(new maplibregl.NavigationControl(), "bottom-right");

    overlay.current = new MapboxOverlay({ layers: [] });
    map.current.addControl(overlay.current);

    // Hide non-essential symbol layers, keep country + city/town labels
    // Using style.load so it re-fires after theme switches too
    map.current.on("style.load", () => {
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
      setBoundsVersion((v) => v + 1);
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

  // track top-rightmost vertex in screen-space for polygon action buttons
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    const update = () => {
      if (drawingState !== "complete" || vertices.length < 3) {
        setPolyAnchorPx(null);
        return;
      }
      // rightmost vertex in screen-space (largest x)
      let best = m.project(vertices[0]);
      for (let i = 1; i < vertices.length; i++) {
        const pt = m.project(vertices[i]);
        if (pt.x > best.x) best = pt;
      }
      setPolyAnchorPx({ x: best.x, y: best.y });
    };

    update();
    m.on("move", update);
    return () => { m.off("move", update); };
  }, [drawingState, vertices]);

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
          ...(colorOverride
            ? { colorRange: heatmapColors.map(hexToRgb) }
            : mapTheme === "light" ? { colorRange: LIGHT_HEATMAP_COLORS } : {}),
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
          getColor: mapTheme === "dark" ? [255, 255, 255, 210] : [30, 30, 30, 200],
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
          getFillColor: mapTheme === "dark" ? [255, 140, 0, 35] : [120, 120, 120, 40],
          getLineColor: mapTheme === "dark" ? [255, 140, 0, 200] : [100, 100, 100, 200],
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
          getColor: mapTheme === "dark" ? [255, 140, 0, 200] : [100, 100, 100, 200],
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
            mapTheme === "dark"
              ? (o.index === 0 ? [255, 220, 50, 255] : [255, 140, 0, 255])
              : (o.index === 0 ? [80, 80, 80, 255] : [120, 120, 120, 255]),
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
            mapTheme === "dark"
              ? (d.isCenter ? [255, 255, 255, 25] : [255, 255, 255, 8])
              : (d.isCenter ? [0, 0, 0, 30] : [0, 0, 0, 10]),
          getLineColor: (d: { isCenter: boolean }) =>
            mapTheme === "dark"
              ? (d.isCenter ? [255, 255, 255, 120] : [255, 255, 255, 40])
              : (d.isCenter ? [0, 0, 0, 100] : [0, 0, 0, 35]),
          getLineWidth: (d: { isCenter: boolean }) => d.isCenter ? 2 : 1,
          lineWidthUnits: "pixels" as const,
          filled: true,
          stroked: true,
        }),
      );
    }

    overlay.current.setProps({ layers });
  }, [filteredEvents, drawingState, vertices, zoom, visibleZones, geohashEnabled, hoveredGeohash, mapTheme, heatmapColors, colorOverride]);

  // resize map after mount
  useEffect(() => {
    const t = setTimeout(() => map.current?.resize(), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className={`map-page${showZoomControls ? "" : " hide-zoom"}`} data-theme={mapTheme === "light" ? "light" : undefined}>
      <div className="map-section">
        <div ref={mapContainer} className="map-container" />
        <div className="map-logo" onClick={() => navigate("/")}>
          <img src="/safenow-icon.svg" alt="SafeNow" className="map-logo-icon" />
          <span className="map-logo-text">
            <span className="map-logo-safe">SafeNow</span>{" "}
            <span className="map-logo-world">World</span>
          </span>
        </div>

        <div className="map-top-right" ref={settingsRef}>
          <button
            className="screenshot-btn"
            title="Screenshot"
            onClick={async () => {
              try {
                const stream = await navigator.mediaDevices.getDisplayMedia({
                  video: { displaySurface: "browser" } as MediaTrackConstraints,
                  preferCurrentTab: true,
                } as DisplayMediaStreamOptions);
                const video = document.createElement("video");
                video.srcObject = stream;
                await video.play();
                // Wait a frame for the video to be ready
                await new Promise((r) => requestAnimationFrame(r));
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext("2d")!.drawImage(video, 0, 0);
                stream.getTracks().forEach((t) => t.stop());
                const link = document.createElement("a");
                link.download = `heatbrothers-${Date.now()}.png`;
                link.href = canvas.toDataURL("image/png");
                link.click();
              } catch {
                // User cancelled the picker
              }
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>
          <div style={{ position: "relative" }}>
            <button
              className="screenshot-btn"
              title="Share this view"
              disabled={searchParams.size === 0}
              onClick={() => {
                navigator.clipboard.writeText(window.location.href).then(() => {
                  setShowCopiedToast(true);
                  setTimeout(() => setShowCopiedToast(false), 2000);
                });
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
            {showCopiedToast && (
              <div className="copied-toast">Copied to clipboard</div>
            )}
          </div>
          <div style={{ position: "relative" }}>
            <button
              className="screenshot-btn"
              title="Save this view"
              disabled={searchParams.size === 0}
              onClick={() => {
                setSaveDialogOpen((v) => !v);
                setSettingsOpen(false);
                setSavedViewsOpen(false);
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
            {saveDialogOpen && (
              <div className="save-view-dialog">
                <input
                  className="save-view-input"
                  placeholder="Description..."
                  value={saveDescription}
                  onChange={(e) => setSaveDescription(e.target.value)}
                  maxLength={100}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && saveDescription.trim()) handleSaveView();
                    if (e.key === "Escape") setSaveDialogOpen(false);
                  }}
                />
                <button
                  className="save-view-submit"
                  disabled={saving || !saveDescription.trim()}
                  onClick={handleSaveView}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            )}
          </div>
          <button
            className="settings-btn"
            title="Settings"
            onClick={() => { setSettingsOpen((v) => !v); setSavedViewsOpen(false); setSaveDialogOpen(false); }}
          >
            <img src="/gear.svg" alt="Settings" width="18" height="18" />
          </button>
          {settingsOpen && (
            <div className="settings-menu">
              <div className="settings-row">
                <span className="settings-label">
                  {mapTheme === "dark" ? "Dark" : "Light"} Mode
                </span>
                <button
                  className="settings-theme-btn"
                  onClick={() => {
                    const next = mapTheme === "dark" ? "light" : "dark";
                    updateSettings({ mapTheme: next });
                    map.current?.setStyle(next === "dark" ? DARK_STYLE : LIGHT_STYLE);
                  }}
                >
                  {mapTheme === "dark" ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="5" />
                      <line x1="12" y1="1" x2="12" y2="3" />
                      <line x1="12" y1="21" x2="12" y2="23" />
                      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                      <line x1="1" y1="12" x2="3" y2="12" />
                      <line x1="21" y1="12" x2="23" y2="12" />
                      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                    </svg>
                  )}
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-label">Geohashes</span>
                <div className="settings-row-right">
                  {geohashEnabled && (
                    <div className="geohash-precision-toggle">
                      {([5, 6] as const).map((p) => (
                        <button
                          key={p}
                          className={`geohash-precision-btn${geohashPrecision === p ? " active" : ""}`}
                          onClick={() => {
                            updateSettings({ geohashPrecision: p });
                            setHoveredGeohash(null);
                          }}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  )}
                  <img
                    className="settings-toggle"
                    src={geohashEnabled ? "/on.svg" : "/off.svg"}
                    alt={geohashEnabled ? "On" : "Off"}
                    onClick={() => {
                      updateSettings({ geohashEnabled: !geohashEnabled });
                    }}
                  />
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">Discover Zones</span>
                <img
                  className="settings-toggle"
                  src={zoneAutoDiscover ? "/on.svg" : "/off.svg"}
                  alt={zoneAutoDiscover ? "On" : "Off"}
                  onClick={() => {
                    const next = !zoneAutoDiscover;
                    updateSettings({ zoneAutoDiscover: next });
                    if (next && map.current && map.current.getZoom() >= ZONE_AUTO_ZOOM) {
                      setBoundsVersion((v) => v + 1);
                    }
                  }}
                />
              </div>
              <div className="settings-row">
                <span className="settings-label">Active Zones</span>
                <img
                  className="settings-toggle"
                  src={showActiveZones ? "/on.svg" : "/off.svg"}
                  alt={showActiveZones ? "On" : "Off"}
                  onClick={() => updateSettings({ showActiveZones: !showActiveZones })}
                />
              </div>
              <div className="settings-row">
                <span className="settings-label">Zoom Controls</span>
                <img
                  className="settings-toggle"
                  src={showZoomControls ? "/on.svg" : "/off.svg"}
                  alt={showZoomControls ? "On" : "Off"}
                  onClick={() => updateSettings({ showZoomControls: !showZoomControls })}
                />
              </div>
              <div className="settings-divider" />
              <div className="settings-row">
                <span className="settings-label">Heatmap Colors</span>
                <img
                  className="settings-toggle"
                  src={colorOverride ? "/on.svg" : "/off.svg"}
                  alt={colorOverride ? "On" : "Off"}
                  onClick={() => updateSettings({ colorOverride: !colorOverride })}
                />
              </div>
              {colorOverride && (
                <div className="settings-colors">
                  {heatmapColors.map((c, i) => {
                    const labels = [
                      "Lightest Tint / Low Density",
                      "Light Tint / Low-Mid Density",
                      "Mid-Light / Mid Density",
                      "Mid-Dark / Mid-High Density",
                      "Dark Tint / High Density",
                      "Darkest Tint / Peak Density",
                    ];
                    return (
                      <div key={i} className="map-heatmap-stop">
                        <input
                          type="color"
                          className="map-heatmap-color"
                          title={`Stop ${i + 1} — ${labels[i]}`}
                          value={c}
                          onChange={(e) => {
                            const next = [...heatmapColors];
                            next[i] = e.target.value;
                            updateSettings({ heatmapColors: next });
                          }}
                        />
                        <span className="map-heatmap-label">{labels[i]}</span>
                      </div>
                    );
                  })}
                  <div className="settings-color-actions">
                    <button
                      className="map-color-export"
                      title="Copy gradient to clipboard"
                      onClick={() => {
                        const rgbs = heatmapColors.map(hexToRgb);
                        const hexes = heatmapColors.map(h => h.toUpperCase());
                        const lines = rgbs.map(([r, g, b], i) => {
                          const label = i === 0 ? "low density" : i === rgbs.length - 1 ? "high density" : `stop ${i + 1}`;
                          return `  [${r}, ${g}, ${b}],${" ".repeat(Math.max(1, 18 - `${r}, ${g}, ${b}`.length))}// ${hexes[i]} - ${label}`;
                        });
                        const code = `// Heatmap gradient — ${hexes[0]} → ${hexes[Math.floor(hexes.length / 2)]} → ${hexes[hexes.length - 1]}\nconst HEATMAP_COLORS: [number, number, number][] = [\n${lines.join("\n")}\n];`;
                        navigator.clipboard.writeText(code);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                    <button
                      className="map-color-export"
                      title="Reset to default colors"
                      onClick={() => updateSettings({ heatmapColors: [...DEFAULT_OVERRIDE_COLORS] })}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{ position: "relative" }}>
            <button
              className="screenshot-btn user-initials-btn"
              title={currentUser.name ?? currentUser.email ?? "dev-anon"}
              onClick={() => {
                setSavedViewsOpen((v) => {
                  if (!v) { loadSavedViews(); setSettingsOpen(false); setSaveDialogOpen(false); }
                  return !v;
                });
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 2 }}>
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.5px" }}>
                {(() => {
                  const name = currentUser.name ?? currentUser.email ?? "dev-anon";
                  const parts = name.trim().split(/\s+/);
                  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
                  return name.slice(0, 2).toUpperCase();
                })()}
              </span>
            </button>
            {savedViewsOpen && (
              <div className="saved-views-panel">
                <div className="saved-views-header">
                  <span>Saved Views</span>
                  <button className="saved-views-close" onClick={() => setSavedViewsOpen(false)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                {savedViews.length === 0 && (
                  <div className="saved-views-empty">No saved views yet</div>
                )}
                <div className="saved-views-list">
                {savedViews.map((v) => (
                  <div key={v.id} className={`saved-view-item${v.is_home ? " is-home" : ""}`}>
                    {editingViewId === v.id ? (
                      <input
                        className="save-view-input"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        maxLength={100}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRename(v.id);
                          if (e.key === "Escape") setEditingViewId(null);
                        }}
                        onBlur={() => handleRename(v.id)}
                      />
                    ) : (
                      <span
                        className="saved-view-desc"
                        title={v.description}
                        onClick={() => {
                          window.location.href = `/map?${v.params}`;
                        }}
                        onDoubleClick={() => {
                          setEditingViewId(v.id);
                          setEditingName(v.description);
                        }}
                      >
                        {v.is_home ? "🏠 " : ""}{v.description}
                      </span>
                    )}
                    <div className="saved-view-actions">
                      <button
                        title={v.is_home ? "Unset as home" : "Set as home"}
                        className={v.is_home ? "home-active" : ""}
                        onClick={() => handleToggleHome(v.id, !!v.is_home)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={v.is_home ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                      </button>
                      <button
                        title="Rename"
                        onClick={() => {
                          setEditingViewId(v.id);
                          setEditingName(v.description);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button
                        title="Copy link"
                        onClick={() => {
                          const url = `${window.location.origin}/map?${v.params}`;
                          navigator.clipboard.writeText(url).then(() => {
                            setSavedViewCopiedId(v.id);
                            setTimeout(() => setSavedViewCopiedId(null), 2000);
                          });
                        }}
                      >
                        {savedViewCopiedId === v.id ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                        )}
                      </button>
                      <div style={{ position: "relative" }}>
                        <button
                          title="Delete"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => setConfirmingDeleteId(confirmingDeleteId === v.id ? null : v.id)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                        {confirmingDeleteId === v.id && (
                          <div className="delete-confirm-popover" onMouseDown={(e) => e.stopPropagation()}>
                            <span>Delete?</span>
                            <button
                              className="delete-confirm-yes"
                              onClick={async () => {
                                await fetch(`/api/saved-views/${v.id}`, { method: "DELETE" });
                                setConfirmingDeleteId(null);
                                loadSavedViews();
                              }}
                            >Yes</button>
                            <button
                              className="delete-confirm-no"
                              onClick={() => setConfirmingDeleteId(null)}
                            >No</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div ref={zoneLabelRef} className="zone-label-container">
          {visibleZones.map((z) => (
            <div
              key={z.data.id}
              className="zone-html-label"
              onMouseEnter={(e) => {
                const rect = (e.currentTarget.closest(".map-section") as HTMLElement)?.getBoundingClientRect();
                if (rect) setZoneHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, zone: z });
              }}
              onMouseLeave={() => setZoneHover(null)}
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
              ref={(el) => {
                if (!el) return;
                const parent = el.offsetParent as HTMLElement;
                if (!parent) return;
                const pw = parent.clientWidth, ph = parent.clientHeight;
                const r = el.getBoundingClientRect();
                let left = zoneHover.x + 12, top = zoneHover.y - 12;
                if (left + r.width > pw) left = Math.max(0, zoneHover.x - r.width - 12);
                if (top + r.height > ph) top = Math.max(0, ph - r.height - 8);
                if (top < 0) top = 8;
                if (el.style.left !== `${left}px` || el.style.top !== `${top}px`) {
                  el.style.left = `${left}px`;
                  el.style.top = `${top}px`;
                }
              }}
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
          <EventDropdown
            eventTypes={eventTypes}
            selected={selected}
            onSelect={setSelected}
            displayName={displayName}
          />
          {loading && <span className="loading-badge">Loading...</span>}
        </div>

        <div className="event-count-badge" style={drawingState === "complete" ? { bottom: panelHeight + 10 } : undefined}>
          {filteredEvents.length.toLocaleString()} events
        </div>

        {filteredEvents.length > 0 && (
          <div className="heatmap-legend" style={drawingState === "complete" ? { bottom: panelHeight + 38 } : undefined}>
            <div
              className="heatmap-legend-bar"
              style={{
                background: `linear-gradient(to right, ${legendColors.join(", ")})`,
              }}
            />
            <div className="heatmap-legend-labels">
              {legendColors.map((_, i) => {
                const value = Math.round((maxCellDensity * i) / (legendColors.length - 1));
                return <span key={i}>{value.toLocaleString()}</span>;
              })}
            </div>
          </div>
        )}


        {/* ── polygon action buttons anchored to top-right vertex ── */}
        {drawingState === "complete" && polyAnchorPx && (
          <div
            className="poly-overlay-actions"
            style={{
              position: "absolute",
              left: polyAnchorPx.x + 12,
              top: polyAnchorPx.y,
              transform: "translateY(-50%)",
              zIndex: 12,
              display: "flex",
              gap: 4,
              pointerEvents: "auto",
            }}
          >
            <button
              className="poly-overlay-btn"
              title="Clear polygon"
              onClick={() => { setVertices([]); setDrawingState("idle"); }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1.5 14a2 2 0 0 1-2 2H8.5a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
            <button
              className="poly-overlay-btn"
              title="Redraw polygon"
              onClick={() => { setVertices([]); setDrawingState("drawing"); }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          </div>
        )}

        {/* ── bottom search bar ── */}
        <div className="bottom-search-bar" ref={bottomBarRef} style={drawingState === "complete" ? { bottom: panelHeight + 12 } : undefined}>
          {/* zones panel opens upward */}
          {bottomPanel === "zones" && (
            <div className="bottom-bar-panel bottom-bar-zones-panel">
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

          {/* date panel opens upward */}
          {bottomPanel === "date" && (
            <div className="bottom-bar-panel bottom-bar-date-panel">
              <div className="date-filters">
                <label>
                  FROM
                  <DatePicker
                    selected={timeFrom}
                    onChange={(d: Date | null) => setTimeFrom(d)}
                    dateFormat="dd.MM.yyyy"
                    isClearable
                    placeholderText="Select date"
                    popperPlacement="top-start"
                  />
                </label>
                <label>
                  UNTIL
                  <DatePicker
                    selected={timeUntil}
                    onChange={(d: Date | null) => setTimeUntil(d)}
                    dateFormat="dd.MM.yyyy"
                    isClearable
                    placeholderText="Select date"
                    popperPlacement="top-end"
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
          )}

          {/* main bar */}
          <div className="bottom-bar-main">
            <svg className="bottom-bar-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="bottom-bar-search-input"
              type="text"
              placeholder="City Search ..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  flyToCity(searchQuery);
                  setSearchQuery("");
                }
              }}
            />
            <div className="bottom-bar-divider" />
            <div className="bottom-bar-btn-wrapper">
              {drawingState === "complete" && <span className="filter-dot" />}
              <button
                className={`bottom-bar-btn${drawingState === "drawing" ? " active" : ""}`}
                onClick={() => {
                  if (drawingState === "idle") {
                    setVertices([]);
                    setDrawingState("drawing");
                  } else if (drawingState === "drawing") {
                    setVertices([]);
                    setDrawingState("idle");
                  }
                }}
              >
                <img src="/polygon.svg" alt="Polygon" width="16" height="16" className="bottom-bar-btn-icon" />
                Polygon
              </button>
            </div>
            <div
              className="bottom-bar-btn-wrapper"
              data-tooltip={selectedZoneIds.size > 0 ? zones.filter(z => selectedZoneIds.has(z.data.id)).map(z => z.data.name).join(", ") : undefined}
            >
              {selectedZoneIds.size > 0 && <span className="filter-dot" />}
              <button
                className={`bottom-bar-btn${bottomPanel === "zones" ? " active" : ""}`}
                onClick={() => setBottomPanel(bottomPanel === "zones" ? null : "zones")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                Zones
              </button>
            </div>
            <div
              className="bottom-bar-btn-wrapper"
              data-tooltip={timeFrom || timeUntil ? `${timeFrom ? timeFrom.toLocaleDateString("de-DE") : "…"} – ${timeUntil ? timeUntil.toLocaleDateString("de-DE") : "…"}` : undefined}
            >
              {(timeFrom !== null || timeUntil !== null) && <span className="filter-dot" />}
              <button
                className={`bottom-bar-btn${bottomPanel === "date" ? " active" : ""}`}
                onClick={() => setBottomPanel(bottomPanel === "date" ? null : "date")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                Date
              </button>
            </div>
            {anyFilterActive && (
              <>
                <div className="bottom-bar-divider" />
                <button className="bottom-bar-reset-btn" onClick={handleResetAllFilters} title="Reset all filters">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                  Reset
                </button>
              </>
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
