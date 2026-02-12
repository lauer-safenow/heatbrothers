import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { HeatmapLayer, PolygonLayer, PathLayer, ScatterplotLayer, type Layer } from "deck.gl";
import { pointInPolygon } from "../utils/pointInPolygon";
import { PolygonToolbar } from "../components/PolygonToolbar";
import { TimeHistogram } from "../components/TimeHistogram";
import "./MapPage.css";

type EventTuple = [number, number, number]; // [lng, lat, unixSeconds]
type LngLat = [number, number];
type DrawingState = "idle" | "drawing" | "complete";

interface EventType {
  event_type: string;
  count: number;
}

const DISPLAY_NAMES: Record<string, string> = {
  DETAILED_ALARM_STARTED_PRIVATE_GROUP: "Alarm started private",
  app_opening_ZONE: "App opening zone",
  FIRST_TIME_PHONE_STATUS_SENT: "Installs",
  DETAILED_ALARM_STARTED_ZONE: "Alarm started zone",
};

function displayName(eventType: string): string {
  return DISPLAY_NAMES[eventType] ?? eventType;
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

  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [selected, setSelected] = useState("");
  const [allEvents, setAllEvents] = useState<EventTuple[]>([]);
  const [loading, setLoading] = useState(false);

  // polygon drawing
  const [drawingState, setDrawingState] = useState<DrawingState>("idle");
  const [vertices, setVertices] = useState<LngLat[]>([]);

  // zoom tracking for adaptive heatmap params
  const [zoom, setZoom] = useState(5.5);

  // time filter
  const [timeFrom, setTimeFrom] = useState("");
  const [timeUntil, setTimeUntil] = useState("");

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

  // ---------- filtering pipeline ----------
  const filteredEvents = useMemo(() => {
    let events = allEvents;

    // time filter
    if (timeFrom) {
      const fromTs = Math.floor(new Date(timeFrom).getTime() / 1000);
      events = events.filter((e) => e[2] >= fromTs);
    }
    if (timeUntil) {
      const untilTs =
        Math.floor(new Date(timeUntil).getTime() / 1000) + 86400;
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
        if (data.byType.length > 0) setSelected(data.byType[0].event_type);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    fetch(`/api/events/${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((data: { events: EventTuple[] }) => setAllEvents(data.events))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selected]);

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

    map.current.on("moveend", () => {
      const z = map.current?.getZoom();
      if (z !== undefined) setZoom(z);
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

    overlay.current.setProps({ layers });
  }, [filteredEvents, drawingState, vertices, zoom]);

  // resize map after mount (bottom panel reduces available space)
  useEffect(() => {
    const t = setTimeout(() => map.current?.resize(), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="map-page">
      <div className="map-section">
        <div ref={mapContainer} className="map-container" />

        <div className="map-controls">
          <select
            className="event-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {eventTypes.map((t) => (
              <option key={t.event_type} value={t.event_type}>
                {displayName(t.event_type)} ({t.count.toLocaleString()})
              </option>
            ))}
          </select>
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
          {loading && <span className="loading-badge">Loading...</span>}
        </div>

        <div className="event-count-badge">
          {filteredEvents.length.toLocaleString()} events
        </div>

        <div className="bottom-toolbar">
          <PolygonToolbar
            drawingState={drawingState}
            vertexCount={vertices.length}
            filteredCount={filteredEvents.length}
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
              <input
                type="date"
                value={timeFrom}
                onChange={(e) => setTimeFrom(e.target.value)}
              />
            </label>
            <label>
              Until
              <input
                type="date"
                value={timeUntil}
                onChange={(e) => setTimeUntil(e.target.value)}
              />
            </label>
            {(timeFrom || timeUntil) && (
              <button
                className="time-reset-btn"
                onClick={() => {
                  setTimeFrom("");
                  setTimeUntil("");
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {drawingState === "complete" && (
        <div className="bottom-panel">
          <TimeHistogram
            events={allEvents}
            filteredEvents={filteredEvents}
            onClose={() => {
              setVertices([]);
              setDrawingState("idle");
            }}
          />
        </div>
      )}
    </div>
  );
}
