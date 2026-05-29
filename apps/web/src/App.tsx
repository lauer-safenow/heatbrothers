import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentUser } from "./hooks/useCurrentUser";
import "./App.css";

type Version =
  | { type: "tag"; value: string }
  | { type: "commit"; hash: string; date: string }
  | { type: "unknown" };

export function App() {
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const [animDone, setAnimDone] = useState(false);
  const [version, setVersion] = useState<Version | null>(null);

  useEffect(() => {
    // world-drag animation is 4s, then swap to static icon
    const timer = setTimeout(() => setAnimDone(true), 4000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then(setVersion)
      .catch(() => {});
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

      {currentUser.name || currentUser.email ? (
        <p className="splash-greeting">
          Hello, {currentUser.name ?? currentUser.email}
        </p>
      ) : null}

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
        <button className="splash-btn" onClick={() => navigate("/dashboard")}>
          Dashboard
        </button>
        <button className="splash-btn" onClick={() => navigate("/quiz")}>
          Quiz
        </button>
      </div>

      <button className="splash-feature-btn" onClick={() => navigate("/feature-request")}>
        Request a Feature
      </button>

      {version && (
        <span className="splash-version">
          {version.type === "tag"
            ? version.value
            : version.type === "commit"
            ? `${version.hash} · ${new Date(version.date).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
            : null}
        </span>
      )}
    </div>
  );
}
