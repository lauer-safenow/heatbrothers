import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./App.css";

interface Stats {
  total: number;
  byType: { event_type: string; count: number }[];
}

export function App() {
  const navigate = useNavigate();
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
          <span className="fist fist-left">🤜</span>
          <span className="fist fist-right">🤛</span>
          <span className="sunglasses sunglasses-left">😎</span>
          <span className="brothers">BROTHERS</span>
          <span className="sunglasses sunglasses-right">😎</span>
        </div>

        <div className="splash-actions">
          <button className="enter-btn" onClick={() => navigate("/map")}>
            ENTER
          </button>
          <div className="splash-actions-secondary">
            <button className="live-btn" onClick={() => navigate("/live")}>
              <span className="live-dot" />
              LIVE
            </button>
            <button className="hot-btn" onClick={() => navigate("/hot-right-now")}>
              HOT RIGHT NOW
            </button>
          </div>
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
