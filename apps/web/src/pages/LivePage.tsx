import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import "../datepicker-dark.css";
import { LIVE_EVENT_TYPE } from "@heatbrothers/shared";
import { CITIES } from "../data/cities";
import "./LivePage.css";

type EventTuple = [number, number, number, number]; // [lng, lat, unixSeconds, id]

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

// Format Date → "YYYY-MM-DDTHH:MM" for URL params
function dateToParam(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Parse URL param string "YYYY-MM-DDTHH:MM" → Date (or null)
function paramToDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

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
  const mapContainer = useRef<HTMLDivElement>(null);
  const cityLabelRef = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const queue = useRef<EventTuple[]>([]);
  const processing = useRef(false);
  const lastSeenTs = useRef(0);
  const [activeEvent, setActiveEvent] = useState<EventTuple | null>(null);
  const [queueSize, setQueueSize] = useState(0);
  const [lastAdded, setLastAdded] = useState(0);
  const [ghostText, setGhostText] = useState<string | null>(null);
  const ghostAnimating = useRef(false);
  const countdownRef = useRef<HTMLSpanElement>(null);
  const [hintDismissed, setHintDismissed] = useState(false);

  // queue display list with city names
  const [displayQueue, setDisplayQueue] = useState<QueueItem[]>([]);
  const geocodeQueue = useRef<EventTuple[]>([]);
  const geocoding = useRef(false);

  // Cache: rounded "lat,lng" → { city, flag } to avoid duplicate Nominatim calls
  const geocodeCache = useRef<Map<string, { city: string; flag: string }>>(new Map());

  // blink overlay
  const blinkRef = useRef<HTMLDivElement>(null);
  const blinkLabelRef = useRef<HTMLDivElement>(null);
  const blinkLngLat = useRef<[number, number] | null>(null);

  // idle spin state
  const idleSpin = useRef(true);
  const raf = useRef(0);
  const currentLng = useRef(10);

  // URL params for shareable replay links
  const [searchParams, setSearchParams] = useSearchParams();
  const initMode = useRef((searchParams.get("mode") === "replay" ? "replay" : "live") as Mode);
  const initFrom = useRef(paramToDate(searchParams.get("from")) ?? new Date(Date.now() - 60 * 60 * 1000));
  const initTo = useRef(paramToDate(searchParams.get("to")) ?? new Date());
  const autoPlay = useRef(initMode.current === "replay" && !!searchParams.get("from") && !!searchParams.get("to"));

  // mode state
  const [mode, setMode] = useState<Mode>(initMode.current);
  const modeRef = useRef<Mode>(initMode.current);
  const [replayFrom, setReplayFrom] = useState<Date>(initFrom.current);
  const [replayTo, setReplayTo] = useState<Date>(initTo.current);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayInfo, setReplayInfo] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"from" | "to">("from");
  const [pickerOpen, setPickerOpen] = useState(true);

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
      setSearchParams({ mode: "replay", from: dateToParam(from || replayFrom), to: dateToParam(to || replayTo) }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
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

  // Reverse geocode events using Nominatim (1 req/s), with cache
  async function startGeocoding() {
    if (geocoding.current) return;
    geocoding.current = true;

    while (geocodeQueue.current.length > 0) {
      const event = geocodeQueue.current.shift()!;
      const [lng, lat, , id] = event;
      const cacheKey = `${lat.toFixed(1)},${lng.toFixed(1)}`;

      const cached = geocodeCache.current.get(cacheKey);
      if (cached) {
        setDisplayQueue((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, label: cached.city, flag: cached.flag } : item,
          ),
        );
        continue; // no delay needed — no network call
      }

      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&addressdetails=1`,
          { headers: { "Accept-Language": "en" } },
        );
        const data = await res.json();
        const addr = data.address || {};
        const city = addr.city || addr.town || addr.village || addr.county || addr.state || "Unknown";
        const cc = (addr.country_code || "").toUpperCase();
        const flag = countryFlag(cc);

        geocodeCache.current.set(cacheKey, { city, flag });

        setDisplayQueue((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, label: city, flag } : item,
          ),
        );
      } catch {
        // keep fallback coords label
      }

      await new Promise((r) => setTimeout(r, 1100));
    }

    geocoding.current = false;
  }

  function enqueueEvents(fresh: EventTuple[]) {
    fresh.sort((a, b) => a[2] - b[2]);
    queue.current.push(...fresh);
    syncQueueSize();

    const newItems: QueueItem[] = fresh.map((e) => ({
      id: e[3],
      lng: e[0],
      lat: e[1],
      label: `${e[1].toFixed(1)}°, ${e[0].toFixed(1)}°`,
      flag: "",
      exiting: false,
      active: false,
    }));
    setDisplayQueue((prev) => [...prev, ...newItems]);

    geocodeQueue.current.push(...fresh);
    startGeocoding();

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

    map.current.on("load", () => {
      map.current?.setProjection({ type: "globe" });

      // Hide city/place labels and sub-national boundary lines
      const style = map.current?.getStyle();
      if (style?.layers) {
        for (const layer of style.layers) {
          // hide all symbol layers except country labels
          if (layer.type === "symbol" && !layer.id.startsWith("place_country")) {
            map.current!.setLayoutProperty(layer.id, "visibility", "none");
          }
          // hide admin/state boundary lines (keep only country borders)
          if (layer.type === "line" && layer.id.includes("boundary") && !layer.id.includes("country")) {
            map.current!.setLayoutProperty(layer.id, "visibility", "none");
          }
        }
      }
    });

    map.current.on("move", updateBlinkPosition);

    // Position HTML city labels
    map.current.on("move", () => {
      const container = cityLabelRef.current;
      if (!container || !map.current) return;
      const z = map.current.getZoom();
      const children = container.children;
      for (let i = 0; i < CITIES.length; i++) {
        const el = children[i] as HTMLElement | undefined;
        if (!el) continue;
        const city = CITIES[i];
        if (z < city.minZoom) {
          el.style.display = "none";
          continue;
        }
        const pos = map.current.project(new maplibregl.LngLat(city.lng, city.lat));
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
        el.style.display = "";
      }
    });

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
    if (autoPlay.current) {
      autoPlay.current = false;
      startReplay();
    } else {
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
    };
  }, []);

  async function fetchNewEvents() {
    if (modeRef.current !== "live") return;
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(LIVE_EVENT_TYPE)}/since/${lastSeenTs.current}`,
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

  function clearQueue() {
    queue.current = [];
    processing.current = false;
    syncQueueSize();
    setDisplayQueue([]);
    setActiveEvent(null);
    hideBlink();
    geocodeQueue.current = [];
  }

  function switchToReplay() {
    modeRef.current = "replay";
    setMode("replay");
    clearQueue();
    idleSpin.current = true;
    setReplayInfo(null);
    setLastAdded(0);
    setGhostText(null);
    updateUrl("replay");
  }

  function switchToLive() {
    modeRef.current = "live";
    setMode("live");
    clearQueue();
    idleSpin.current = true;
    setReplayInfo(null);
    updateUrl("live");
    // Resume live: last 10 minutes
    lastSeenTs.current = Math.floor(Date.now() / 1000) - 10 * 60;
    if (countdownRef.current) countdownRef.current.textContent = `${POLL_INTERVAL / 1000}s`;
    fetchNewEvents();
  }

  async function startReplay() {
    const fromEpoch = Math.floor(replayFrom.getTime() / 1000);
    const toEpoch = Math.floor(replayTo.getTime() / 1000);
    if (isNaN(fromEpoch) || isNaN(toEpoch) || fromEpoch >= toEpoch) {
      setReplayInfo("Invalid time range");
      return;
    }

    clearQueue();
    setReplayLoading(true);
    setReplayInfo(null);
    updateUrl("replay", replayFrom, replayTo);

    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(LIVE_EVENT_TYPE)}/between/${fromEpoch}/${toEpoch}`,
      );
      if (!res.ok) { setReplayInfo("Fetch failed"); return; }
      const data = await res.json();
      const events: EventTuple[] = data.events;

      const info = data.capped
        ? `${data.count.toLocaleString()} of ${data.total.toLocaleString()} events (capped)`
        : `${data.count.toLocaleString()} events`;
      setReplayInfo(info);

      if (events.length === 0) return;

      idleSpin.current = false;
      enqueueEvents(events);
    } catch (err) {
      console.error("[replay] fetch error:", err);
      setReplayInfo("Fetch error");
    } finally {
      setReplayLoading(false);
    }
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

  function processQueue() {
    if (queue.current.length === 0) {
      processing.current = false;
      idleSpin.current = true;
      syncQueueSize();

      if (map.current) {
        map.current.flyTo({
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
      const onArrival = () => {
        map.current?.off("moveend", onArrival);

        showBlink(lng, lat, event[2]);

        // Mark as exiting when blink starts
        setDisplayQueue((prev) =>
          prev.map((item) =>
            item.id === eventId ? { ...item, exiting: true, active: false } : item,
          ),
        );

        // Remove after exit animation completes
        setTimeout(() => {
          hideBlink();
          setActiveEvent(null);
          setDisplayQueue((prev) => prev.filter((item) => item.id !== eventId));
          requestAnimationFrame(() => processQueue());
        }, DISPLAY_DURATION);
      };

      // Adapt to distance: short = easeTo (no zoom arc), long = flyTo (gentle arc)
      const center = map.current.getCenter();
      const dist = Math.hypot(lng - center.lng, lat - center.lat);
      const duration = Math.min(8000, 2000 + dist * 60); // 2s–8s based on distance

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

  return (
    <div className="live-page">
      <div ref={mapContainer} className="live-map" />
      <div ref={cityLabelRef} className="city-label-container">
        {CITIES.map((c) => (
          <div key={c.name} className="city-html-label">
            {c.name}
          </div>
        ))}
      </div>
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

      {/* Mode toggle */}
      <div className="live-mode-toggle">
        <button
          className={`mode-btn${mode === "live" ? " active" : ""}`}
          onClick={mode === "live" ? undefined : () => { switchToLive(); setHintDismissed(true); }}
        >
          LIVE
        </button>
        <button
          className={`mode-btn${mode === "replay" ? " active" : ""}`}
          onClick={mode === "replay" ? undefined : () => { switchToReplay(); setHintDismissed(true); }}
        >
          REPLAY
        </button>
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
            {replayLoading ? "Loading..." : "Play"}
          </button>
          <button
            className="replay-hide-btn"
            onClick={() => setPickerOpen((o) => !o)}
          >
            {pickerOpen ? "Hide" : "Change date"}
          </button>
          {replayInfo && <span className="replay-info">{replayInfo}</span>}
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

      <div className="live-stats">
        <span className="live-stats-count">{queueSize} alarms</span>
        <span className="live-stats-text">to display</span>
        {mode === "live" && (
          <span className="live-stats-added">+{lastAdded} queued in last cycle</span>
        )}
        {ghostText && <span className="live-stats-ghost" onAnimationEnd={() => { setGhostText(null); ghostAnimating.current = false; }}>{ghostText}</span>}
      </div>
      {activeEvent && (
        <div className="live-event-info">
          {activeEvent[1].toFixed(2)}, {activeEvent[0].toFixed(2)}
        </div>
      )}
    </div>
  );
}
