import { useMemo, useState } from "react";
import "./TimeHistogram.css";

type EventTuple = [number, number, number]; // [lng, lat, unixSeconds]
type BinSize = "day" | "week" | "month";
type ViewMode = "daily" | "aggregated";

interface TimeHistogramProps {
  events: EventTuple[];
  filteredEvents: EventTuple[];
  onClose?: () => void;
}

function chooseBinSize(events: EventTuple[]): BinSize {
  if (events.length === 0) return "day";
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    if (e[2] < min) min = e[2];
    if (e[2] > max) max = e[2];
  }
  const spanDays = (max - min) / 86400;
  if (spanDays <= 60) return "day";
  if (spanDays <= 365) return "week";
  return "month";
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


export function TimeHistogram({ events, filteredEvents, onClose }: TimeHistogramProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("daily");
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    dotY?: number;
    idx: number;
    key: string;
    value: number;
  } | null>(null);

  const binSize = useMemo(() => chooseBinSize(events), [events]);
  const filtBuckets = useMemo(
    () => bucket(filteredEvents, binSize),
    [filteredEvents, binSize],
  );

  const keys = useMemo(() => [...filtBuckets.keys()].sort(), [filtBuckets]);

  const cumValues = useMemo(
    () => cumulative(keys, filtBuckets),
    [keys, filtBuckets],
  );

  if (keys.length === 0) return null;

  const n = keys.length;
  const maxFilt = filtBuckets.size > 0 ? Math.max(...filtBuckets.values()) : 1;
  const maxCum = cumValues.length > 0 ? cumValues[cumValues.length - 1] : 1;
  const maxCount = viewMode === "daily" ? maxFilt || 1 : maxCum || 1;

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

  return (
    <div className="time-histogram-wrapper">
      {onClose && (
        <button className="histogram-close" onClick={onClose}>
          X
        </button>
      )}
      <div className="histogram-sidebar">
        <button
          className={`histogram-toggle ${viewMode === "daily" ? "active" : ""}`}
          onClick={() => { setViewMode("daily"); setHover(null); }}
        >
          daily
        </button>
        <button
          className={`histogram-toggle ${viewMode === "aggregated" ? "active" : ""}`}
          onClick={() => { setViewMode("aggregated"); setHover(null); }}
        >
          aggregate
        </button>
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
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="fire-bar" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#fff7a0" />
              <stop offset="15%" stopColor="#ffdd33" />
              <stop offset="40%" stopColor="#ff8800" />
              <stop offset="70%" stopColor="#ff4400" />
              <stop offset="100%" stopColor="#cc2200" />
            </linearGradient>
          </defs>

          {viewMode === "daily" && keys.map((key, i) => {
            const filtCount = filtBuckets.get(key) ?? 0;
            const isHovered = hover?.idx === i;
            return (
              <g key={key}>
                <rect
                  x={i}
                  y={maxCount - filtCount}
                  width={0.85}
                  height={filtCount}
                  fill={isHovered ? "url(#fire-bar)" : "rgb(255,140,0)"}
                />
                <rect
                  x={i}
                  y={0}
                  width={0.85}
                  height={maxCount}
                  fill="transparent"
                  onMouseEnter={(e) => {
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
                fill="rgba(255,140,0,0.1)"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={linePath}
                fill="none"
                stroke="rgb(255,140,0)"
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
