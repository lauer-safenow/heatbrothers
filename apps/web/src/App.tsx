import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./App.css";

export function App() {
  const navigate = useNavigate();
  const [animDone, setAnimDone] = useState(false);

  useEffect(() => {
    // world-drag animation is 4s, then swap to static icon
    const timer = setTimeout(() => setAnimDone(true), 4000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="splash">
      <div className="splash-logo-card">
        <div className="splash-icon-wrap">
          {animDone ? (
            <img
              src="/safenow-icon.svg"
              alt="SafeNow"
              className="splash-icon"
            />
          ) : (
            <div className="splash-globe">
              <img
                src="/world-drag.svg"
                alt=""
                className="splash-globe-drag"
              />
            </div>
          )}
        </div>
        <span className="splash-brand">
          <span className="splash-brand-safe">SafeNow</span>{" "}
          <span className="splash-brand-world">World</span>
        </span>
      </div>

      <div className="splash-nav">
        <button className="splash-btn" onClick={() => navigate("/map")}>
          Heatmap
        </button>
        <button className="splash-btn" onClick={() => navigate("/live")}>
          Live view
        </button>
        <button className="splash-btn" onClick={() => navigate("/hot-right-now")}>
          Hot right now
        </button>
      </div>

      <button className="splash-feature-btn" onClick={() => navigate("/feature-request")}>
        Request a Feature
      </button>
    </div>
  );
}
