import { useEffect, useRef } from "react";

// Writes to the DOM directly so measuring doesn't add React renders
export function FpsCounter() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    let windowStart = last;

    const tick = (now: number) => {
      worst = Math.max(worst, now - last);
      last = now;
      frames++;
      if (now - windowStart >= 500) {
        const fps = (frames * 1000) / (now - windowStart);
        if (ref.current) ref.current.textContent = `${fps.toFixed(0)} fps · worst ${worst.toFixed(0)} ms`;
        frames = 0;
        worst = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        padding: "4px 10px",
        borderRadius: 14,
        background: "rgba(0, 0, 0, 0.75)",
        color: "#7CFC00",
        font: "600 13px ui-monospace, monospace",
        pointerEvents: "none",
      }}
    >
      – fps
    </div>
  );
}
