import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { HeatmapLayer } from "deck.gl";
import "./MapPage.css";

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

export function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);

  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [heatData, setHeatData] = useState<[number, number, number][]>([]);
  const [loading, setLoading] = useState(false);

  // fetch available event types
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data: { byType: EventType[] }) => {
        setEventTypes(data.byType);
        if (data.byType.length > 0) {
          setSelected(data.byType[0].event_type);
        }
      })
      .catch(() => {});
  }, []);

  // fetch events when selected type changes
  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    fetch(`/api/events/${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((data: { events: [number, number, number][] }) => {
        setHeatData(data.events);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selected]);

  // init map
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

    return () => {
      map.current?.remove();
      map.current = null;
      overlay.current = null;
    };
  }, []);

  // update heatmap layer when data changes
  useEffect(() => {
    if (!overlay.current) return;

    overlay.current.setProps({
      layers: [
        new HeatmapLayer({
          id: "heatmap",
          data: heatData,
          getPosition: (d: [number, number, number]) => [d[0], d[1]],
          getWeight: (d: [number, number, number]) => d[2],
          radiusPixels: 30,
          intensity: 1,
          threshold: 0.05,
        }),
      ],
    });
  }, [heatData]);

  return (
    <>
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
        {loading && <span className="loading-badge">Loading...</span>}
      </div>
    </>
  );
}
