import { useEffect, useRef, useState, useCallback } from "react";
import type maplibregl from "maplibre-gl";
import { UserAvatar } from "./UserAvatar";
import { getAvatarImage } from "./miniAvatarCache";
import "./EventTrail.css";

type EventTuple = [number, number, number, number, string, string, string]; // [lng, lat, ts, id, city, cc, distinctId]

interface EventTrailProps {
  map: maplibregl.Map | null;
  events: EventTuple[];
}

interface AuditEntry {
  type: string;
  displayName: string;
  timestamp: number;
  city: string;
  countryCode: string;
  pssName?: string;
  alarmSource?: string;
  eventSource?: string;
}

function eventColor(type: string): string {
  if (type === "FIRST_TIME_PHONE_STATUS_SENT") return "#4a9eff";
  if (type === "DETAILED_ALARM_STARTED_PRIVATE_GROUP") return "#ff5a5a";
  if (type === "DETAILED_ALARM_STARTED_ZONE") return "#cc2222";
  if (type.includes("CANCEL")) return "#999";
  if (type === "app_opening_ZONE") return "#4caf50";
  if (type.includes("ATTENTION")) return "#fa8072";
  return "rgba(255,255,255,0.75)";
}

function countryFlag(cc: string): string {
  if (!cc || cc.length !== 2) return "";
  return String.fromCodePoint(
    ...cc.toUpperCase().split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")}.${d.getFullYear()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

const HIT_RADIUS = 20; // px — sized for mini avatars
const AVATAR_W = 20; // px width for normal avatars
const AVATAR_H = 26; // portrait height (1.3x)
const AVATAR_W_HOVERED = 44;
const AVATAR_H_HOVERED = 57;
const AVATAR_W_SAME_USER = 32;
const AVATAR_H_SAME_USER = 42;
const LEAVE_DELAY = 300; // ms grace period to move from dot to card

export function EventTrail({ map, events }: EventTrailProps) {
  const positionsRef = useRef<{ x: number; y: number }[]>([]);
  const [, forceRender] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [hoveredCluster, setHoveredCluster] = useState<number[]>([]); // all indices at same spot
  const [lockedCluster, setLockedCluster] = useState<number[]>([]); // cluster preserved on click
  const [clusterOffset, setClusterOffset] = useState(0); // which one in the cluster is active
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const auditCache = useRef<Map<string, AuditEntry[]>>(new Map());
  const cardRef = useRef<HTMLDivElement>(null);
  const mouseOnCard = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When card is "pinned" (mouse is on card), freeze the hovered index so it doesn't change
  const [pinnedIdx, setPinnedIdx] = useState<number | null>(null);
  // When card is "locked" (user clicked a dot), it stays until click-away or Escape
  const [lockedIdx, setLockedIdx] = useState<number | null>(null);
  const [lockedPos, setLockedPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [cardVisible, setCardVisible] = useState(false);
  const [showCopied, setShowCopied] = useState(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Use locked cluster when card is locked, otherwise hovered cluster
  const activeCluster = lockedIdx !== null ? lockedCluster : hoveredCluster;

  // When navigating a cluster, use the offset to pick the active index
  const baseIdx = lockedIdx ?? pinnedIdx ?? hoveredIdx;
  const activeIdx = activeCluster.length > 1 && clusterOffset < activeCluster.length
    ? activeCluster[clusterOffset]
    : baseIdx;

  const dotsCanvasRef = useRef<HTMLCanvasElement>(null);

  const updatePositions = useCallback(() => {
    if (!map || eventsRef.current.length === 0) {
      positionsRef.current = [];
      forceRender((n) => n + 1);
      return;
    }
    const newPos = eventsRef.current.map((e) => {
      const pt = map.project([e[0], e[1]]);
      return { x: pt.x, y: pt.y };
    });
    positionsRef.current = newPos;
    forceRender((n) => n + 1);
  }, [map]);

  // Recalculate positions when events change
  useEffect(() => {
    updatePositions();
  }, [events, updatePositions]);

  // Recalculate on map move
  useEffect(() => {
    if (!map) return;
    map.on("move", updatePositions);
    return () => { map.off("move", updatePositions); };
  }, [map, updatePositions]);

  // Listen to native mousemove on the map canvas — doesn't block map interactions
  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvas();

    function hitTest(e: MouseEvent): number | null {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const positions = positionsRef.current;
      const evts = eventsRef.current;
      // Geographic bounds to ignore world-wrap ghost dots
      const bounds = map!.getBounds();
      const lngPad = (bounds.getEast() - bounds.getWest()) * 0.1;
      const latPad = (bounds.getNorth() - bounds.getSouth()) * 0.1;
      const minLng = bounds.getWest() - lngPad;
      const maxLng = bounds.getEast() + lngPad;
      const minLat = bounds.getSouth() - latPad;
      const maxLat = bounds.getNorth() + latPad;

      let bestIdx: number | null = null;
      let bestDist = HIT_RADIUS * HIT_RADIUS;
      for (let i = positions.length - 1; i >= 0; i--) {
        const eLng = evts[i]?.[0];
        const eLat = evts[i]?.[1];
        if (eLng < minLng || eLng > maxLng || eLat < minLat || eLat > maxLat) continue;
        const dx = positions[i].x - mx;
        const dy = positions[i].y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
      }
      return bestIdx;
    }

    // Find events at the exact same lat/lng from different users (distinct_id)
    function geoCluster(idx: number): number[] {
      const ev = eventsRef.current;
      const lng = ev[idx][0];
      const lat = ev[idx][1];
      const seen = new Set<string>();
      const cluster: number[] = [];
      for (let i = 0; i < ev.length; i++) {
        if (ev[i][0] === lng && ev[i][1] === lat) {
          const did = ev[i][6];
          if (!seen.has(did)) {
            seen.add(did);
            cluster.push(i);
          }
        }
      }
      return cluster;
    }

    let prevPrimaryHit: number | null = null;

    function onMove(e: MouseEvent) {
      if (mouseOnCard.current) return;

      setMousePos({ x: e.clientX, y: e.clientY });
      const idx = hitTest(e);

      if (idx !== prevPrimaryHit) {
        prevPrimaryHit = idx;
        setHoveredIdx(idx);
        if (idx !== null) {
          setHoveredCluster(geoCluster(idx));
        } else {
          setHoveredCluster([]);
        }
        setClusterOffset(0);
      }
      setPinnedIdx(null);
    }

    function onClick(e: MouseEvent) {
      const idx = hitTest(e);
      if (idx !== null) {
        const cluster = geoCluster(idx);
        setLockedIdx(idx);
        setLockedCluster(cluster);
        setHoveredCluster(cluster);
        setClusterOffset(0);
        setLockedPos({ x: e.clientX, y: e.clientY });
      } else {
        setLockedIdx(null);
        setLockedCluster([]);
      }
    }

    function onLeave() {
      if (mouseOnCard.current) return;
      // Delay clearing so user can move to card
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      leaveTimer.current = setTimeout(() => {
        if (!mouseOnCard.current) {
          setHoveredIdx(null);
          setPinnedIdx(null);
        }
      }, LEAVE_DELAY);
    }

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    };
  }, [map]);

  // Escape key dismisses locked card
  useEffect(() => {
    if (lockedIdx === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLockedIdx(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lockedIdx]);

  // Card mouse enter/leave handlers
  const onCardEnter = useCallback(() => {
    mouseOnCard.current = true;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    // Pin the current hover so it doesn't get cleared
    setPinnedIdx((prev) => prev ?? hoveredIdx);
  }, [hoveredIdx]);

  const onCardLeave = useCallback(() => {
    mouseOnCard.current = false;
    setPinnedIdx(null);
    setHoveredIdx(null);
  }, []);

  // Fetch audit trail when active event changes
  useEffect(() => {
    if (activeIdx === null) {
      setAudit(null);
      return;
    }
    const event = events[activeIdx];
    if (!event) return;
    const distinctId = event[6];

    const cached = auditCache.current.get(distinctId);
    if (cached) {
      setAudit(cached);
      return;
    }

    setAuditLoading(true);
    setAudit(null);
    fetch(`/api/events/user/${encodeURIComponent(distinctId)}`)
      .then((r) => r.json())
      .then((data: { events: AuditEntry[] }) => {
        auditCache.current.set(distinctId, data.events);
        setAudit(data.events);
      })
      .catch(() => setAudit(null))
      .finally(() => setAuditLoading(false));
  }, [activeIdx, events]);

  // Morph animation: reset on activeIdx change
  useEffect(() => {
    setCardVisible(false);
    setShowCopied(false);
    if (activeIdx !== null) {
      requestAnimationFrame(() => setCardVisible(true));
    }
  }, [activeIdx]);

  const positions = positionsRef.current.slice(0, events.length);
  const hoveredEvent = activeIdx !== null ? events[activeIdx] : null;
  const hoveredDistinctId = hoveredEvent ? hoveredEvent[6] : null;

  // Draw dots on canvas for performance (thousands of dots)
  useEffect(() => {
    const cvs = dotsCanvasRef.current;
    const mapCanvas = map?.getCanvas();
    if (!cvs || !mapCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = mapCanvas.clientWidth;
    const h = mapCanvas.clientHeight;
    cvs.width = w * dpr;
    cvs.height = h * dpr;
    cvs.style.width = `${w}px`;
    cvs.style.height = `${h}px`;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const pad = 50;
    const pos = positionsRef.current;
    const evts = eventsRef.current;
    const hDid = hoveredDistinctId;

    // Geographic bounds filter to prevent world-wrap ghost dots
    const bounds = map!.getBounds();
    const lngPad = (bounds.getEast() - bounds.getWest()) * 0.1;
    const latPad = (bounds.getNorth() - bounds.getSouth()) * 0.1;
    const minLng = bounds.getWest() - lngPad;
    const maxLng = bounds.getEast() + lngPad;
    const minLat = bounds.getSouth() - latPad;
    const maxLat = bounds.getNorth() + latPad;

    let hasUnloaded = false;

    // Helper: rounded rectangle path for portrait clipping
    function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    // First pass: draw normal + same-user avatars (skip hovered)
    for (let i = 0; i < pos.length && i < evts.length; i++) {
      const eLng = evts[i][0];
      const eLat = evts[i][1];
      if (eLng < minLng || eLng > maxLng || eLat < minLat || eLat > maxLat) continue;

      const { x, y } = pos[i];
      if (x < -pad || x > w + pad || y < -pad || y > h + pad) continue;
      if (i === activeIdx) continue; // draw hovered on top in second pass

      const isSameUser = hDid !== null && evts[i]?.[6] === hDid;
      const did = evts[i][6];
      const cc = evts[i][5];
      const img = getAvatarImage(did, cc);

      const aw = isSameUser ? AVATAR_W_SAME_USER : AVATAR_W;
      const ah = isSameUser ? AVATAR_H_SAME_USER : AVATAR_H;

      if (img) {
        ctx.save();
        if (isSameUser) {
          ctx.shadowColor = "rgba(255, 140, 0, 0.7)";
          ctx.shadowBlur = 8;
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = 0.85;
        }
        roundedRect(ctx, x - aw / 2, y - ah / 2, aw, ah, aw * 0.2);
        ctx.clip();
        ctx.drawImage(img, x - aw / 2, y - ah / 2, aw, ah);
        ctx.restore();
      } else {
        hasUnloaded = true;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = "rgba(255, 140, 0, 1)";
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Second pass: draw hovered avatar on top
    if (activeIdx !== null && activeIdx < pos.length && activeIdx < evts.length) {
      const eLng = evts[activeIdx][0];
      const eLat = evts[activeIdx][1];
      const inBounds = eLng >= minLng && eLng <= maxLng && eLat >= minLat && eLat <= maxLat;
      if (inBounds) {
        const { x, y } = pos[activeIdx];
        const did = evts[activeIdx][6];
        const cc = evts[activeIdx][5];
        const img = getAvatarImage(did, cc);
        if (img) {
          ctx.save();
          ctx.shadowColor = "rgba(255, 140, 0, 0.9)";
          ctx.shadowBlur = 12;
          ctx.globalAlpha = 1;
          roundedRect(ctx, x - AVATAR_W_HOVERED / 2, y - AVATAR_H_HOVERED / 2, AVATAR_W_HOVERED, AVATAR_H_HOVERED, AVATAR_W_HOVERED * 0.2);
          ctx.clip();
          ctx.drawImage(img, x - AVATAR_W_HOVERED / 2, y - AVATAR_H_HOVERED / 2, AVATAR_W_HOVERED, AVATAR_H_HOVERED);
          ctx.restore();
        }
      }
    }
    ctx.globalAlpha = 1;

    // Re-render once images finish loading
    if (hasUnloaded) {
      setTimeout(() => forceRender((n) => n + 1), 100);
    }
  });

  if (positions.length === 0) return null;

  return (
    <div className="event-trail-container">
      <canvas ref={dotsCanvasRef} className="event-trail-canvas" />

      {hoveredEvent && (
        <div
          ref={cardRef}
          className={`event-trail-card ${cardVisible ? "event-trail-card-visible" : "event-trail-card-entering"}`}
          onMouseEnter={onCardEnter}
          onMouseLeave={onCardLeave}
          style={(() => {
            const pad = 12;
            const offsetX = 16;
            const offsetY = 12;
            const card = cardRef.current;
            const cw = card?.offsetWidth ?? 280;
            const ch = card?.offsetHeight ?? 300;
            const vw = window.innerWidth;
            const vh = window.innerHeight;

            // Anchor to avatar's projected map position
            const avatarPos = activeIdx !== null ? positionsRef.current[activeIdx] : null;
            const mapCanvas = map?.getCanvas();
            const rect = mapCanvas?.getBoundingClientRect();
            const anchor = avatarPos && rect
              ? { x: rect.left + avatarPos.x, y: rect.top + avatarPos.y }
              : lockedIdx !== null ? lockedPos : mousePos;
            let x = anchor.x + offsetX;
            let y = anchor.y - offsetY;

            // Flip horizontally if overflowing right
            if (x + cw + pad > vw) x = anchor.x - cw - offsetX;
            // Flip vertically if overflowing bottom (account for timeline bar)
            const bottomPad = 90;
            if (y + ch + bottomPad > vh) y = vh - ch - bottomPad;
            // Clamp to top
            if (y < pad) y = pad;

            return { left: x, top: y };
          })()}
        >
          <div className="event-trail-card-body">
            <div className="event-trail-card-header">
              <UserAvatar distinctId={hoveredEvent[6]} size={48} countryCode={hoveredEvent[5]} />
              <span>from {hoveredEvent[4] || "Unknown"} {countryFlag(hoveredEvent[5])}
              {audit ? ` has ${audit.length} events` : ""}</span>
            </div>
            <div
              className="event-trail-card-distinct-id"
              title="Click to copy"
              onClick={() => {
                navigator.clipboard.writeText(hoveredEvent[6]);
                setShowCopied(true);
                setTimeout(() => setShowCopied(false), 1500);
              }}
            >
              {hoveredEvent[6]}
            </div>
            {showCopied && <div className="event-trail-card-copied">Copied distinct_id</div>}

            <div className="event-trail-card-section">
              <div className="event-trail-card-label">This Event</div>
              <div className="event-trail-card-row">
                {formatDateTime(hoveredEvent[2])}
              </div>
            </div>

            <div className="event-trail-card-section">
              <div className="event-trail-card-label">User History</div>
              {auditLoading && <div className="event-trail-card-loading">Loading…</div>}
              {audit && (() => {
                let lastMatchIdx = -1;
                for (let i = audit.length - 1; i >= 0; i--) {
                  if (audit[i].timestamp === hoveredEvent[2]) { lastMatchIdx = i; break; }
                }
                return (
                  <div className="event-trail-card-audit">
                    {audit.map((entry, i) => (
                      <div
                        key={i}
                        className={`event-trail-card-row${i === lastMatchIdx ? " current" : ""}`}
                      >
                        <span style={{ color: eventColor(entry.type) }}>
                          {entry.displayName}
                        </span>
                        {" "}@ {formatDateTime(entry.timestamp)}
                        {entry.city ? ` — ${entry.city} ${countryFlag(entry.countryCode)}` : ""}
                        {entry.pssName ? ` [${entry.pssName}]` : ""}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>

          {activeCluster.length > 1 && (
            <div className="event-trail-card-nav">
              <button
                className="event-trail-card-nav-btn"
                disabled={clusterOffset === 0}
                onClick={() => setClusterOffset((o) => Math.max(0, o - 1))}
              >
                ‹
              </button>
              <span className="event-trail-card-nav-label">
                Showing user {clusterOffset + 1} of {activeCluster.length}
              </span>
              <button
                className="event-trail-card-nav-btn"
                disabled={clusterOffset >= activeCluster.length - 1}
                onClick={() => setClusterOffset((o) => Math.min(activeCluster.length - 1, o + 1))}
              >
                ›
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
