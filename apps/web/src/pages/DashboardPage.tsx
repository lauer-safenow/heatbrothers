import { useCallback, useEffect, useRef, useState } from "react";
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
  eventsByCountry: { country: string; count: number }[];
}

function countryFlag(cc: string): string {
  if (cc.length !== 2) return "";
  const offset = 0x1f1e6 - 65;
  const first = cc.charCodeAt(0);
  const second = cc.charCodeAt(1);
  if (first < 65 || first > 90 || second < 65 || second > 90) return "";
  return String.fromCodePoint(first + offset, second + offset);
}

const COUNTRY_LANGUAGES: Record<string, string[]> = {
  AF: ["Pashto","Dari"], AL: ["Albanian"], DZ: ["Arabic"], AD: ["Catalan"],
  AO: ["Portuguese"], AG: ["English"], AR: ["Spanish"], AM: ["Armenian"],
  AU: ["English"], AT: ["German"], AZ: ["Azerbaijani"], BS: ["English"],
  BH: ["Arabic"], BD: ["Bengali"], BB: ["English"], BY: ["Belarusian","Russian"],
  BE: ["Dutch","French","German"], BZ: ["English"], BJ: ["French"], BT: ["Dzongkha"],
  BO: ["Spanish"], BA: ["Bosnian","Croatian","Serbian"], BW: ["English"],
  BR: ["Portuguese"], BN: ["Malay"], BG: ["Bulgarian"], BF: ["French"],
  BI: ["French"], CV: ["Portuguese"], KH: ["Khmer"], CM: ["French","English"],
  CA: ["English","French"], CF: ["French"], TD: ["French","Arabic"], CL: ["Spanish"],
  CN: ["Chinese"], CO: ["Spanish"], KM: ["Arabic","French"], CG: ["French"],
  CD: ["French"], CR: ["Spanish"], CI: ["French"], HR: ["Croatian"], CU: ["Spanish"],
  CY: ["Greek","Turkish"], CZ: ["Czech"], DK: ["Danish"], DJ: ["French","Arabic"],
  DM: ["English"], DO: ["Spanish"], EC: ["Spanish"], EG: ["Arabic"], SV: ["Spanish"],
  GQ: ["Spanish","French","Portuguese"], ER: ["Arabic","Tigrinya"], EE: ["Estonian"],
  ET: ["Amharic"], FJ: ["English"], FI: ["Finnish","Swedish"], FR: ["French"],
  GA: ["French"], GM: ["English"], GE: ["Georgian"], DE: ["German"], GH: ["English"],
  GR: ["Greek"], GD: ["English"], GT: ["Spanish"], GN: ["French"], GW: ["Portuguese"],
  GY: ["English"], HT: ["French"], HN: ["Spanish"], HU: ["Hungarian"],
  IS: ["Icelandic"], IN: ["Hindi","English"], ID: ["Indonesian"], IR: ["Persian"],
  IQ: ["Arabic","Kurdish"], IE: ["English","Irish"], IL: ["Hebrew","Arabic"],
  IT: ["Italian"], JM: ["English"], JP: ["Japanese"], JO: ["Arabic"],
  KZ: ["Kazakh","Russian"], KE: ["English","Swahili"], KI: ["English"],
  KP: ["Korean"], KR: ["Korean"], KW: ["Arabic"], KG: ["Kyrgyz","Russian"],
  LA: ["Lao"], LV: ["Latvian"], LB: ["Arabic"], LS: ["English"], LR: ["English"],
  LY: ["Arabic"], LI: ["German"], LT: ["Lithuanian"], LU: ["French","German","Luxembourgish"],
  MK: ["Macedonian"], MG: ["French","Malagasy"], MW: ["English"], MY: ["Malay"],
  MV: ["Dhivehi"], ML: ["French"], MT: ["Maltese","English"], MH: ["English"],
  MR: ["Arabic"], MU: ["English","French"], MX: ["Spanish"], FM: ["English"],
  MD: ["Romanian"], MC: ["French"], MN: ["Mongolian"], ME: ["Montenegrin"],
  MA: ["Arabic","Berber"], MZ: ["Portuguese"], MM: ["Burmese"], NA: ["English"],
  NR: ["English"], NP: ["Nepali"], NL: ["Dutch"], NZ: ["English","Māori"],
  NI: ["Spanish"], NE: ["French"], NG: ["English"], NO: ["Norwegian"],
  OM: ["Arabic"], PK: ["Urdu","English"], PW: ["English"], PA: ["Spanish"],
  PG: ["English"], PY: ["Spanish","Guaraní"], PE: ["Spanish"], PH: ["Filipino","English"],
  PL: ["Polish"], PT: ["Portuguese"], QA: ["Arabic"], RO: ["Romanian"],
  RU: ["Russian"], RW: ["French","English","Kinyarwanda"], KN: ["English"],
  LC: ["English"], VC: ["English"], WS: ["Samoan","English"], SM: ["Italian"],
  ST: ["Portuguese"], SA: ["Arabic"], SN: ["French"], RS: ["Serbian"],
  SC: ["English","French"], SL: ["English"], SG: ["English","Malay","Chinese","Tamil"],
  SK: ["Slovak"], SI: ["Slovenian"], SB: ["English"], SO: ["Somali","Arabic"],
  ZA: ["English","Afrikaans"], SS: ["English"], ES: ["Spanish"], LK: ["Sinhala","Tamil"],
  SD: ["Arabic","English"], SR: ["Dutch"], SZ: ["English"], SE: ["Swedish"],
  CH: ["German","French","Italian"], SY: ["Arabic"], SJ: ["Norwegian"],
  TW: ["Chinese"], TJ: ["Tajik"], TZ: ["Swahili","English"], TH: ["Thai"],
  TL: ["Portuguese","Tetum"], TG: ["French"], TO: ["English"], TT: ["English"],
  TN: ["Arabic"], TR: ["Turkish"], TM: ["Turkmen"], TV: ["English"],
  UG: ["English","Swahili"], UA: ["Ukrainian"], AE: ["Arabic"], GB: ["English"],
  US: ["English"], UY: ["Spanish"], UZ: ["Uzbek"], VU: ["French","English"],
  VE: ["Spanish"], VN: ["Vietnamese"], YE: ["Arabic"], ZM: ["English"], ZW: ["English"],
};

const EVENT_TYPES = [
  { key: "DETAILED_ALARM_STARTED_PRIVATE_GROUP", label: "Alarm started private" },
  { key: "DETAILED_ATTENTION_STARTED_PRIVATE_GROUP", label: "Attention private" },
  { key: "app_opening_ZONE", label: "App opening zone" },
  { key: "FIRST_TIME_PHONE_STATUS_SENT", label: "Installs" },
  { key: "DETAILED_ALARM_STARTED_ZONE", label: "Alarm started zone" },
];

function FilterDropdown({
  label,
  options,
  selected,
  onChange,
  pinned,
  searchable,
}: {
  label: string;
  options: { key: string; label: string; tooltip?: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  pinned?: string[];
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const toggle = (key: string) => {
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  };

  const pinnedSet = new Set(pinned ?? []);
  const query = search.toLowerCase();
  const pinnedOptions = (pinned ?? []).map((k) => options.find((o) => o.key === k)).filter(Boolean) as typeof options;
  const restOptions = options.filter((o) => !pinnedSet.has(o.key));
  const filteredPinned = pinnedOptions.filter((o) => !query || o.label.toLowerCase().includes(query));
  const filteredRest = restOptions.filter((o) => !query || o.label.toLowerCase().includes(query));

  const renderOption = (o: typeof options[0]) => (
    <label
      key={o.key}
      className="dashboard-filter-option"
      onMouseEnter={() => setHoveredKey(o.key)}
      onMouseLeave={() => setHoveredKey(null)}
    >
      <input type="checkbox" checked={selected.includes(o.key)} onChange={() => toggle(o.key)} />
      {o.label}
      {o.tooltip && hoveredKey === o.key && (
        <span className="dashboard-filter-tooltip">{o.tooltip}</span>
      )}
    </label>
  );

  return (
    <div className="dashboard-filter-dropdown" ref={ref}>
      <button
        className={`dashboard-filter-btn${selected.length ? " dashboard-filter-btn--active" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        {label}{selected.length ? ` (${selected.length})` : ""} ▾
      </button>
      {open && (
        <div className="dashboard-filter-menu">
          {searchable && (
            <div className="dashboard-filter-search-wrap">
              <input
                className="dashboard-filter-search"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>
          )}
          {filteredPinned.map(renderOption)}
          {filteredPinned.length > 0 && filteredRest.length > 0 && (
            <div className="dashboard-filter-divider" />
          )}
          {filteredRest.map(renderOption)}
        </div>
      )}
    </div>
  );
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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedEventTypes, setSelectedEventTypes] = useState<string[]>([]);
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  const [availableCountries, setAvailableCountries] = useState<string[]>([]);

  const availableLanguages = [...new Set(Object.values(COUNTRY_LANGUAGES).flat())].sort();

  const effectiveCountries = [...new Set([
    ...selectedCountries,
    ...(selectedLanguages.length
      ? Object.keys(COUNTRY_LANGUAGES).filter((cc) => (COUNTRY_LANGUAGES[cc] ?? []).some((l) => selectedLanguages.includes(l)))
      : []),
  ])];

  useEffect(() => {
    const params = new URLSearchParams();
    if (from) params.set("from", String(Math.floor(new Date(from).getTime() / 1000)));
    if (to) params.set("to", String(Math.floor(new Date(to + "T23:59:59").getTime() / 1000)));
    if (selectedEventTypes.length) params.set("eventTypes", selectedEventTypes.join(","));
    if (effectiveCountries.length) params.set("countries", effectiveCountries.join(","));

    fetch(`/api/dashboard?${params}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => {
        setData(d);
        if (!effectiveCountries.length) {
          const allCountries = [...new Set([
            ...d.zones.byCountry.map((z: { country: string }) => z.country),
            ...(d.eventsByCountry ?? []).map((c: { country: string }) => c.country),
          ])].sort();
          setAvailableCountries(allCountries);
        }
      })
      .catch((e) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, selectedEventTypes, selectedCountries, selectedLanguages]);

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
  const maxEventCountryCount = Math.max(...(data.eventsByCountry ?? []).map((c) => c.count), 1);

  const eventsByLanguage = (() => {
    const counts = new Map<string, number>();
    for (const { country, count } of data.eventsByCountry ?? []) {
      const lang = (COUNTRY_LANGUAGES[country] ?? ["Unknown"])[0];
      counts.set(lang, (counts.get(lang) ?? 0) + count);
    }
    return [...counts.entries()].map(([language, count]) => ({ language, count })).sort((a, b) => b.count - a.count);
  })();
  const maxEventLanguageCount = Math.max(...eventsByLanguage.map((l) => l.count), 1);

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

      <div className="dashboard-filters">
        <div className="dashboard-filter-group">
          <label className="dashboard-filter-label">From</label>
          <input type="date" className="dashboard-filter-date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="dashboard-filter-group">
          <label className="dashboard-filter-label">To</label>
          <input type="date" className="dashboard-filter-date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <FilterDropdown
          label="Event types"
          options={EVENT_TYPES.map((e) => ({ key: e.key, label: e.label }))}
          selected={selectedEventTypes}
          onChange={setSelectedEventTypes}
        />
        <FilterDropdown
          label="Language"
          options={availableLanguages.map((l) => {
            const countries = Object.keys(COUNTRY_LANGUAGES).filter((cc) => (COUNTRY_LANGUAGES[cc] ?? []).includes(l));
            return {
              key: l,
              label: l,
              tooltip: countries.map((cc) => `${countryFlag(cc)} ${cc}`).join("  "),
            };
          })}
          selected={selectedLanguages}
          onChange={setSelectedLanguages}
          pinned={["German", "English", "Spanish"]}
          searchable
        />
        <FilterDropdown
          label="Countries"
          options={availableCountries.map((c) => ({ key: c, label: `${countryFlag(c)} ${c}` }))}
          selected={selectedCountries}
          onChange={setSelectedCountries}
        />
        {(from || to || selectedEventTypes.length > 0 || selectedLanguages.length > 0 || selectedCountries.length > 0) && (
          <button
            className="dashboard-filter-clear"
            onClick={() => { setFrom(""); setTo(""); setSelectedEventTypes([]); setSelectedLanguages([]); setSelectedCountries([]); }}
          >
            Clear
          </button>
        )}
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

          <div className="dashboard-card">
            <div className="dashboard-card-header">
              <span className="dashboard-card-title">Events by Language</span>
              <span className="dashboard-card-total">{eventsByLanguage.reduce((s, l) => s + l.count, 0).toLocaleString()}</span>
            </div>
            <div className="dashboard-rows">
              {eventsByLanguage.map((l) => (
                <div className="dashboard-row" key={l.language}>
                  <span className="dashboard-row-label">{l.language}</span>
                  <div className="dashboard-row-bar">
                    <div
                      className="dashboard-row-bar-fill"
                      style={{ width: `${(l.count / maxEventLanguageCount) * 100}%` }}
                    />
                  </div>
                  <span className="dashboard-row-count">{l.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="dashboard-card">
            <div className="dashboard-card-header">
              <span className="dashboard-card-title">Events by Country</span>
              <span className="dashboard-card-total">
                {(data.eventsByCountry ?? []).reduce((s, c) => s + c.count, 0).toLocaleString()}
              </span>
            </div>
            <div className="dashboard-rows">
              {(data.eventsByCountry ?? []).map((c) => (
                <div className="dashboard-row" key={c.country}>
                  <span className="dashboard-row-label">{countryFlag(c.country)} {c.country}</span>
                  <div className="dashboard-row-bar">
                    <div
                      className="dashboard-row-bar-fill"
                      style={{ width: `${(c.count / maxEventCountryCount) * 100}%` }}
                    />
                  </div>
                  <span className="dashboard-row-count">{c.count.toLocaleString()}</span>
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
