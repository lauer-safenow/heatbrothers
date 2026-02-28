import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PolygonLayer, PathLayer, ScatterplotLayer, type Layer } from "deck.gl";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import "../datepicker-dark.css";
import { LIVE_EVENT_TYPE, ZONE_EVENT_TYPE } from "@heatbrothers/shared";
import { pointInPolygon } from "../utils/pointInPolygon";
import { PolygonToolbar } from "../components/PolygonToolbar";
import "./LivePage.css";

type EventTuple = [number, number, number, number, string, string]; // [lng, lat, unixSeconds, id, city, countryCode]
type LngLat = [number, number];

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
  area_json: unknown;
  is_active: boolean;
  is_public: boolean;
  description: string | null;
  about: string | null;
  number_of_members: number;
  number_of_members_reachable: number;
  max_number_of_members_allowed: number | null;
  safe_spot_type: string;
  created_at: string;
  modified_at: string;
  valid_until: string | null;
  pss_image: { s3_location: string } | null;
  person: { person_account: { display_name: string } | null } | null;
}

interface ParsedZone {
  data: ZoneData;
  polygon: LngLat[];
}


interface QueueItem {
  id: number;
  lng: number;
  lat: number;
  label: string;
  flag: string;
  exiting: boolean;
  active: boolean;
}

type Mode = "live" | "replay";

const POLL_INTERVAL = 30_000;
const DISPLAY_DURATION = 3_000;

// Convert ISO country code to flag emoji
function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  return String.fromCodePoint(
    ...code.toUpperCase().split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

const countryDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
  if (!code || code.length !== 2) return code;
  try { return countryDisplayNames.of(code.toUpperCase()) || code; } catch { return code; }
}

function s3Url(location: string): string {
  if (location.startsWith("http")) return location;
  return `https://${location}`;
}

// Format Date → "YYYY-MM-DDTHH:MM" for URL params
function dateToParam(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  if (Array.isArray(parsed)) return parsed as LngLat[];
  return null;
}

function computePolygonBounds(polygon: LngLat[]): [[number, number], [number, number]] {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of polygon) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

function computePolygonCenter(polygon: LngLat[]): LngLat {
  const [[minLng, minLat], [maxLng, maxLat]] = computePolygonBounds(polygon);
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

// Parse URL param string "YYYY-MM-DDTHH:MM" → Date (or null)
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

type DrawingState = "idle" | "drawing" | "complete";

function TimeScroller({ value, count, onChange }: { value: number; count: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current?.children[value] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [value]);

  return (
    <div ref={ref} className="time-scroller">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={`time-scroller-item${i === value ? " selected" : ""}`}
          onClick={() => onChange(i)}
        >
          {i.toString().padStart(2, "0")}
        </div>
      ))}
    </div>
  );
}

export function LivePage() {
  const navigate = useNavigate();
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const queue = useRef<EventTuple[]>([]);
  const processing = useRef(false);
  const replayGen = useRef(0); // incremented on clearQueue; stale timeout callbacks check this and bail
  const lastSeenTs = useRef(0);
  const [activeEvent, setActiveEvent] = useState<EventTuple | null>(null);
  const [queueSize, setQueueSize] = useState(0);
  const [lastAdded, setLastAdded] = useState(0);
  const [ghostText, setGhostText] = useState<string | null>(null);
  const ghostAnimating = useRef(false);
  const countdownRef = useRef<HTMLSpanElement>(null);
  const [hintDismissed, setHintDismissed] = useState(false);

  // event type selection
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [liveEventType, setLiveEventType] = useState(LIVE_EVENT_TYPE);
  const liveEventTypeRef = useRef(LIVE_EVENT_TYPE);

  // queue display list with city names
  const [displayQueue, setDisplayQueue] = useState<QueueItem[]>([]);

  // blink overlay
  const blinkRef = useRef<HTMLDivElement>(null);
  const blinkLabelRef = useRef<HTMLDivElement>(null);
  const blinkLngLat = useRef<[number, number] | null>(null);

  // idle spin state
  const idleSpin = useRef(true);
  const raf = useRef(0);
  const currentLng = useRef(10);

  // playback speed multiplier
  const SPEED_OPTIONS = [0.5, 1, 2, 5, 10] as const;
  const speed = useRef(1);
  const [speedDisplay, setSpeedDisplay] = useState(1);

  // 2D / 3D view toggle
  const [mapView, setMapView] = useState<"2d" | "3d">("3d");
  const mapViewRef = useRef<"2d" | "3d">("3d");

  // URL params for shareable replay links
  const [searchParams, setSearchParams] = useSearchParams();
  const initMode = useRef((searchParams.get("mode") === "replay" ? "replay" : "live") as Mode);
  const initFrom = useRef(paramToDate(searchParams.get("from")) ?? new Date(Date.now() - 60 * 60 * 1000));
  const initTo = useRef(paramToDate(searchParams.get("to")) ?? new Date());
  const autoPlay = useRef(initMode.current === "replay" && !!searchParams.get("from") && !!searchParams.get("to"));
  const initZoneId = useRef<string | null>(searchParams.get("zoneid"));
  const initPoly = useRef<LngLat[] | null>(parsePolyParam(searchParams.get("poly")));

  // Auto-fly / free-move toggle
  const initEtype = useRef<string | null>(searchParams.get("etype"));
  const initFlyMode = useRef<"auto" | "free">(searchParams.get("fly") === "free" ? "free" : "auto");
  const [flyMode, setFlyMode] = useState<"auto" | "free">(initFlyMode.current);
  const flyModeRef = useRef<"auto" | "free">(initFlyMode.current);
  const etypeRef = useRef<string | null>(initEtype.current);

  // mode state
  const [todayMode, setTodayMode] = useState(false);
  const [mode, setMode] = useState<Mode>(initMode.current);
  const modeRef = useRef<Mode>(initMode.current);
  const [replayFrom, setReplayFrom] = useState<Date>(initFrom.current);
  const [replayTo, setReplayTo] = useState<Date>(initTo.current);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayInfo, setReplayInfo] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"from" | "to">("from");
  const [pickerOpen, setPickerOpen] = useState(true);

  // Zone replay state
  const [zones, setZones] = useState<ParsedZone[]>([]);
  const [selectedZone, setSelectedZone] = useState<ParsedZone | null>(null);
  const [zoneSearch, setZoneSearch] = useState("");
  const [zoneDropdownOpen, setZoneDropdownOpen] = useState(false);
  const zoneDropdownRef = useRef<HTMLDivElement>(null);
  const selectedZoneRef = useRef<ParsedZone | null>(null);
  const [zoneTooltipPos, setZoneTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Polygon drawing state
  const [drawingState, setDrawingState] = useState<DrawingState>(
    initPoly.current ? "complete" : "idle"
  );
  const [polyVertices, setPolyVertices] = useState<LngLat[]>(initPoly.current ?? []);
  const drawingStateRef = useRef<DrawingState>(initPoly.current ? "complete" : "idle");
  const polyVerticesRef = useRef<LngLat[]>(initPoly.current ?? []);

  // Keep refs in sync with state (for use inside closures like processReplay)
  useEffect(() => { drawingStateRef.current = drawingState; }, [drawingState]);
  useEffect(() => { polyVerticesRef.current = polyVertices; }, [polyVertices]);

  // Sync polygon state to URL
  useEffect(() => {
    if (mode === "replay") updateUrl("replay");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingState, polyVertices]);

  // Timeline / scrubbing state (replay only)
  const replayEvents = useRef<EventTuple[]>([]);
  const playbackIndex = useRef(0);
  const isScrubRef = useRef(false);
  const [timelinePosition, setTimelinePosition] = useState(0);
  const [replayVersion, setReplayVersion] = useState(0);
  const densityCanvasRef = useRef<HTMLCanvasElement>(null);
  const [scrubActive, setScrubActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pinnedCountry, setPinnedCountry] = useState<string | null>(null);
  useEffect(() => {
    if (!pinnedCountry) return;
    const close = () => setPinnedCountry(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [pinnedCountry]);
  const replayPaused = useRef(false);

  // Precomputed country index — built once when replay events load
  type CountryEntry = { flag: string; events: { city: string; time: number; idx: number }[] };
  const countryIndex = useRef<Map<string, CountryEntry>>(new Map());

  // Full country tally — computed once when replay events load, static during playback/scrubbing
  const countryTally = useMemo(() => {
    const ci = countryIndex.current;
    if (ci.size === 0) return [];
    const result: [string, { flag: string; count: number; events: { city: string; time: number; idx: number }[] }][] = [];
    for (const [cc, data] of ci) {
      const evts = data.events;
      result.push([cc, { flag: data.flag, count: evts.length, events: evts }]);
    }
    result.sort((a, b) => b[1].count - a[1].count);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayVersion]);

  const activeDate = activeTab === "from" ? replayFrom : replayTo;
  function setActiveDate(d: Date) {
    if (activeTab === "from") { setReplayFrom(d); updateUrl("replay", d, replayTo); }
    else { setReplayTo(d); updateUrl("replay", replayFrom, d); }
  }

  function formatShort(d: Date) {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function updateUrl(m: Mode, from?: Date, to?: Date) {
    if (m === "replay") {
      const params: Record<string, string> = {
        mode: "replay",
        from: dateToParam(from || replayFrom),
        to: dateToParam(to || replayTo),
      };
      if (selectedZoneRef.current) params.zoneid = selectedZoneRef.current.data.id;
      const poly = polyVerticesRef.current;
      if (drawingStateRef.current === "complete" && poly.length >= 3) {
        params.poly = poly
          .map(([lng, lat]) => `${lng.toFixed(4)},${lat.toFixed(4)}`)
          .join(",");
      }
      params.fly = flyModeRef.current;
      if (etypeRef.current) params.etype = etypeRef.current;
      setSearchParams(params, { replace: true });
    } else {
      const params: Record<string, string> = { fly: flyModeRef.current };
      if (liveEventTypeRef.current && liveEventTypeRef.current !== LIVE_EVENT_TYPE) {
        params.etype = liveEventTypeRef.current;
      }
      setSearchParams(params, { replace: true });
    }
  }

  function updateBlinkPosition() {
    if (!map.current || !blinkRef.current || !blinkLngLat.current) return;
    const px = map.current.project(blinkLngLat.current);
    blinkRef.current.style.left = `${px.x}px`;
    blinkRef.current.style.top = `${px.y}px`;
    if (blinkLabelRef.current) {
      blinkLabelRef.current.style.left = `${px.x}px`;
      blinkLabelRef.current.style.top = `${px.y}px`;
    }
  }

  function syncQueueSize() {
    setQueueSize(queue.current.length);
  }

  function updateZoneTooltipPos() {
    const zone = selectedZoneRef.current;
    if (!map.current || !zone) { setZoneTooltipPos(null); return; }
    const center = computePolygonCenter(zone.polygon);
    const px = map.current.project(center as [number, number]);
    setZoneTooltipPos({ x: px.x, y: px.y });
  }

  function enqueueEvents(fresh: EventTuple[]) {
    fresh.sort((a, b) => a[2] - b[2]);
    queue.current.push(...fresh);
    syncQueueSize();

    const newItems: QueueItem[] = fresh.map((e) => ({
      id: e[3],
      lng: e[0],
      lat: e[1],
      label: e[4] || "Unknown",
      flag: countryFlag(e[5] || ""),
      exiting: false,
      active: false,
    }));
    setDisplayQueue((prev) => [...prev, ...newItems]);

    if (!processing.current) {
      processQueue();
    }
  }

  useEffect(() => {
    if (!mapContainer.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [10, 50],
      zoom: 0.8,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      interactive: false,
      fadeDuration: 300,
    });

    overlay.current = new MapboxOverlay({ layers: [] });
    map.current.addControl(overlay.current);

    map.current.on("load", () => {
      map.current?.setProjection({ type: "globe" });

      // Hide sub-national boundary lines (keep only country borders)
      const style = map.current?.getStyle();
      if (style?.layers) {
        for (const layer of style.layers) {
          if (layer.type === "line" && layer.id.includes("boundary") && !layer.id.includes("country")) {
            map.current!.setLayoutProperty(layer.id, "visibility", "none");
          }
        }
      }
    });

    map.current.on("move", updateBlinkPosition);
    map.current.on("moveend", updateZoneTooltipPos);

    // If URL has a polygon, fly to it immediately (no globe flash)
    if (initPoly.current && initPoly.current.length >= 3) {
      const bounds = computePolygonBounds(initPoly.current);
      map.current.fitBounds(bounds, { padding: 120, maxZoom: 13, duration: 0 });
      idleSpin.current = false;
    }

    const spin = () => {
      if (idleSpin.current && map.current) {
        currentLng.current += 0.03;
        if (currentLng.current > 180) currentLng.current -= 360;
        map.current.setCenter([currentLng.current, 50]);
      }
      raf.current = requestAnimationFrame(spin);
    };
    raf.current = requestAnimationFrame(spin);

    // If URL says replay with from/to, auto-play; otherwise start live
    // When zoneid is present, defer autoplay until zone is loaded
    if (autoPlay.current && !initZoneId.current) {
      autoPlay.current = false;
      startReplay();
    } else if (!autoPlay.current) {
      lastSeenTs.current = Math.floor(Date.now() / 1000) - 10 * 60;
      fetchNewEvents();
    }

    let countdownVal = POLL_INTERVAL / 1000;
    const setCountdownDOM = (v: number) => {
      countdownVal = v;
      if (countdownRef.current) countdownRef.current.textContent = `${v}s`;
    };

    const pollTimer = setInterval(() => {
      if (modeRef.current !== "live") return;
      setCountdownDOM(POLL_INTERVAL / 1000);
      fetchNewEvents();
    }, POLL_INTERVAL);

    const tickTimer = setInterval(() => {
      if (modeRef.current !== "live") return;
      setCountdownDOM(Math.max(0, countdownVal - 1));
    }, 1000);

    return () => {
      cancelAnimationFrame(raf.current);
      clearInterval(pollTimer);
      clearInterval(tickTimer);
      map.current?.remove();
      map.current = null;
      overlay.current = null;
    };
  }, []);

  // Fetch event types once on mount
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data: { byType: EventType[] }) => {
        setEventTypes(data.byType);
        const urlType = initEtype.current;
        if (urlType) {
          const found = data.byType.find((t) => t.event_type === urlType);
          if (found) {
            setLiveEventType(found.event_type);
            liveEventTypeRef.current = found.event_type;
            etypeRef.current = found.event_type;
            return;
          }
        }
      })
      .catch(() => {});
  }, []);

  // Fetch zones once on mount
  useEffect(() => {
    fetch("/api/zones")
      .then((r) => r.json())
      .then(({ zones: list }: { zones: ZoneData[] }) => {
        const parsed: ParsedZone[] = [];
        for (const data of list) {
          const polygon = parseAreaJson(data.area_json);
          if (polygon) parsed.push({ data, polygon });
        }
        setZones(parsed);
        if (initZoneId.current) {
          const found = parsed.find((z) => z.data.id === initZoneId.current);
          if (found) {
            setSelectedZone(found);
            selectedZoneRef.current = found;
          }
          initZoneId.current = null;
          // Deferred autoplay: zone is now loaded, trigger replay
          if (autoPlay.current) {
            autoPlay.current = false;
            setTimeout(() => startReplay(), 0);
          }
        }
      })
      .catch((err) => console.warn("Zones fetch failed:", err));
  }, []);

  // Close zone dropdown on outside click
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

  // Polygon click handler — add vertices on map click during drawing
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      if (drawingState !== "drawing") return;

      const newPt: LngLat = [e.lngLat.lng, e.lngLat.lat];

      // Snap-to-close: if near first vertex, complete the polygon
      if (polyVertices.length >= 3) {
        const firstPx = m.project(new maplibregl.LngLat(polyVertices[0][0], polyVertices[0][1]));
        const clickPx = m.project(e.lngLat);
        const dist = Math.hypot(clickPx.x - firstPx.x, clickPx.y - firstPx.y);
        if (dist < 20) {
          setDrawingState("complete");
          return;
        }
      }

      setPolyVertices((prev) => [...prev, newPt]);
    };

    m.on("click", handleClick);
    return () => { m.off("click", handleClick); };
  }, [drawingState, polyVertices]);

  // ESC to cancel polygon drawing
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawingState === "drawing") {
        setPolyVertices([]);
        setDrawingState("idle");
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [drawingState]);

  // Crosshair cursor during polygon drawing
  useEffect(() => {
    if (!map.current) return;
    map.current.getCanvas().style.cursor = drawingState === "drawing" ? "crosshair" : "";
  }, [drawingState]);

  async function fetchNewEvents() {
    if (modeRef.current !== "live") return;
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(liveEventTypeRef.current)}/since/${lastSeenTs.current}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const fresh: EventTuple[] = data.events;

      console.log(
        `[live] poll → ${fresh.length} new | queue=${queue.current.length} processing=${processing.current}`,
      );
      setLastAdded(fresh.length);
      if (fresh.length === 0) return;

      // Advance cursor to highest timestamp
      lastSeenTs.current = Math.max(...fresh.map((e) => e[2]));

      if (!ghostAnimating.current) {
        setGhostText(`+${fresh.length}`);
        ghostAnimating.current = true;
      }

      enqueueEvents(fresh);
    } catch (err) {
      console.error("[live] poll error:", err);
    }
  }

  // Enable map interaction in replay mode or free-move mode
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (mode === "replay" || flyMode === "free") {
      m.scrollZoom.enable();
      m.doubleClickZoom.enable();
      m.dragPan.enable();
      m.touchZoomRotate.enable();
    } else {
      m.scrollZoom.disable();
      m.doubleClickZoom.disable();
      m.dragPan.disable();
      m.touchZoomRotate.disable();
    }
  }, [mode, flyMode]);

  // Draw event density on timeline canvas when replay events change
  useEffect(() => {
    const canvas = densityCanvasRef.current;
    const events = replayEvents.current;
    if (!canvas || events.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const bins = new Uint32Array(w);
    const tMin = events[0][2];
    const tMax = events[events.length - 1][2];
    const range = tMax - tMin || 1;

    for (const e of events) {
      const bin = Math.min(w - 1, Math.floor(((e[2] - tMin) / range) * w));
      bins[bin]++;
    }

    let maxBin = 0;
    for (let i = 0; i < w; i++) if (bins[i] > maxBin) maxBin = bins[i];

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255, 140, 0, 0.25)";
    for (let i = 0; i < w; i++) {
      if (bins[i] > 0) {
        const barH = Math.max(1, (bins[i] / maxBin) * h);
        ctx.fillRect(i, h - barH, 1, barH);
      }
    }
  }, [replayVersion]);

  // Render zone polygon + user polygon via deck.gl
  useEffect(() => {
    if (!overlay.current) return;

    const layers: Layer[] = [];

    // Zone polygon
    if (selectedZone) {
      layers.push(
        new PolygonLayer({
          id: "zone-fill",
          data: [{ polygon: selectedZone.polygon }],
          getPolygon: (d: { polygon: LngLat[] }) => d.polygon,
          getFillColor: [0, 150, 255, 20],
          getLineColor: [0, 150, 255, 180],
          getLineWidth: 2,
          lineWidthUnits: "pixels" as const,
          filled: true,
          stroked: true,
        }),
      );
    }

    // Completed user polygon
    if (drawingState === "complete" && polyVertices.length >= 3) {
      layers.push(
        new PolygonLayer({
          id: "user-polygon-fill",
          data: [{ polygon: polyVertices }],
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

    // Drawing in progress — edges
    if (drawingState === "drawing" && polyVertices.length > 0) {
      layers.push(
        new PathLayer({
          id: "polygon-edges",
          data: [{ path: polyVertices }],
          getPath: (d: { path: LngLat[] }) => d.path,
          getColor: [255, 140, 0, 200],
          getWidth: 2,
          widthUnits: "pixels" as const,
        }),
      );
      layers.push(
        new ScatterplotLayer({
          id: "polygon-vertices",
          data: polyVertices,
          getPosition: (d: LngLat) => d,
          getFillColor: (_d: LngLat, o: { index: number }) =>
            o.index === 0 ? [255, 220, 50, 255] : [255, 140, 0, 255],
          getRadius: (_d: LngLat, o: { index: number }) =>
            o.index === 0 ? 8 : 5,
          radiusUnits: "pixels" as const,
        }),
      );
    }

    overlay.current.setProps({ layers });
  }, [selectedZone, drawingState, polyVertices]);

  function clearQueue() {
    replayGen.current++;
    queue.current = [];
    processing.current = false;
    syncQueueSize();
    setDisplayQueue([]);
    setActiveEvent(null);
    hideBlink();
    // Reset replay timeline state
    replayEvents.current = [];
    countryIndex.current = new Map();
    playbackIndex.current = 0;
    replayPaused.current = false;
    isScrubRef.current = false;
    setPaused(false);
    setScrubActive(false);
    setTimelinePosition(0);
  }

  function switchToReplay() {
    modeRef.current = "replay";
    setMode("replay");
    setTodayMode(false);
    clearQueue();
    idleSpin.current = false;
    setReplayInfo(null);
    setLastAdded(0);
    setGhostText(null);
    setPickerOpen(true);
    updateUrl("replay");
  }

  function switchToToday() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    modeRef.current = "replay";
    setMode("replay");
    setTodayMode(true);
    clearQueue();
    idleSpin.current = false;
    setReplayInfo(null);
    setLastAdded(0);
    setGhostText(null);
    setReplayFrom(todayStart);
    setReplayTo(todayEnd);
    setPickerOpen(false);
    updateUrl("replay", todayStart, todayEnd);
    // Auto-start playback after state settles
    setTimeout(() => startReplayWithDates(todayStart, todayEnd), 50);
  }

  function switchToLive() {
    modeRef.current = "live";
    setMode("live");
    setTodayMode(false);
    clearQueue();
    idleSpin.current = true;
    setReplayInfo(null);
    updateUrl("live");
    selectedZoneRef.current = null;
    setSelectedZone(null);
    setZoneTooltipPos(null);
    // Clear polygon
    setPolyVertices([]);
    setDrawingState("idle");
    // Resume live: last 10 minutes
    lastSeenTs.current = Math.floor(Date.now() / 1000) - 10 * 60;
    if (countdownRef.current) countdownRef.current.textContent = `${POLL_INTERVAL / 1000}s`;
    fetchNewEvents();
  }

  function changeEventType(newType: string) {
    setLiveEventType(newType);
    liveEventTypeRef.current = newType;
    etypeRef.current = newType;
    clearQueue();
    lastSeenTs.current = Math.floor(Date.now() / 1000) - 10 * 60;
    if (modeRef.current === "live") {
      fetchNewEvents();
    }
    updateUrl(modeRef.current);
  }

  function toggleMapView() {
    const next = mapViewRef.current === "3d" ? "2d" : "3d";
    mapViewRef.current = next;
    setMapView(next);

    if (next === "2d") {
      map.current?.setProjection({ type: "mercator" });
      idleSpin.current = false;
      map.current?.flyTo({ center: [0, 20], zoom: 1, duration: 800, essential: true });
    } else {
      map.current?.setProjection({ type: "globe" });
      if (queue.current.length === 0 && !processing.current) {
        idleSpin.current = true;
      }
    }
  }

  function toggleFlyMode() {
    const next = flyModeRef.current === "auto" ? "free" : "auto";
    flyModeRef.current = next;
    setFlyMode(next);
    if (next === "free") {
      idleSpin.current = false;
    } else if (mapViewRef.current === "3d" && queue.current.length === 0 && !processing.current) {
      idleSpin.current = true;
    }
    updateUrl(modeRef.current);
  }

  async function startReplayWithDates(from: Date, to: Date) {
    const fromEpoch = Math.floor(from.getTime() / 1000);
    const toEpoch = Math.floor(to.getTime() / 1000);
    if (isNaN(fromEpoch) || isNaN(toEpoch) || fromEpoch >= toEpoch) {
      setReplayInfo("Invalid time range");
      return;
    }

    // Stop idle spin immediately so fitBounds animation isn't overwritten
    idleSpin.current = false;

    // Snapshot zone and polygon at play-time so closures have stable references
    // Prefer ref over state — ref may already be set by initZoneId before React re-renders
    const zone = selectedZoneRef.current ?? selectedZone;
    selectedZoneRef.current = zone;
    const poly = polyVerticesRef.current;
    const polyComplete = drawingStateRef.current === "complete" && poly.length >= 3;

    clearQueue();
    setReplayLoading(true);
    setReplayInfo(null);
    updateUrl("replay", from, to);

    if (zone) {
      const bounds = computePolygonBounds(zone.polygon);
      map.current?.fitBounds(bounds, { padding: 120, duration: 1200, maxZoom: 13 });
    } else if (polyComplete) {
      const bounds = computePolygonBounds(poly);
      map.current?.fitBounds(bounds, { padding: 120, duration: 1200, maxZoom: 13 });
    }

    try {
      const eventType = etypeRef.current || (zone ? ZONE_EVENT_TYPE : LIVE_EVENT_TYPE);
      let fetchUrl = `/api/events/${encodeURIComponent(eventType)}/between/${fromEpoch}/${toEpoch}`;
      // Pass bounding box to server so it filters before the cap
      if (zone) {
        const [[minLng, minLat], [maxLng, maxLat]] = computePolygonBounds(zone.polygon);
        fetchUrl += `?bbox=${minLng},${minLat},${maxLng},${maxLat}`;
      } else if (polyComplete) {
        const [[minLng, minLat], [maxLng, maxLat]] = computePolygonBounds(poly);
        fetchUrl += `?bbox=${minLng},${minLat},${maxLng},${maxLat}`;
      }
      const res = await fetch(fetchUrl);
      if (!res.ok) { setReplayInfo("Fetch failed"); return; }
      const data = await res.json();
      let events: EventTuple[] = data.events;

      if (zone) {
        events = events.filter(([lng, lat]) => pointInPolygon([lng, lat], zone.polygon));
        setReplayInfo(`${events.length.toLocaleString()} events in zone`);
      } else if (polyComplete) {
        events = events.filter(([lng, lat]) => pointInPolygon([lng, lat], poly));
        setReplayInfo(`${events.length.toLocaleString()} events in polygon`);
      } else {
        const info = data.capped
          ? `${data.count.toLocaleString()} of ${data.total.toLocaleString()} events (capped)`
          : `${data.count.toLocaleString()} events`;
        setReplayInfo(info);
      }

      if (events.length === 0) {
        return;
      }

      // Store full event set for index-based replay with timeline scrubbing
      events.sort((a, b) => a[2] - b[2]);
      replayEvents.current = events;

      // Build precomputed country index for O(log n) tally lookups
      const ci = new Map<string, CountryEntry>();
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const cc = e[5] || "??";
        let entry = ci.get(cc);
        if (!entry) { entry = { flag: countryFlag(cc), events: [] }; ci.set(cc, entry); }
        entry.events.push({ city: e[4] || "Unknown", time: e[2], idx: i });
      }
      countryIndex.current = ci;

      playbackIndex.current = 0;
      setTimelinePosition(0);
      setReplayVersion((v) => v + 1);

      idleSpin.current = false;
      if (zone || polyComplete) {
        // Delay start so fitBounds animation finishes before blinking begins
        setTimeout(() => { processReplay(); if (zone) updateZoneTooltipPos(); }, 1300);
      } else {
        processReplay();
      }
    } catch (err) {
      console.error("[replay] fetch error:", err);
      setReplayInfo("Fetch error");
    } finally {
      setReplayLoading(false);
    }
  }

  function startReplay() {
    return startReplayWithDates(replayFrom, replayTo);
  }

  function showBlink(lng: number, lat: number, timestamp: number) {
    blinkLngLat.current = [lng, lat];
    if (blinkRef.current) {
      updateBlinkPosition();
      blinkRef.current.style.display = "block";
      blinkRef.current.classList.remove("blink-animate");
      void blinkRef.current.offsetWidth;
      blinkRef.current.classList.add("blink-animate");
    }
    if (blinkLabelRef.current) {
      const d = new Date(timestamp * 1000);
      blinkLabelRef.current.textContent = `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")}.${d.getFullYear()} ${d.toLocaleTimeString()}`;
      blinkLabelRef.current.style.display = "block";
      blinkLabelRef.current.classList.remove("label-float-up");
      void blinkLabelRef.current.offsetWidth;
      blinkLabelRef.current.classList.add("label-float-up");
    }
  }

  function hideBlink() {
    blinkLngLat.current = null;
    if (blinkRef.current) {
      blinkRef.current.style.display = "none";
      blinkRef.current.classList.remove("blink-animate");
    }
    if (blinkLabelRef.current) {
      blinkLabelRef.current.style.display = "none";
      blinkLabelRef.current.classList.remove("label-float-up");
    }
  }

  // ── Replay: index-based playback ──

  const DISPLAY_WINDOW = 15;

  function rebuildDisplayWindow(fromIndex: number) {
    const events = replayEvents.current;
    const window = events.slice(fromIndex, fromIndex + DISPLAY_WINDOW);
    const items: QueueItem[] = window.map((e) => ({
      id: e[3],
      lng: e[0],
      lat: e[1],
      label: e[4] || "Unknown",
      flag: countryFlag(e[5] || ""),
      exiting: false,
      active: false,
    }));
    setDisplayQueue(items);
  }

  function processReplay() {
    const events = replayEvents.current;
    if (playbackIndex.current >= events.length) {
      // Replay finished
      processing.current = false;
      setDisplayQueue([]);
      setActiveEvent(null);
      hideBlink();
      const hasRegion = selectedZoneRef.current !== null ||
        (drawingStateRef.current === "complete" && polyVerticesRef.current.length >= 3);
      if (!hasRegion && mapViewRef.current === "3d") {
        // No polygon/zone — fly back to overview but stay still (no spin in replay)
        map.current?.flyTo({ center: [currentLng.current, 50], zoom: 0.8, duration: 1500, essential: true });
      }
      return;
    }

    if (replayPaused.current || isScrubRef.current) return;

    processing.current = true;
    idleSpin.current = false;
    const gen = replayGen.current;
    const idx = playbackIndex.current;
    const event = events[idx];
    const [lng, lat] = event;
    const eventId = event[3];

    setTimelinePosition(idx);
    setActiveEvent(event);
    rebuildDisplayWindow(idx);

    // Mark current item active
    setDisplayQueue((prev) =>
      prev.map((item) => item.id === eventId ? { ...item, active: true } : item),
    );

    const onEventDone = () => {
      if (gen !== replayGen.current) return;
      hideBlink();
      setActiveEvent(null);
      // Mark exiting then remove
      setDisplayQueue((prev) => prev.filter((item) => item.id !== eventId));
      playbackIndex.current = idx + 1;
      setTimelinePosition(idx + 1);
      requestAnimationFrame(() => processReplay());
    };

    const isZoneMode = selectedZoneRef.current !== null;
    const isPolyMode = drawingStateRef.current === "complete" && polyVerticesRef.current.length >= 3;
    const is2D = mapViewRef.current === "2d";
    const isFreeMove = flyModeRef.current === "free";

    if (isZoneMode || isPolyMode || is2D || isFreeMove) {
      showBlink(lng, lat, event[2]);
      setDisplayQueue((prev) =>
        prev.map((item) => item.id === eventId ? { ...item, exiting: true, active: false } : item),
      );
      setTimeout(() => {
        if (gen !== replayGen.current) return;
        onEventDone();
      }, DISPLAY_DURATION / speed.current);
    } else {
      const onArrival = () => {
        map.current?.off("moveend", onArrival);
        if (gen !== replayGen.current) return;
        showBlink(lng, lat, event[2]);
        setDisplayQueue((prev) =>
          prev.map((item) => item.id === eventId ? { ...item, exiting: true, active: false } : item),
        );
        setTimeout(() => {
          if (gen !== replayGen.current) return;
          onEventDone();
        }, DISPLAY_DURATION / speed.current);
      };

      const center = map.current!.getCenter();
      const dist = Math.hypot(lng - center.lng, lat - center.lat);
      const duration = Math.min(8000, 2000 + dist * 60) / speed.current;
      map.current!.once("moveend", onArrival);

      if (dist < 15) {
        map.current!.easeTo({ center: [lng, lat], zoom: 6, duration, essential: true });
      } else {
        map.current!.flyTo({ center: [lng, lat], zoom: 6, duration, curve: 1, essential: true });
      }
    }
  }

  // ── Scrubbing handlers ──

  function onScrubStart() {
    replayPaused.current = true;
    isScrubRef.current = true;
    setScrubActive(true);

    replayGen.current++;
    processing.current = false;
    hideBlink();
    map.current?.stop();
  }

  function onScrubChange(index: number) {
    playbackIndex.current = index;
    setTimelinePosition(index);

    const event = replayEvents.current[index];
    if (!event || !map.current) return;

    const [lng, lat] = event;
    const isRegion = selectedZoneRef.current !== null ||
      (drawingStateRef.current === "complete" && polyVerticesRef.current.length >= 3);
    const isFreeMove = flyModeRef.current === "free";

    // In zone/poly/free mode, don't move the map — just update the blink marker
    if (!isRegion && !isFreeMove) {
      if (mapViewRef.current === "2d") {
        map.current.panTo([lng, lat]);
      } else {
        map.current.jumpTo({ center: [lng, lat], zoom: 6 });
      }
    }

    // Show static blink marker + label (no fade-out animation)
    blinkLngLat.current = [lng, lat];
    if (blinkRef.current) {
      blinkRef.current.classList.remove("blink-animate");
      blinkRef.current.style.display = "block";
      updateBlinkPosition();
    }
    if (blinkLabelRef.current) {
      const d = new Date(event[2] * 1000);
      blinkLabelRef.current.textContent = `${event[4] || ""} ${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")}.${d.getFullYear()} ${d.toLocaleTimeString()}`;
      blinkLabelRef.current.style.display = "block";
      blinkLabelRef.current.classList.remove("label-float-up");
      updateBlinkPosition();
    }

    setActiveEvent(event);
    rebuildDisplayWindow(index);
  }

  function onScrubEnd() {
    isScrubRef.current = false;
    setScrubActive(false);

    replayPaused.current = false;
    hideBlink();
    processReplay();
  }

  function togglePause() {
    if (replayPaused.current) {
      // Resume
      replayPaused.current = false;
      setPaused(false);
      processReplay();
    } else {
      // Pause
      replayPaused.current = true;
      setPaused(true);
      replayGen.current++;
      processing.current = false;
      map.current?.stop();
    }
  }

  function formatTimelineTime(ts: number): string {
    const d = new Date(ts * 1000);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }

  function processQueue() {
    if (modeRef.current === "replay") return; // replay uses processReplay()
    if (queue.current.length === 0) {
      processing.current = false;
      syncQueueSize();

      if (mapViewRef.current === "3d" && flyModeRef.current !== "free") {
        idleSpin.current = true;
        map.current?.flyTo({
          center: [currentLng.current, 50],
          zoom: 0.8,
          duration: 1500,
          essential: true,
        });
      }
      return;
    }

    processing.current = true;
    idleSpin.current = false;
    const gen = replayGen.current; // capture generation — stale if clearQueue is called before timeout fires
    const event = queue.current.shift()!;
    syncQueueSize();
    setActiveEvent(event);

    const [lng, lat] = event;
    const eventId = event[3];

    // Mark item as active in display queue
    setDisplayQueue((prev) =>
      prev.map((item) =>
        item.id === eventId ? { ...item, active: true } : item,
      ),
    );

    if (map.current) {
      const isZoneMode = selectedZoneRef.current !== null;
      const isPolyMode = drawingStateRef.current === "complete" && polyVerticesRef.current.length >= 3;
      const is2D = mapViewRef.current === "2d";
      const isFreeMove = flyModeRef.current === "free";

      if (isZoneMode || isPolyMode || is2D || isFreeMove) {
        // No map navigation: blink immediately at event location
        showBlink(lng, lat, event[2]);
        setDisplayQueue((prev) =>
          prev.map((item) =>
            item.id === eventId ? { ...item, exiting: true, active: false } : item,
          ),
        );
        setTimeout(() => {
          if (gen !== replayGen.current) return; // stale: clearQueue was called, bail
          hideBlink();
          setActiveEvent(null);
          setDisplayQueue((prev) => prev.filter((item) => item.id !== eventId));
          requestAnimationFrame(() => processQueue());
        }, DISPLAY_DURATION / speed.current);
      } else {
        const onArrival = () => {
          map.current?.off("moveend", onArrival);
          if (gen !== replayGen.current) return; // stale: clearQueue was called, bail

          showBlink(lng, lat, event[2]);

          // Mark as exiting when blink starts
          setDisplayQueue((prev) =>
            prev.map((item) =>
              item.id === eventId ? { ...item, exiting: true, active: false } : item,
            ),
          );

          // Remove after exit animation completes
          setTimeout(() => {
            if (gen !== replayGen.current) return; // stale: clearQueue was called, bail
            hideBlink();
            setActiveEvent(null);
            setDisplayQueue((prev) => prev.filter((item) => item.id !== eventId));
            requestAnimationFrame(() => processQueue());
          }, DISPLAY_DURATION / speed.current);
        };

        // Adapt to distance: short = easeTo (no zoom arc), long = flyTo (gentle arc)
        const center = map.current.getCenter();
        const dist = Math.hypot(lng - center.lng, lat - center.lat);
        const duration = Math.min(8000, 2000 + dist * 60) / speed.current;

        map.current.once("moveend", onArrival);

        if (dist < 15) {
          // Short hop: smooth pan, no zoom change
          map.current.easeTo({
            center: [lng, lat],
            zoom: 6,
            duration,
            essential: true,
          });
        } else {
          // Long flight: gentle arc
          map.current.flyTo({
            center: [lng, lat],
            zoom: 6,
            duration,
            curve: 1,
            essential: true,
          });
        }
      }
    }
  }

  return (
    <div className="live-page">
      <div ref={mapContainer} className="live-map" />
      <div ref={blinkRef} className="live-blink-marker" style={{ display: "none" }} />
      <div ref={blinkLabelRef} className="live-blink-label" style={{ display: "none" }} />

      {/* Hand-drawn arrow hinting at the mode toggle */}
      <div className={`live-mode-hint${hintDismissed ? " dismissed" : ""}`} aria-hidden="true">
        <svg width="90" height="62" viewBox="0 0 90 62" fill="none">
          <path
            d="M 6,56 C 22,58 60,42 82,8"
            stroke="rgba(255,136,0,0.7)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M 82,8 L 68,14 M 82,8 L 78,24"
            stroke="rgba(255,136,0,0.7)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/* Mode toggles */}
      <div className="live-controls-row">
        <button className="live-home-btn" onClick={() => navigate("/")}>&#8592; Home</button>
        <div className="live-mode-toggle">
          <button
            className={`mode-btn${mode === "live" ? " active" : ""}`}
            onClick={mode === "live" ? undefined : () => { switchToLive(); setHintDismissed(true); }}
          >
            LIVE
          </button>
          <button
            className={`mode-btn${mode === "replay" && !todayMode ? " active" : ""}`}
            onClick={() => { switchToReplay(); setHintDismissed(true); }}
          >
            REPLAY
          </button>
          <button
            className={`mode-btn${mode === "replay" && todayMode ? " active" : ""}`}
            onClick={() => { switchToToday(); setHintDismissed(true); }}
          >
            TODAY
          </button>
        </div>
        <div className="live-mode-toggle">
          <button
            className={`mode-btn${mapView === "2d" ? " active" : ""}`}
            onClick={() => toggleMapView()}
          >
            2D
          </button>
          <button
            className={`mode-btn${mapView === "3d" ? " active" : ""}`}
            onClick={() => toggleMapView()}
          >
            3D
          </button>
        </div>
        <div className="live-mode-toggle">
          <button
            className={`mode-btn${flyMode === "auto" ? " active" : ""}`}
            onClick={() => toggleFlyMode()}
          >
            AUTO
          </button>
          <button
            className={`mode-btn${flyMode === "free" ? " active" : ""}`}
            onClick={() => toggleFlyMode()}
          >
            FREE
          </button>
        </div>
        <select
          className="live-event-select"
          value={liveEventType}
          onChange={(e) => changeEventType(e.target.value)}
        >
          {eventTypes.length === 0 && (
            <option value={LIVE_EVENT_TYPE}>{displayName(LIVE_EVENT_TYPE)}</option>
          )}
          {eventTypes.map((t) => (
            <option key={t.event_type} value={t.event_type}>
              {displayName(t.event_type)} ({t.count.toLocaleString()})
            </option>
          ))}
        </select>
      </div>

      {/* Live mode header */}
      {mode === "live" && (
        <div className="live-label">LIVE <span ref={countdownRef} className="live-countdown">{POLL_INTERVAL / 1000}s</span></div>
      )}

      {/* Replay controls */}
      {mode === "replay" && (
        <div className={`replay-controls${!pickerOpen ? " mini" : ""}`}>
          <div className="replay-tabs">
            <button
              className={`replay-tab${activeTab === "from" ? " active" : ""}`}
              onClick={() => { setActiveTab("from"); setPickerOpen(true); }}
            >
              From: {formatShort(replayFrom)}
            </button>
            <button
              className={`replay-tab${activeTab === "to" ? " active" : ""}`}
              onClick={() => { setActiveTab("to"); setPickerOpen(true); }}
            >
              To: {formatShort(replayTo)}
            </button>
          </div>
          {pickerOpen && (
          <div className="replay-picker-row">
            <div className="replay-calendar-wrap">
              <DatePicker
                inline
                selected={activeDate}
                onChange={(d: Date | null) => {
                  if (!d) return;
                  d.setHours(activeDate.getHours(), activeDate.getMinutes());
                  setActiveDate(d);
                }}
              />
            </div>
            <div className="time-scroller-group">
              <TimeScroller
                value={activeDate.getHours()}
                count={24}
                onChange={(h) => { const d = new Date(activeDate); d.setHours(h); setActiveDate(d); }}
              />
              <span className="time-scroller-sep">:</span>
              <TimeScroller
                value={activeDate.getMinutes()}
                count={60}
                onChange={(m) => { const d = new Date(activeDate); d.setMinutes(m); setActiveDate(d); }}
              />
            </div>
          </div>
          )}
          <button
            className="replay-btn"
            onClick={startReplay}
            disabled={replayLoading}
          >
            {replayLoading ? "Loading..." : "Load"}
          </button>
          <button
            className="replay-hide-btn"
            onClick={() => setPickerOpen((o) => !o)}
          >
            {pickerOpen ? "Hide" : "Change date"}
          </button>
          {replayInfo && <span className="replay-info">{replayInfo}</span>}
          <div className="replay-zone-selector" ref={zoneDropdownRef}>
            <button
              className="replay-zone-btn"
              onClick={() => setZoneDropdownOpen((o) => !o)}
            >
              <span className="replay-zone-btn-label">
                {selectedZone ? selectedZone.data.name : "No zone"}
              </span>
              {selectedZone && (
                <span
                  className="replay-zone-clear"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedZone(null);
                    selectedZoneRef.current = null;
                    setZoneTooltipPos(null);
                    updateUrl("replay");
                  }}
                >
                  ×
                </span>
              )}
            </button>
            {zoneDropdownOpen && (
              <div className="replay-zone-dropdown">
                <input
                  className="replay-zone-search"
                  type="text"
                  placeholder="Search zones…"
                  value={zoneSearch}
                  onChange={(e) => setZoneSearch(e.target.value)}
                  autoFocus
                />
                <div className="replay-zone-list">
                  <div
                    className={`replay-zone-item${!selectedZone ? " selected" : ""}`}
                    onClick={() => {
                      setSelectedZone(null);
                      selectedZoneRef.current = null;
                      setZoneTooltipPos(null);
                      setZoneDropdownOpen(false);
                      updateUrl("replay");
                    }}
                  >
                    No zone
                  </div>
                  {zones
                    .filter((z) => z.data.name.toLowerCase().includes(zoneSearch.toLowerCase()))
                    .map((z) => (
                      <div
                        key={z.data.id}
                        className={`replay-zone-item${selectedZone?.data.id === z.data.id ? " selected" : ""}`}
                        onClick={() => {
                          setSelectedZone(z);
                          selectedZoneRef.current = z;
                          setZoneDropdownOpen(false);
                          setZoneSearch("");
                          // Clear polygon (mutually exclusive)
                          setPolyVertices([]);
                          setDrawingState("idle");
                          updateUrl("replay");
                        }}
                      >
                        <span className="replay-zone-item-name">{z.data.name}</span>
                        {!z.data.is_active && (
                          <span className="replay-zone-item-badge">inactive</span>
                        )}
                      </div>
                    ))}
                  {zones.filter((z) =>
                    z.data.name.toLowerCase().includes(zoneSearch.toLowerCase()),
                  ).length === 0 && (
                    <div className="replay-zone-empty">No zones match</div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="replay-poly-toolbar">
            <PolygonToolbar
              drawingState={drawingState}
              vertexCount={polyVertices.length}
              onStartDraw={() => {
                setPolyVertices([]);
                setDrawingState("drawing");
                // Clear zone (mutually exclusive)
                setSelectedZone(null);
                selectedZoneRef.current = null;
                setZoneTooltipPos(null);
              }}
              onFinishDraw={() => {
                if (polyVertices.length >= 3) setDrawingState("complete");
              }}
              onClear={() => {
                setPolyVertices([]);
                setDrawingState("idle");
              }}
            />
          </div>
        </div>
      )}

      {/* Queue list above stats */}
      <div className="live-queue-list">
        {displayQueue.map((item) => (
          <div
            key={item.id}
            className={`live-queue-item${item.active ? " active" : ""}${item.exiting ? " exiting" : ""}`}
          >
            {item.flag && <span className="live-queue-flag">{item.flag}</span>}
            <span className="live-queue-label">{item.label}</span>
          </div>
        ))}
      </div>

      <div className="live-bottom-bar">
        <div className="live-stats">
          <span className="live-stats-count">
            {mode === "replay" && replayEvents.current.length > 0
              ? `${timelinePosition + 1} / ${replayEvents.current.length}`
              : `${queueSize} alarms`}
          </span>
          <span className="live-stats-text">
            {mode === "replay" && replayEvents.current.length > 0 ? "events" : "to display"}
          </span>
          <span className="live-speed-control">
            {SPEED_OPTIONS.map((s) => (
              <button
                key={s}
                className={`speed-btn${speedDisplay === s ? " active" : ""}`}
                onClick={() => { speed.current = s; setSpeedDisplay(s); }}
              >
                {s}x
              </button>
            ))}
          </span>
          {mode === "live" && (
            <span className="live-stats-added">+{lastAdded} queued in last cycle</span>
          )}
          {ghostText && <span className="live-stats-ghost" onAnimationEnd={() => { setGhostText(null); ghostAnimating.current = false; }}>{ghostText}</span>}
        </div>

        {/* Replay timeline */}
        {mode === "replay" && replayEvents.current.length > 0 && (
          <div className="replay-timeline-wrap">
            {/* Country tally — precomputed, binary-search lookup per country */}
            <div className="country-tally" onClick={() => setPinnedCountry(null)}>
              {countryTally.map(([cc, data]) => (
                <span
                  key={cc}
                  className={`country-tally-badge${pinnedCountry === cc ? " pinned" : ""}`}
                  onClick={(e) => { e.stopPropagation(); setPinnedCountry(pinnedCountry === cc ? null : cc); }}
                  onMouseEnter={() => { if (pinnedCountry && pinnedCountry !== cc) setPinnedCountry(cc); }}
                >
                  {data.flag} {data.count}
                  <div className="country-tally-tooltip" onMouseEnter={() => setPinnedCountry(cc)}>
                    <div className="ctt-header">{countryName(cc)}</div>
                    <div className="ctt-events">
                      {data.events.map((ev, j) => {
                        const d = new Date(ev.time * 1000);
                        return (
                          <div
                            key={j}
                            className="ctt-row ctt-row-clickable"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!replayPaused.current) { replayPaused.current = true; setPaused(true); }
                              onScrubChange(ev.idx);
                              setPinnedCountry(null);
                            }}
                          >
                            <span className="ctt-time">{d.getHours().toString().padStart(2, "0")}:{d.getMinutes().toString().padStart(2, "0")}:{d.getSeconds().toString().padStart(2, "0")}</span>
                            <span className="ctt-city">{ev.city}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </span>
              ))}
            </div>
            <div className="replay-timeline">
              <button className="timeline-pause-btn" onClick={togglePause}>
              {paused
                ? <svg width="12" height="14" viewBox="0 0 12 14"><path d="M1 0 L12 7 L1 14Z" fill="#ff8800" /></svg>
                : <svg width="10" height="14" viewBox="0 0 10 14"><rect x="0" y="0" width="3" height="14" fill="#ff8800" /><rect x="7" y="0" width="3" height="14" fill="#ff8800" /></svg>
              }
            </button>
            <span className="timeline-label">
              {formatTimelineTime(replayEvents.current[0][2])}
            </span>
            <div className="timeline-track-container">
              <canvas
                ref={densityCanvasRef}
                className="timeline-density"
                width={400}
                height={20}
              />
              <input
                type="range"
                className="timeline-slider"
                min={0}
                max={replayEvents.current.length - 1}
                value={timelinePosition}
                onMouseDown={onScrubStart}
                onTouchStart={onScrubStart}
                onInput={(e) => onScrubChange(parseInt((e.target as HTMLInputElement).value))}
                onMouseUp={onScrubEnd}
                onTouchEnd={onScrubEnd}
              />
              {scrubActive && (() => {
                const evt = replayEvents.current[timelinePosition];
                const d = evt ? new Date(evt[2] * 1000) : null;
                const label = d
                  ? `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")}.${d.getFullYear()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
                  : "";
                return (
                  <div
                    className="scrub-arrow"
                    style={{ left: `${(timelinePosition / Math.max(1, replayEvents.current.length - 1)) * 100}%` }}
                  >
                    <span className="scrub-arrow-label">{label}</span>
                    <svg width="14" height="20" viewBox="0 0 14 20">
                      <path d="M7 0 L7 14" stroke="#ff8800" strokeWidth="2" />
                      <path d="M2 10 L7 16 L12 10" stroke="#ff8800" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  </div>
                );
              })()}
            </div>
            <span className="timeline-label">
              {formatTimelineTime(replayEvents.current[replayEvents.current.length - 1][2])}
            </span>
            <span className="timeline-position">
              {timelinePosition + 1}/{replayEvents.current.length}
            </span>
            </div>
          </div>
        )}
      </div>
      {selectedZone && zoneTooltipPos && (
        <div
          className="zone-tooltip"
          style={{ right: '1rem', top: '4rem' }}
        >
          <div className="zone-tooltip-name">{selectedZone.data.name}</div>
          {selectedZone.data.pss_image?.s3_location && (
            <img
              className="zone-tooltip-img"
              src={s3Url(selectedZone.data.pss_image.s3_location)}
              alt={selectedZone.data.name}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          )}
          <div className="zone-tooltip-meta">
            {selectedZone.data.person?.person_account?.display_name && (
              <div className="zt-row"><span className="zt-label">Owner</span> {selectedZone.data.person.person_account.display_name}</div>
            )}
            {selectedZone.data.description && (
              <div className="zt-row"><span className="zt-label">Description</span> {selectedZone.data.description}</div>
            )}
            {selectedZone.data.about && (
              <div className="zt-row"><span className="zt-label">About</span> {selectedZone.data.about}</div>
            )}
            <div className="zt-row"><span className="zt-label">Members</span> {selectedZone.data.number_of_members}{selectedZone.data.max_number_of_members_allowed ? ` / ${selectedZone.data.max_number_of_members_allowed}` : ""}</div>
            <div className="zt-row"><span className="zt-label">Active</span> {selectedZone.data.is_active ? "Yes" : "No"}</div>
            <div className="zt-row"><span className="zt-label">Public</span> {selectedZone.data.is_public ? "Yes" : "No"}</div>
            <div className="zt-row"><span className="zt-label">Created</span> {new Date(selectedZone.data.created_at).toLocaleDateString()}</div>
            {selectedZone.data.valid_until && (
              <div className="zt-row"><span className="zt-label">Valid until</span> {new Date(selectedZone.data.valid_until).toLocaleDateString()}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
