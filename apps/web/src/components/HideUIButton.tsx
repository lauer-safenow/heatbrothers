import { useState, useEffect, useCallback } from "react";

interface Props {
  hidden: boolean;
  onToggle: (hidden: boolean) => void;
}

/* closed-eye SVG with lashes */
const ClosedEye = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12 C6 17, 18 17, 22 12" />
    <line x1="5" y1="15" x2="3.5" y2="18.5" />
    <line x1="9.5" y1="16.5" x2="9" y2="20" />
    <line x1="14.5" y1="16.5" x2="15" y2="20" />
    <line x1="19" y1="15" x2="20.5" y2="18.5" />
  </svg>
);

/* open-eye SVG */
const OpenEye = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export function HideUIButton({ hidden, onToggle }: Props) {
  const [showReveal, setShowReveal] = useState(false);

  // When UI is hidden, show the open-eye button only while mouse is moving
  useEffect(() => {
    if (!hidden) return;
    let timer: ReturnType<typeof setTimeout>;
    const onMove = () => {
      setShowReveal(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShowReveal(false), 2000);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      clearTimeout(timer);
    };
  }, [hidden]);

  const toggle = useCallback(() => onToggle(!hidden), [hidden, onToggle]);

  // Hidden mode: always render, fade via CSS class
  if (hidden) {
    return (
      <button
        className={`hide-ui-btn reveal${showReveal ? " visible" : ""}`}
        title="Show UI"
        onClick={toggle}
      >
        {OpenEye}
      </button>
    );
  }

  // Normal mode: always show closed eye
  return (
    <button
      className="hide-ui-btn"
      title="Hide UI"
      onClick={toggle}
    >
      {ClosedEye}
    </button>
  );
}
