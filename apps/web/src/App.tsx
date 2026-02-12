import { useEffect, useState } from "react";
import "./App.css";

interface Stats {
  total: number;
  byType: { event_type: string; count: number }[];
}

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  return (
    <>
      {/* ambient background glow */}
      <div className="heat-bg" />

      <div className="logo">
        {/* ── HEAT with fire ── */}
        <div className="heat-wrapper">
          {/* flame tongues behind text */}
          <div className="flames">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="flame" />
            ))}
          </div>

          {/* floating ember particles */}
          <div className="embers">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="ember" />
            ))}
          </div>

          <span className="heat">HEAT</span>
        </div>

        {/* ── BROTHERS with cool chrome + sunglasses ── */}
        <div className="brothers-wrapper">
          <span className="sunglasses">😎</span>
          <span className="brothers">BROTHERS</span>
        </div>
      </div>

      {stats && (
        <div className="stats">
          <div className="stats-total">{stats.total.toLocaleString()} events synced</div>
          <div className="stats-types">
            {stats.byType.map((t) => (
              <div key={t.event_type} className="stats-row">
                <span className="stats-type">{t.event_type}</span>
                <span className="stats-count">{t.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
