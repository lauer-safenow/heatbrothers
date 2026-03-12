import { useMemo, useRef, useState } from "react";
import "./TimeHistogram.css";

type EventTuple = [number, number, number]; // [lng, lat, unixSeconds]
type BinSize = "day" | "week" | "month";
type ViewMode = "normal" | "aggregated";

interface TimeHistogramProps {
  events: EventTuple[];
  filteredEvents: EventTuple[];
  onClose?: () => void;
  onTimeRangeSelect?: (from: string, until: string) => void;
}


function bucketKey(ts: number, binSize: BinSize): string {
  const d = new Date(ts * 1000);
  if (binSize === "day") return d.toISOString().slice(0, 10);
  if (binSize === "week") {
    const day = new Date(d);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 7);
}

function bucket(events: EventTuple[], binSize: BinSize): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) {
    const k = bucketKey(e[2], binSize);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function cumulative(keys: string[], buckets: Map<string, number>): number[] {
  const result: number[] = [];
  let sum = 0;
  for (const k of keys) {
    sum += buckets.get(k) ?? 0;
    result.push(sum);
  }
  return result;
}


function bucketStartDate(key: string, binSize: BinSize): string {
  if (binSize === "month") return key + "-01";
  return key;
}

function bucketEndDate(key: string, binSize: BinSize): string {
  if (binSize === "day") return key;
  if (binSize === "week") {
    const d = new Date(key + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  }
  // month: last day
  const d = new Date(key + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function TimeHistogram({ events, filteredEvents, onClose, onTimeRangeSelect }: TimeHistogramProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("normal");
  const [binSizeOverride, setBinSizeOverride] = useState<BinSize>("day");
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    dotY?: number;
    idx: number;
    key: string;
    value: number;
  } | null>(null);

  // brush selection state
  const [brush, setBrush] = useState<{ startIdx: number; endIdx: number; svgLeft: number; svgWidth: number } | null>(null);
  const brushRef = useRef<{ startIdx: number; endIdx: number } | null>(null);
  const brushing = useRef(false);

  const binSize = binSizeOverride;
  const filtBuckets = useMemo(
    () => bucket(filteredEvents, binSize),
    [filteredEvents, binSize],
  );

  const keys = useMemo(() => [...filtBuckets.keys()].sort(), [filtBuckets]);

  const cumValues = useMemo(
    () => cumulative(keys, filtBuckets),
    [keys, filtBuckets],
  );

  const n = keys.length;
  const maxFilt = filtBuckets.size > 0 ? Math.max(...filtBuckets.values()) : 1;
  const maxCum = cumValues.length > 0 ? cumValues[cumValues.length - 1] : 1;
  const maxCount = viewMode === "normal" ? maxFilt || 1 : maxCum || 1;

  const labelInterval = Math.max(1, Math.floor(n / 8));

  // build SVG path for cumulative line
  const linePath = useMemo(() => {
    if (cumValues.length === 0) return "";
    return cumValues
      .map((v, i) => `${i === 0 ? "M" : "L"}${i + 0.4},${maxCum - v}`)
      .join(" ");
  }, [cumValues, maxCum]);

  // area fill path (line + close to bottom)
  const areaPath = useMemo(() => {
    if (cumValues.length === 0) return "";
    return `${linePath} L${n - 0.6},${maxCum} L0.4,${maxCum} Z`;
  }, [linePath, n, maxCum]);

  if (keys.length === 0) return null;

  return (
    <div className="time-histogram-wrapper">
      {onClose && (
        <button className="histogram-close" onClick={onClose}>
          X
        </button>
      )}
      <div className="histogram-sidebar">
        <div className="histogram-sidebar-group">
          <span className="histogram-sidebar-label">view</span>
          <button
            className={`histogram-toggle ${viewMode === "normal" ? "active" : ""}`}
            onClick={() => { setViewMode("normal"); setHover(null); }}
          >
            normal
          </button>
          <button
            className={`histogram-toggle ${viewMode === "aggregated" ? "active" : ""}`}
            onClick={() => { setViewMode("aggregated"); setHover(null); }}
          >
            aggregate
          </button>
        </div>
        <div className="histogram-sidebar-group">
          <span className="histogram-sidebar-label">step</span>
          {(["day", "week", "month"] as BinSize[]).map((b) => (
            <button
              key={b}
              className={`histogram-toggle ${binSizeOverride === b ? "active" : ""}`}
              onClick={() => setBinSizeOverride(b)}
            >
              {b}
            </button>
          ))}
        </div>
      </div>
      <div className="histogram-main">
      <div className="histogram-chart-area">
        <div className="y-axis">
          <span>{maxCount.toLocaleString()}</span>
          <span>{Math.round(maxCount / 2).toLocaleString()}</span>
          <span>0</span>
        </div>
        <svg
          viewBox={`0 0 ${n} ${maxCount}`}
          preserveAspectRatio="none"
          className="time-histogram"
          style={onTimeRangeSelect ? { cursor: "crosshair" } : undefined}
          onMouseLeave={() => {
            setHover(null);
            if (brushing.current) {
              brushing.current = false;
              brushRef.current = null;
              setBrush(null);
            }
          }}
          onMouseDown={onTimeRangeSelect ? (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const areaRect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
            const idx = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - rect.left) / rect.width) * n)));
            brushRef.current = { startIdx: idx, endIdx: idx };
            setBrush({ ...brushRef.current, svgLeft: rect.left - areaRect.left, svgWidth: rect.width });
            brushing.current = true;
          } : undefined}
          onMouseMove={(e) => {
            if (!brushing.current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const areaRect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
            const idx = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - rect.left) / rect.width) * n)));
            brushRef.current = { startIdx: brushRef.current!.startIdx, endIdx: idx };
            setBrush({ ...brushRef.current, svgLeft: rect.left - areaRect.left, svgWidth: rect.width });
            setHover(null);
          }}
          onMouseUp={() => {
            if (!brushing.current) return;
            brushing.current = false;
            const b = brushRef.current;
            brushRef.current = null;
            setBrush(null);
            if (b && onTimeRangeSelect) {
              const lo = Math.min(b.startIdx, b.endIdx);
              const hi = Math.max(b.startIdx, b.endIdx);
              if (lo !== hi) {
                onTimeRangeSelect(bucketStartDate(keys[lo], binSize), bucketEndDate(keys[hi], binSize));
              }
            }
            setHover(null);
          }}
        >
          <defs>
            <linearGradient id="fire-bar" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--hist-bar-grad-1)" />
              <stop offset="15%" stopColor="var(--hist-bar-grad-2)" />
              <stop offset="40%" stopColor="var(--hist-bar-grad-3)" />
              <stop offset="70%" stopColor="var(--hist-bar-grad-4)" />
              <stop offset="100%" stopColor="var(--hist-bar-grad-5)" />
            </linearGradient>
          </defs>

          {viewMode === "normal" && keys.map((key, i) => {
            const filtCount = filtBuckets.get(key) ?? 0;
            const isHovered = hover?.idx === i;
            return (
              <g key={key}>
                <rect
                  x={i}
                  y={maxCount - filtCount}
                  width={0.85}
                  height={filtCount}
                  fill={isHovered ? "url(#fire-bar)" : "var(--hist-bar)"}
                />
                <rect
                  x={i}
                  y={0}
                  width={0.85}
                  height={maxCount}
                  fill="transparent"
                  onMouseEnter={(e) => {
                    if (brushing.current) return;
                    const svg = e.currentTarget.ownerSVGElement as SVGSVGElement;
                    const svgRect = svg.getBoundingClientRect();
                    const areaRect = (svg.parentElement as HTMLElement).getBoundingClientRect();
                    setHover({
                      x: svgRect.left - areaRect.left + ((i + 0.4) / n) * svgRect.width,
                      y: svgRect.top - areaRect.top,
                      idx: i,
                      key,
                      value: filtCount,
                    });
                  }}
                />
              </g>
            );
          })}

          {viewMode === "aggregated" && (
            <>
              <path
                d={areaPath}
                fill="var(--hist-bar-area)"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={linePath}
                fill="none"
                stroke="var(--hist-bar-stroke)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              {/* invisible hit areas per bucket */}
              {keys.map((key, i) => (
                <rect
                  key={key}
                  x={i}
                  y={0}
                  width={1}
                  height={maxCount}
                  fill="transparent"
                  onMouseEnter={(e) => {
                    if (brushing.current) return;
                    const svg = e.currentTarget.ownerSVGElement as SVGSVGElement;
                    const svgRect = svg.getBoundingClientRect();
                    const areaRect = (svg.parentElement as HTMLElement).getBoundingClientRect();
                    const frac = 1 - cumValues[i] / maxCum;
                    setHover({
                      x: svgRect.left - areaRect.left + ((i + 0.4) / n) * svgRect.width,
                      y: svgRect.top - areaRect.top,
                      dotY: svgRect.top - areaRect.top + frac * svgRect.height,
                      idx: i,
                      key,
                      value: cumValues[i],
                    });
                  }}
                />
              ))}
            </>
          )}

          {brush && Math.abs(brush.endIdx - brush.startIdx) > 0 && (
            <rect
              x={Math.min(brush.startIdx, brush.endIdx)}
              y={0}
              width={Math.abs(brush.endIdx - brush.startIdx) + 0.85}
              height={maxCount}
              fill="var(--hist-brush-fill)"
              stroke="var(--hist-brush-stroke)"
              strokeWidth="0.15"
              pointerEvents="none"
            />
          )}
        </svg>
        {hover && (
          <div
            className="histogram-tooltip"
            style={{ left: hover.x, top: hover.y }}
          >
            <strong>{hover.key}</strong>
            <span>{hover.value.toLocaleString()}</span>
          </div>
        )}
        {hover && viewMode === "aggregated" && hover.dotY != null && (
          <div
            className="histogram-dot"
            style={{ left: hover.x, top: hover.dotY }}
          />
        )}
        {brush && Math.abs(brush.endIdx - brush.startIdx) > 0 && (() => {
          const lo = Math.min(brush.startIdx, brush.endIdx);
          const hi = Math.max(brush.startIdx, brush.endIdx);
          const leftPx = brush.svgLeft + (lo / n) * brush.svgWidth;
          const rightPx = brush.svgLeft + ((hi + 0.85) / n) * brush.svgWidth;
          return (
            <>
              <div
                className="brush-range-label brush-range-left"
                style={{ left: leftPx }}
              >
                {bucketStartDate(keys[lo], binSize)}
              </div>
              <div
                className="brush-range-label brush-range-right"
                style={{ left: rightPx }}
              >
                {bucketEndDate(keys[hi], binSize)}
              </div>
            </>
          );
        })()}
      </div>
      <div className="time-histogram-labels">
        {keys.map((key, i) =>
          i % labelInterval === 0 ? (
            <span key={key} style={{ left: `${(i / n) * 100}%` }}>
              {key}
            </span>
          ) : null,
        )}
      </div>
      </div>
    </div>
  );
}
