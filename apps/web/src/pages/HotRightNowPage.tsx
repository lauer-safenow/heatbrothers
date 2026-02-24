import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { LineLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "deck.gl";
import { ZONE_EVENT_TYPE } from "@heatbrothers/shared";
import "./HotRightNowPage.css";

interface EventTypeInfo {
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

const DEFAULT_PRIVATE_TYPE = "DETAILED_ALARM_STARTED_PRIVATE_GROUP";

function isZoneType(t: string): boolean {
  return t.endsWith("_ZONE");
}

interface Hotspot {
  rank: number;
  lat: number;
  lng: number;
  degree: number;
  city: string;
  countryCode: string;
  timestamp: number;
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  nodes: [number, number][];
  edges: [number, number, number, number][];
  nearbyCities?: string[];
  zoneName?: string;
  zoneId?: string;
  zonePolygon?: number[][];
}

interface NewsArticle {
  title: string;
  url: string;
  source: string;
  dateTime: string;
  hot?: boolean;
}

interface HotspotResponse {
  from: string;
  to: string;
  totalAlarms: number;
  countDE: number;
  countDACH: number;
  countWorld: number;
  hotspotsDE: Hotspot[];
  hotspotsDACH: Hotspot[];
  hotspotsWorld: Hotspot[];
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

function replayUrl(h: Hotspot, from: string, to: string, etype: string): string {
  if (h.zoneId) {
    return `/live?mode=replay&from=${from}T00:00&to=${to}T23:59&zoneid=${h.zoneId}&fly=auto&etype=${encodeURIComponent(etype)}`;
  }
  const [minLng, minLat, maxLng, maxLat] = h.bbox;
  const poly = [
    minLng, minLat, maxLng, minLat,
    maxLng, maxLat, minLng, maxLat,
  ].map((n) => n.toFixed(4)).join(",");
  return `/live?mode=replay&from=${from}T00:00&to=${to}T23:59&poly=${poly}&fly=auto&etype=${encodeURIComponent(etype)}`;
}

export function HotRightNowPage() {
  const navigate = useNavigate();
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  const [data, setData] = useState<HotspotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Hotspot | null>(null);
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [safenowNews, setSafenowNews] = useState<NewsArticle[]>([]);
  const [safenowLoading, setSafenowLoading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [newsOpen, setNewsOpen] = useState(true);
  const [eventTypes, setEventTypes] = useState<EventTypeInfo[]>([]);
  const typeParam = searchParams.get("type");
  const isZoneMode = typeParam ? isZoneType(typeParam) : false;
  const alarmType = isZoneMode ? (typeParam || ZONE_EVENT_TYPE) : (typeParam || DEFAULT_PRIVATE_TYPE);

  // ── Draggable news panel divider ──
  const newsColRef = useRef<HTMLDivElement>(null);
  const [topPanelH, setTopPanelH] = useState("50%");
  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);

  const MIN_PANEL = 80; // px minimum for each panel

  const onDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const col = newsColRef.current;
    if (!col) return;
    const topPanel = col.querySelector(".hot-news-panel--top") as HTMLElement;
    if (!topPanel) return;
    dragStartY.current = e.clientY;
    dragStartH.current = topPanel.offsetHeight;
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const col = newsColRef.current;
      if (!col) return;
      const colH = col.offsetHeight - 6; // subtract divider height
      const delta = e.clientY - dragStartY.current;
      const newH = Math.max(MIN_PANEL, Math.min(colH - MIN_PANEL, dragStartH.current + delta));
      setTopPanelH(`${newH}px`);
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const SETTINGS_CONFIG = [
    { key: "lookbackDays", label: "lookback", unit: "d", default: 5,
      options: [1, 2, 3, 5, 7, 10, 14, 21, 30],
      tip: "How many days back to scan for alarm events" },
    { key: "epsKm", label: "eps", unit: "km", default: 3,
      options: [0.5, 1, 1.5, 2, 3, 5, 8, 10, 15, 20, 30, 50],
      tip: "Spatial radius — two alarms must be within this distance to be neighbors" },
    { key: "epsHours", label: "epsT", unit: "h", default: 2,
      options: [0.5, 1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 120],
      tip: "Temporal radius — two alarms must happen within this time of each other to be neighbors" },
    { key: "minPts", label: "minPts", unit: "", default: 3,
      options: [2, 3, 4, 5, 6, 8, 10, 15, 20],
      tip: "Minimum neighbors (incl. self) for a point to be a cluster core" },
    { key: "limit", label: "limit", unit: "", default: 10,
      options: [1, 2, 3, 5, 10, 15, 20],
      tip: "Maximum hotspots to show per region" },
  ] as const;

  // Read current values from URL (or defaults)
  const getVal = (key: string, def: number) => {
    const v = searchParams.get(key);
    return v != null ? parseFloat(v) : def;
  };
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(SETTINGS_CONFIG.map((s) => [s.key, getVal(s.key, s.default)])),
  );

  // Fetch available event types
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data: { byType: EventTypeInfo[] }) => setEventTypes(data.byType))
      .catch(() => {});
  }, []);

  // Fetch hotspot data from URL search params
  useEffect(() => {
    setLoading(true);
    setSelected(null);
    const qs = new URLSearchParams(searchParams);
    if (!qs.has("type")) qs.set("type", DEFAULT_PRIVATE_TYPE);
    fetch(`/api/hotspots?${qs.toString()}`)
      .then((r) => r.json())
      .then((d: HotspotResponse) => setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [searchParams]);

  const setAlarmType = (t: string) => {
    const next = new URLSearchParams(searchParams);
    if (t === DEFAULT_PRIVATE_TYPE) next.delete("type");
    else next.set("type", t);
    setSearchParams(next);
  };

  const applySettings = () => {
    const next = new URLSearchParams();
    if (alarmType !== DEFAULT_PRIVATE_TYPE) next.set("type", alarmType);
    for (const s of SETTINGS_CONFIG) {
      const v = draft[s.key];
      if (v !== s.default) next.set(s.key, String(v));
    }
    setEditing(false);
    setSearchParams(next);
  };

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [10, 30],
      zoom: 2,
      attributionControl: false,
    });

    const overlay = new MapboxOverlay({ layers: [] });
    map.addControl(overlay as unknown as maplibregl.IControl);
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    mapRef.current = map;
    overlayRef.current = overlay;

    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Update deck.gl layers when data changes
  useEffect(() => {
    const overlay = overlayRef.current;
    const map = mapRef.current;
    if (!overlay || !map || !data) return;

    const all = [...data.hotspotsWorld, ...data.hotspotsDACH, ...data.hotspotsDE];
    if (all.length === 0) return;

    const bboxToPolygon = (b: [number, number, number, number]) => [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]],
      [b[0], b[1]],
    ];

    // Determine color for selected hotspot
    const selNodes = selected ? selected.nodes : [];
    const selEdges = selected ? selected.edges : [];
    const isWorld = selected && data.hotspotsWorld.includes(selected);
    const isDach = selected && data.hotspotsDACH.includes(selected);
    const selColor: [number, number, number, number] = isWorld
      ? [255, 136, 0, 200]
      : isDach
        ? [68, 204, 119, 200]
        : [68, 153, 255, 200];
    const selEdgeColor: [number, number, number, number] = isWorld
      ? [255, 136, 0, 100]
      : isDach
        ? [68, 204, 119, 100]
        : [68, 153, 255, 100];

    overlay.setProps({
      layers: [
        // ── Edges + Nodes for selected hotspot only ──
        new LineLayer({
          id: "edges-selected",
          data: selEdges,
          getSourcePosition: (d) => [d[0], d[1]],
          getTargetPosition: (d) => [d[2], d[3]],
          getColor: selEdgeColor,
          getWidth: 1,
          widthMinPixels: 1,
        }),
        new ScatterplotLayer({
          id: "nodes-selected",
          data: selNodes,
          getPosition: (d) => d,
          getFillColor: selColor,
          getRadius: 150,
          radiusMinPixels: 2,
          radiusMaxPixels: 5,
        }),
        // ── Bounding boxes ──
        new PolygonLayer<Hotspot>({
          id: "bbox-world",
          data: data.hotspotsWorld,
          getPolygon: (d) => d.zonePolygon ? [...d.zonePolygon, d.zonePolygon[0]] : bboxToPolygon(d.bbox),
          getFillColor: [255, 136, 0, 15],
          getLineColor: [255, 136, 0, 120],
          lineWidthMinPixels: 1,
          stroked: true,
          filled: true,
        }),
        new PolygonLayer<Hotspot>({
          id: "bbox-dach",
          data: data.hotspotsDACH,
          getPolygon: (d) => d.zonePolygon ? [...d.zonePolygon, d.zonePolygon[0]] : bboxToPolygon(d.bbox),
          getFillColor: [68, 204, 119, 15],
          getLineColor: [68, 204, 119, 120],
          lineWidthMinPixels: 1,
          stroked: true,
          filled: true,
        }),
        new PolygonLayer<Hotspot>({
          id: "bbox-de",
          data: data.hotspotsDE,
          getPolygon: (d) => d.zonePolygon ? [...d.zonePolygon, d.zonePolygon[0]] : bboxToPolygon(d.bbox),
          getFillColor: [68, 153, 255, 15],
          getLineColor: [68, 153, 255, 120],
          lineWidthMinPixels: 1,
          stroked: true,
          filled: true,
        }),
        // ── Labels (top layer) ──
        new TextLayer<Hotspot>({
          id: "labels-world",
          data: data.hotspotsWorld,
          characterSet: "auto",
          getPosition: (d) => [d.lng, d.lat],
          getText: (d) => `#${d.rank} ${d.zoneName ?? d.city}`,
          getSize: 14,
          getColor: [255, 255, 255, 220],
          getPixelOffset: [0, -24],
          fontFamily: "Arial",
          fontWeight: "bold",
          outlineWidth: 3,
          outlineColor: [0, 0, 0, 200],
          billboard: true,
        }),
        new TextLayer<Hotspot>({
          id: "labels-dach",
          data: data.hotspotsDACH,
          characterSet: "auto",
          getPosition: (d) => [d.lng, d.lat],
          getText: (d) => `#${d.rank} ${d.zoneName ?? d.city}`,
          getSize: 14,
          getColor: [180, 255, 200, 220],
          getPixelOffset: [0, -24],
          fontFamily: "Arial",
          fontWeight: "bold",
          outlineWidth: 3,
          outlineColor: [0, 0, 0, 200],
          billboard: true,
        }),
        new TextLayer<Hotspot>({
          id: "labels-de",
          data: data.hotspotsDE,
          characterSet: "auto",
          getPosition: (d) => [d.lng, d.lat],
          getText: (d) => `#${d.rank} ${d.zoneName ?? d.city}`,
          getSize: 14,
          getColor: [180, 220, 255, 220],
          getPixelOffset: [0, -24],
          fontFamily: "Arial",
          fontWeight: "bold",
          outlineWidth: 3,
          outlineColor: [0, 0, 0, 200],
          billboard: true,
        }),
      ],
    });

  }, [data, selected]);

  // Fit bounds once on initial data load
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    const all = [...data.hotspotsWorld, ...data.hotspotsDACH, ...data.hotspotsDE];
    if (all.length === 0) return;
    if (all.length === 1) {
      map.flyTo({ center: [all[0].lng, all[0].lat], zoom: 8 });
    } else {
      const bounds = new maplibregl.LngLatBounds();
      for (const h of all) bounds.extend([h.lng, h.lat]);
      map.fitBounds(bounds, { padding: 60, maxZoom: 10 });
    }
  }, [data]);

  const flyTo = useCallback((h: Hotspot) => {
    setSelected((prev) => (prev === h ? null : h));
    const map = mapRef.current;
    if (!map) return;

    if (h.zonePolygon && h.zonePolygon.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const [lng, lat] of h.zonePolygon) bounds.extend([lng, lat]);
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 1200 });
    } else {
      const [minLng, minLat, maxLng, maxLat] = h.bbox;
      map.fitBounds([minLng, minLat, maxLng, maxLat], {
        padding: 60,
        maxZoom: 16,
        duration: 1200,
      });
    }
  }, []);

  // Fetch global SafeNow news once when hotspot data loads
  useEffect(() => {
    if (!data) return;
    setSafenowLoading(true);
    const qs = new URLSearchParams({ from: data.from, to: data.to });
    fetch(`/api/news/safenow?${qs}`)
      .then((r) => r.json())
      .then((d) => setSafenowNews(d.articles || []))
      .catch(() => setSafenowNews([]))
      .finally(() => setSafenowLoading(false));
  }, [data]);

  // Fetch regional news when a hotspot is selected
  useEffect(() => {
    if (!selected || !data) {
      setNews([]);
      return;
    }
    setNewsLoading(true);
    // Widen news window: start 2 days before the lookback
    const newsFrom = new Date(data.from);
    newsFrom.setDate(newsFrom.getDate() - 2);
    const qs = new URLSearchParams({
      country: selected.countryCode,
      from: newsFrom.toISOString().slice(0, 10),
      to: data.to,
    });
    if (isZoneMode && selected.zoneName) {
      // Zone mode: search only for the zone name
      qs.set("zone", selected.zoneName);
    } else {
      qs.set("city", selected.city);
      if (selected.zoneName) qs.set("zone", selected.zoneName);
      if (selected.nearbyCities?.length) qs.set("cities", selected.nearbyCities.join(","));
    }
    fetch(`/api/news?${qs}`)
      .then((r) => r.json())
      .then((d) => setNews(d.articles || []))
      .catch(() => setNews([]))
      .finally(() => setNewsLoading(false));
  }, [selected, data, isZoneMode]);

  return (
    <div className="hot-page">
      <div className="hot-header">
        <button className="hot-back-btn" onClick={() => navigate("/")}>
          &#8592; Home
        </button>
        <span className="hot-title">HOT RIGHT NOW</span>
        <div className="hot-type-toggle">
          <button
            className={`hot-type-btn${!isZoneMode ? " active" : ""}`}
            onClick={() => setAlarmType(DEFAULT_PRIVATE_TYPE)}
          >
            Private
          </button>
          <button
            className={`hot-type-btn${isZoneMode ? " active" : ""}`}
            onClick={() => setAlarmType(ZONE_EVENT_TYPE)}
          >
            Zone
          </button>
        </div>
        {eventTypes.length > 0 && (
          <select
            className="hot-type-select"
            value={alarmType}
            onChange={(e) => setAlarmType(e.target.value)}
          >
            {eventTypes
              .filter((t) => isZoneMode ? isZoneType(t.event_type) : !isZoneType(t.event_type))
              .map((t) => (
                <option key={t.event_type} value={t.event_type}>
                  {displayName(t.event_type)} ({t.count.toLocaleString()})
                </option>
              ))}
          </select>
        )}
        <span className="hot-subtitle">
          {data ? `${data.from} — ${data.to}` : "Loading..."}
        </span>
        <div className="hot-settings">
          {SETTINGS_CONFIG.map((s) => (
            <span key={s.key} className="hot-setting" onClick={() => setEditing(true)}>
              {editing ? (
                <>
                  {s.label}{" "}
                  <select
                    className="hot-setting-select"
                    value={draft[s.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [s.key]: parseFloat(e.target.value) }))}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {s.options.map((v) => (
                      <option key={v} value={v}>{v}{s.unit}</option>
                    ))}
                  </select>
                </>
              ) : (
                <>{s.label} <span className="hot-setting-val">{getVal(s.key, s.default)}{s.unit}</span></>
              )}
              <span className="hot-setting-tip">{s.tip}</span>
            </span>
          ))}
          {editing && (
            <>
              <button className="hot-settings-apply" onClick={applySettings}>Apply</button>
              <button className="hot-settings-cancel" onClick={() => { setEditing(false); setDraft(Object.fromEntries(SETTINGS_CONFIG.map((s) => [s.key, getVal(s.key, s.default)]))); }}>Cancel</button>
            </>
          )}
          <span className="hot-what">
            ?
            <div className="hot-what-popup">
              <strong>ST-DBSCAN</strong> (Spatiotemporal Density-Based Clustering)
              <br /><br />
              Scans the last <b>lookback</b> days of alarm events.
              Two alarms are "neighbors" if they are within <b>eps</b> km
              AND happened within <b>epsT</b> hours of each other.
              <br /><br />
              A cluster forms when a point has at least <b>minPts</b> neighbors.
              Clusters grow by chaining: if A{"\u2192"}B{"\u2192"}C are each pairwise
              neighbors, they all join the same cluster — even if A and C
              are far apart. Isolated events are filtered as noise.
              <br /><br />
              <em>Result: dense spatiotemporal bursts of alarms = hotspots.</em>
            </div>
          </span>
        </div>
      </div>

      <div className="hot-body">
        <div className="hot-left">
          <div className="hot-map-wrap">
            <div ref={mapContainer} className="hot-map-container" />
          </div>

          {data && (
            <div className="hot-meta">
              <span>
                Total alarms: <span className="hot-meta-val">{data.totalAlarms.toLocaleString()}</span>
              </span>
              <span>
                Germany: <span className="hot-meta-val">{data.countDE.toLocaleString()}</span>
              </span>
              <span>
                (D)ACH: <span className="hot-meta-val">{data.countDACH.toLocaleString()}</span>
              </span>
              <span>
                World: <span className="hot-meta-val">{data.countWorld.toLocaleString()}</span>
              </span>
            </div>
          )}

          {loading ? (
            <div className="hot-loading">Loading hotspot data...</div>
          ) : !data || (data.hotspotsWorld.length === 0 && data.hotspotsDACH.length === 0 && data.hotspotsDE.length === 0) ? (
            <div className="hot-empty">No hotspots found.</div>
          ) : (
            <div className="hot-lists">
              <div className="hot-list-col">
                <div className="hot-list-title hot-list-title--world">World</div>
                {data.hotspotsWorld.length === 0 ? (
                  <div className="hot-empty-col">No hotspots</div>
                ) : (
                  <div className="hot-list">
                    {data.hotspotsWorld.map((h) => (
                      <div key={h.rank} className="hot-card" onClick={() => flyTo(h)}>
                        <div className="hot-rank">{h.rank}</div>
                        <div className="hot-card-info">
                          <div className="hot-city">
                            {h.zoneName ?? <>{countryFlag(h.countryCode)} {h.city}</>}
                          </div>
                          <div className="hot-country">{h.zoneName ? h.city : h.countryCode}</div>
                        </div>
                        <div className="hot-degree">
                          {h.degree}
                          <span className="hot-degree-label">nearby events</span>
                        </div>
                        <a
                          className="hot-replay-link"
                          href={replayUrl(h, data.from, data.to, alarmType)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          replay
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="hot-list-col">
                <div className="hot-list-title hot-list-title--dach">(D)ACH</div>
                {data.hotspotsDACH.length === 0 ? (
                  <div className="hot-empty-col">No hotspots</div>
                ) : (
                  <div className="hot-list">
                    {data.hotspotsDACH.map((h) => (
                      <div key={h.rank} className="hot-card hot-card--dach" onClick={() => flyTo(h)}>
                        <div className="hot-rank hot-rank--dach">{h.rank}</div>
                        <div className="hot-card-info">
                          <div className="hot-city">
                            {h.zoneName ?? <>{countryFlag(h.countryCode)} {h.city}</>}
                          </div>
                          <div className="hot-country">{h.zoneName ? h.city : h.countryCode}</div>
                        </div>
                        <div className="hot-degree hot-degree--dach">
                          {h.degree}
                          <span className="hot-degree-label">nearby events</span>
                        </div>
                        <a
                          className="hot-replay-link hot-replay-link--dach"
                          href={replayUrl(h, data.from, data.to, alarmType)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          replay
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="hot-list-col">
                <div className="hot-list-title hot-list-title--de">Germany</div>
                {data.hotspotsDE.length === 0 ? (
                  <div className="hot-empty-col">No hotspots</div>
                ) : (
                  <div className="hot-list">
                    {data.hotspotsDE.map((h) => (
                      <div key={h.rank} className="hot-card hot-card--de" onClick={() => flyTo(h)}>
                        <div className="hot-rank hot-rank--de">{h.rank}</div>
                        <div className="hot-card-info">
                          <div className="hot-city">
                            {h.zoneName ?? <>{countryFlag(h.countryCode)} {h.city}</>}
                          </div>
                          <div className="hot-country">{h.zoneName ? h.city : h.countryCode}</div>
                        </div>
                        <div className="hot-degree hot-degree--de">
                          {h.degree}
                          <span className="hot-degree-label">nearby events</span>
                        </div>
                        <a
                          className="hot-replay-link hot-replay-link--de"
                          href={replayUrl(h, data.from, data.to, alarmType)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          replay
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          className="hot-news-toggle"
          onClick={() => setNewsOpen((o) => !o)}
          title={newsOpen ? "Hide news" : "Show news"}
        >
          {newsOpen ? "»" : "«"}
        </button>

        <div
          className={`hot-news-col${newsOpen ? "" : " hot-news-col--collapsed"}`}
          ref={newsColRef}
        >
          <div
            className="hot-news-panel hot-news-panel--top"
            style={{ height: topPanelH }}
          >
            <div className="hot-list-title hot-list-title--news">
              SafeNow News
            </div>
            {safenowLoading ? (
              <div className="hot-empty-col">Loading…</div>
            ) : safenowNews.length === 0 ? (
              <div className="hot-empty-col">No SafeNow news found</div>
            ) : (
              <div className="hot-list">
                {safenowNews.map((a, i) => (
                  <a
                    key={`sn-${i}`}
                    className="hot-card hot-card--news hot-card--safenow"
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <div className="hot-card-info">
                      <div className="hot-news-title">{a.title}</div>
                      <div className="hot-news-meta">
                        <span className="hot-news-source">{a.source}</span>
                        {a.dateTime && (
                          <span className="hot-news-date">
                            {new Date(a.dateTime).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>

          <div
            className={`hot-news-divider${dragging ? " hot-news-divider--active" : ""}`}
            onMouseDown={onDividerDown}
          />

          <div className="hot-news-panel hot-news-panel--bottom">
            <div className="hot-list-title hot-list-title--news">
              Regional News {selected && <span className="hot-news-city">{selected.zoneName ?? selected.city}</span>}
              {selected && (selected.zoneName || (selected.nearbyCities && selected.nearbyCities.length > 1)) && (
                <div className="hot-news-queried">
                  Queried: {[selected.zoneName, ...(selected.nearbyCities || [])].filter(Boolean).join(", ")}
                </div>
              )}
            </div>
            {!selected ? (
              <div className="hot-empty-col">Select a hotspot to see regional news</div>
            ) : newsLoading ? (
              <div className="hot-empty-col">Loading…</div>
            ) : news.length === 0 ? (
              <div className="hot-empty-col">No news found for {selected.city}</div>
            ) : (
              <div className="hot-list">
                {news.map((a, i) => (
                  <a
                    key={`rn-${i}`}
                    className={`hot-card hot-card--news${a.title.toLowerCase().includes("safenow") ? " hot-card--safenow" : ""}`}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <div className="hot-card-info">
                      <div className="hot-news-title">{a.title}</div>
                      <div className="hot-news-meta">
                        <span className="hot-news-source">{a.source}</span>
                        {a.dateTime && (
                          <span className="hot-news-date">
                            {new Date(a.dateTime).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
