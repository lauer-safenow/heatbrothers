import { useMemo, useState } from "react";
import "./TimeHistogram.css";

type EventTuple = [number, number, number]; // [lng, lat, unixSeconds]
type BinSize = "day" | "week" | "month";

interface TimeHistogramProps {
  events: EventTuple[];
  filteredEvents: EventTuple[];
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
    // Use UTC consistently (toISOString is UTC, so day-of-week must be too)
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


export function TimeHistogram({ events, filteredEvents }: TimeHistogramProps) {
  const [showComparison, setShowComparison] = useState(false);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    key: string;
    all: number;
    filtered: number;
  } | null>(null);

  const binSize = useMemo(() => chooseBinSize(events), [events]);
  const allBuckets = useMemo(() => bucket(events, binSize), [events, binSize]);
  const filtBuckets = useMemo(
    () => bucket(filteredEvents, binSize),
    [filteredEvents, binSize],
  );

  const keys = useMemo(() => [...allBuckets.keys()].sort(), [allBuckets]);

  if (keys.length === 0) return null;

  const maxAll = Math.max(...allBuckets.values());
  const maxFilt =
    filtBuckets.size > 0 ? Math.max(...filtBuckets.values()) : 0;
  const maxCount = showComparison ? maxAll : maxFilt || 1;
  const n = keys.length;

  const labelInterval = Math.max(1, Math.floor(n / 8));

  return (
    <div className="time-histogram-wrapper">
      <div className="histogram-sidebar">
        <button
          className={`histogram-toggle ${!showComparison ? "active" : ""}`}
          onClick={() => setShowComparison(false)}
        >
          filtered
        </button>
        <button
          className={`histogram-toggle ${showComparison ? "active" : ""}`}
          onClick={() => setShowComparison(true)}
        >
          vs total
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
          {keys.map((key, i) => {
            const allCount = allBuckets.get(key) ?? 0;
            const filtCount = filtBuckets.get(key) ?? 0;
            return (
              <g key={key}>
                {showComparison && (
                  <rect
                    x={i}
                    y={maxCount - allCount}
                    width={0.85}
                    height={allCount}
                    fill="rgba(255,255,255,0.08)"
                  />
                )}
                <rect
                  x={i}
                  y={maxCount - filtCount}
                  width={0.85}
                  height={filtCount}
                  fill="rgb(255,140,0)"
                />
                {/* invisible hit area for hover */}
                <rect
                  x={i}
                  y={0}
                  width={0.85}
                  height={maxCount}
                  fill="transparent"
                  onMouseEnter={(e) => {
                    const rect = (
                      e.currentTarget.ownerSVGElement as SVGSVGElement
                    ).getBoundingClientRect();
                    setHover({
                      x: rect.left + ((i + 0.4) / n) * rect.width,
                      y: rect.top - 8,
                      key,
                      all: allCount,
                      filtered: filtCount,
                    });
                  }}
                />
              </g>
            );
          })}
        </svg>
        {hover && (
          <div
            className="histogram-tooltip"
            style={{ left: hover.x, top: hover.y }}
          >
            <strong>{hover.key}</strong>
            <span>
              {hover.filtered.toLocaleString()}
              {showComparison && ` / ${hover.all.toLocaleString()}`}
            </span>
          </div>
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
