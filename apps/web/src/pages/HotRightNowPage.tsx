import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { LineLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "deck.gl";
import "./HotRightNowPage.css";

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

function replayUrl(h: Hotspot, from: string, to: string): string {
  const [minLng, minLat, maxLng, maxLat] = h.bbox;
  const poly = [
    minLng, minLat, maxLng, minLat,
    maxLng, maxLat, minLng, maxLat,
  ].map((n) => n.toFixed(4)).join(",");
  return `/live?mode=replay&from=${from}T00:00&to=${to}T23:59&poly=${poly}&fly=free`;
}

export function HotRightNowPage() {
  const navigate = useNavigate();
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  const [data, setData] = useState<HotspotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Hotspot | null>(null);

  // Fetch hotspot data
  useEffect(() => {
    setLoading(true);
    fetch("/api/hotspots")
      .then((r) => r.json())
      .then((d: HotspotResponse) => setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

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
          getPolygon: (d) => bboxToPolygon(d.bbox),
          getFillColor: [255, 136, 0, 15],
          getLineColor: [255, 136, 0, 120],
          lineWidthMinPixels: 1,
          stroked: true,
          filled: true,
        }),
        new PolygonLayer<Hotspot>({
          id: "bbox-dach",
          data: data.hotspotsDACH,
          getPolygon: (d) => bboxToPolygon(d.bbox),
          getFillColor: [68, 204, 119, 15],
          getLineColor: [68, 204, 119, 120],
          lineWidthMinPixels: 1,
          stroked: true,
          filled: true,
        }),
        new PolygonLayer<Hotspot>({
          id: "bbox-de",
          data: data.hotspotsDE,
          getPolygon: (d) => bboxToPolygon(d.bbox),
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
          getText: (d) => `#${d.rank} ${d.city}`,
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
          getText: (d) => `#${d.rank} ${d.city}`,
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
          getText: (d) => `#${d.rank} ${d.city}`,
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
    mapRef.current?.flyTo({ center: [h.lng, h.lat], zoom: 10, duration: 1200 });
  }, []);

  return (
    <div className="hot-page">
      <div className="hot-header">
        <button className="hot-back-btn" onClick={() => navigate("/")}>
          Back
        </button>
        <span className="hot-title">HOT RIGHT NOW</span>
        <span className="hot-subtitle">
          {data ? `${data.from} — ${data.to}` : "Loading..."}
        </span>
      </div>

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
                        {countryFlag(h.countryCode)} {h.city}
                      </div>
                      <div className="hot-country">{h.countryCode}</div>
                    </div>
                    <div className="hot-degree">
                      {h.degree}
                      <span className="hot-degree-label">nearby alarms</span>
                    </div>
                    <a
                      className="hot-replay-link"
                      href={replayUrl(h, data.from, data.to)}
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
                        {countryFlag(h.countryCode)} {h.city}
                      </div>
                      <div className="hot-country">{h.countryCode}</div>
                    </div>
                    <div className="hot-degree hot-degree--dach">
                      {h.degree}
                      <span className="hot-degree-label">nearby alarms</span>
                    </div>
                    <a
                      className="hot-replay-link hot-replay-link--dach"
                      href={replayUrl(h, data.from, data.to)}
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
                        {countryFlag(h.countryCode)} {h.city}
                      </div>
                      <div className="hot-country">{h.countryCode}</div>
                    </div>
                    <div className="hot-degree hot-degree--de">
                      {h.degree}
                      <span className="hot-degree-label">nearby alarms</span>
                    </div>
                    <a
                      className="hot-replay-link hot-replay-link--de"
                      href={replayUrl(h, data.from, data.to)}
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
  );
}
