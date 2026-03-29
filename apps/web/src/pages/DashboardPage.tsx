import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./DashboardPage.css";

interface EventTypeStat {
  event_type: string;
  displayName: string;
  count: number;
}

interface ZoneInfo {
  name: string;
  image: string | null;
  description: string | null;
  about: string | null;
  number_of_members: number;
  number_of_members_reachable: number;
  max_number_of_members_allowed: number | null;
  safe_spot_type: string;
  created_at: string;
  modified_at: string;
  valid_until: string | null;
  created_by: string | null;
}

interface CountryZones {
  country: string;
  count: number;
  zones: ZoneInfo[];
}

interface DashboardData {
  events: { total: number; byType: EventTypeStat[] };
  eventsToday: { total: number; byType: EventTypeStat[] };
  zones: { total: number; byCountry: CountryZones[] };
}

function countryFlag(cc: string): string {
  if (cc.length !== 2) return "";
  const offset = 0x1f1e6 - 65;
  const first = cc.charCodeAt(0);
  const second = cc.charCodeAt(1);
  if (first < 65 || first > 90 || second < 65 || second > 90) return "";
  return String.fromCodePoint(first + offset, second + offset);
}

const SETTINGS_KEY = "heatbrothers-map-settings";

function readTheme(): "dark" | "light" {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.mapTheme === "dark" || parsed.mapTheme === "light") return parsed.mapTheme;
    }
  } catch { /* ignore */ }
  return "light";
}

function writeTheme(theme: "dark" | "light") {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const settings = raw ? JSON.parse(raw) : {};
    settings.mapTheme = theme;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hoveredZone, setHoveredZone] = useState<ZoneInfo | null>(null);
  const tooltipRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overflow = rect.bottom - window.innerHeight;
    if (overflow > 0) {
      el.style.top = `${-overflow - 8}px`;
    }
  }, []);
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="dashboard-page" data-theme={theme}>
        <div className="dashboard-error">Failed to load: {error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="dashboard-page" data-theme={theme}>
        <div className="dashboard-loading">Loading dashboard...</div>
      </div>
    );
  }

  const maxZoneCount = Math.max(...data.zones.byCountry.map((z) => z.count), 1);

  return (
    <div className="dashboard-page" data-theme={theme}>
      <div className="dashboard-topbar">
        <button className="dashboard-back" onClick={() => navigate("/")}>
          ←
        </button>
        <span className="dashboard-title">Dashboard</span>
        <button
          className="dashboard-theme-toggle"
          onClick={() => setTheme((t) => {
            const next = t === "dark" ? "light" : "dark";
            writeTheme(next);
            return next;
          })}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </div>

      <div className="dashboard-grid">
        <div className="dashboard-column">
          <div className="dashboard-card">
            <div className="dashboard-card-header">
              <span className="dashboard-card-title">Events</span>
              <span className="dashboard-card-total">
                {data.events.total.toLocaleString()}
              </span>
            </div>
            <div className="dashboard-rows">
              {data.events.byType.map((e) => (
                <div className="dashboard-row" key={e.event_type}>
                  <span className="dashboard-row-label">{e.displayName}</span>
                  <span className="dashboard-row-count">
                    {e.count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="dashboard-card">
            <div className="dashboard-card-header">
              <span className="dashboard-card-title">Events Today</span>
              <span className="dashboard-card-total">
                {data.eventsToday.total.toLocaleString()}
              </span>
            </div>
            <div className="dashboard-rows">
              {data.eventsToday.byType.map((e) => (
                <div className="dashboard-row" key={e.event_type}>
                  <span className="dashboard-row-label">{e.displayName}</span>
                  <span className="dashboard-row-count">
                    {e.count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="dashboard-card">
          <div className="dashboard-card-header">
            <span className="dashboard-card-title">Active & Public Zones</span>
            <span className="dashboard-card-total">
              {data.zones.total.toLocaleString()}
            </span>
          </div>
          <div className="dashboard-rows">
            {data.zones.byCountry.map((z) => {
              const isOpen = expanded.has(z.country);
              return (
                <div key={z.country}>
                  <div
                    className="dashboard-row dashboard-row-clickable"
                    onClick={() => setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(z.country)) next.delete(z.country);
                      else next.add(z.country);
                      return next;
                    })}
                  >
                    <span className="dashboard-row-chevron">{isOpen ? "▾" : "▸"}</span>
                    <span className="dashboard-row-label">{countryFlag(z.country)} {z.country}</span>
                    <div className="dashboard-row-bar">
                      <div
                        className="dashboard-row-bar-fill"
                        style={{ width: `${(z.count / maxZoneCount) * 100}%` }}
                      />
                    </div>
                    <span className="dashboard-row-count">
                      {z.count.toLocaleString()}
                    </span>
                  </div>
                  {isOpen && (
                    <div className="dashboard-zone-list">
                      {z.zones.map((zone) => (
                        <div
                          className="dashboard-zone-item-wrap"
                          key={zone.name}
                          onMouseEnter={() => setHoveredZone(zone)}
                          onMouseLeave={() => setHoveredZone(null)}
                        >
                          <div className="dashboard-zone-item">{zone.name}</div>
                          {hoveredZone === zone && (
                            <div className="dashboard-zone-tooltip" ref={tooltipRef}>
                              {zone.image && <img className="zone-tooltip-img" src={zone.image} alt={zone.name} />}
                              <div className="zone-tooltip-name">{zone.name}</div>
                              {zone.description && <div className="zone-tooltip-desc">{zone.description}</div>}
                              {zone.about && <div className="zone-tooltip-about">{zone.about}</div>}
                              <div className="zone-tooltip-grid">
                                <span className="zone-tooltip-label">Type</span>
                                <span>{zone.safe_spot_type}</span>
                                <span className="zone-tooltip-label">Members</span>
                                <span>{zone.number_of_members} / {zone.max_number_of_members_allowed ?? "∞"}</span>
                                <span className="zone-tooltip-label">Reachable</span>
                                <span>{zone.number_of_members_reachable}</span>
                                {zone.created_by && <>
                                  <span className="zone-tooltip-label">Created by</span>
                                  <span>{zone.created_by}</span>
                                </>}
                                <span className="zone-tooltip-label">Created</span>
                                <span>{new Date(zone.created_at).toLocaleDateString()}</span>
                                {zone.valid_until && <>
                                  <span className="zone-tooltip-label">Valid until</span>
                                  <span>{new Date(zone.valid_until).toLocaleDateString()}</span>
                                </>}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
