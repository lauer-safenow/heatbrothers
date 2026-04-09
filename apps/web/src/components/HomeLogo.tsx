import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import "./HomeLogo.css";

export function HomeLogo() {
  const navigate = useNavigate();
  const [animating, setAnimating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const schedule = useCallback(() => {
    const delay = (20 + Math.random() * 20) * 1000;
    timer.current = setTimeout(() => {
      setAnimating(true);
      setTimeout(() => setAnimating(false), 4000);
      schedule();
    }, delay);
  }, []);

  useEffect(() => {
    schedule();
    return () => clearTimeout(timer.current);
  }, [schedule]);

  return (
    <div className="home-logo" onClick={() => navigate("/")}>
      <span className="home-logo-icon-wrap">
        {animating ? (
          <span className="home-logo-globe">
            <img src="/world-drag.svg" alt="" className="home-logo-globe-drag" />
          </span>
        ) : (
          <img src="/safenow-icon.svg" alt="SafeNow" className="home-logo-icon" />
        )}
      </span>
      <span className="home-logo-text">
        <span className="home-logo-safe">SafeNow</span>{" "}
        <span className="home-logo-world">World</span>
      </span>
    </div>
  );
}
