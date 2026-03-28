import { useState, useRef, useCallback, useEffect, type ChangeEvent, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import Papa from "papaparse";
import { deflate, inflate } from "pako";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import BleScanner from "./BleScanner";
import "./beacon-boy.css";
import BeaconBoySvg from "./BeaconBoySvg";

// ── Types ──────────────────────────────────────────────────────────────────

interface BeaconRow {
  id: number;
  Major: string;
  Minor: string;
  Building: string;
  Floor: string;
  ExactPos1: string;
  ExactPos2: string;
  Strength: string;
  Latitude: string;
  Longitude: string;
  ZoneId: string;
  Comment: string;
}

const COLUMNS: (keyof Omit<BeaconRow, "id">)[] = [
  "Major",
  "Minor",
  "Building",
  "Floor",
  "ExactPos1",
  "ExactPos2",
  "Strength",
  "Latitude",
  "Longitude",
  "ZoneId",
  "Comment",
];

const MANDATORY_FIELDS: Set<keyof Omit<BeaconRow, "id">> = new Set([
  "Major", "Minor", "Building", "Floor", "ExactPos1",
  "Latitude", "Longitude", "ZoneId",
]);

const MASS_EDIT_FIELDS = ["Building", "Floor", "Zone", "Strength", "ZoneId"] as const;
type MassEditField = (typeof MASS_EDIT_FIELDS)[number];

let nextId = 1;

function parseRows(data: Record<string, string>[]): BeaconRow[] {
  return data.map((raw) => ({
    id: nextId++,
    Major: raw.Major ?? "",
    Minor: raw.Minor ?? "",
    Building: raw.Building ?? "",
    Floor: raw.Floor ?? "",
    ExactPos1: raw.ExactPos1 ?? "",
    ExactPos2: raw.ExactPos2 ?? "",
    Strength: raw.Strength ?? "",
    Latitude: raw.Latitude ?? "",
    Longitude: raw.Longitude ?? "",
    ZoneId: raw.ZoneId ?? "",
    Comment: raw.Comment ?? "",
  }));
}

function parseCsvString(csv: string): Record<string, string>[] {
  const result = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return result.data;
}

// ── CSV Uploader ───────────────────────────────────────────────────────────

function CsvUploader({ onParsed }: { onParsed: (rows: BeaconRow[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete(results) {
          onParsed(parseRows(results.data));
        },
      });
    },
    [onParsed],
  );

  const handlePaste = useCallback(() => {
    if (!pasteText.trim()) return;
    onParsed(parseRows(parseCsvString(pasteText)));
    setPasteText("");
  }, [pasteText, onParsed]);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const onFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  return (
    <div className="bb-upload-section">
      <div
        className={`bb-dropzone ${dragging ? "bb-dropzone--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          onChange={onFileChange}
          hidden
        />
        <span>Drop a CSV here or click to upload</span>
      </div>
      <div className="bb-paste-section">
        <textarea
          className="bb-paste-area"
          placeholder="...or paste CSV text here (include header row)"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          rows={5}
        />
        <button
          className="bb-paste-btn"
          disabled={!pasteText.trim()}
          onClick={handlePaste}
        >
          Parse pasted CSV
        </button>
      </div>
    </div>
  );
}

// ── Mass Edit Toolbar ──────────────────────────────────────────────────────

function MassEditToolbar({
  onApply,
}: {
  onApply: (field: MassEditField, value: string) => void;
}) {
  const [field, setField] = useState<MassEditField>("Building");
  const [value, setValue] = useState("");

  return (
    <div className="bb-toolbar">
      <label>Mass edit:</label>
      <select
        value={field}
        onChange={(e) => setField(e.target.value as MassEditField)}
      >
        {MASS_EDIT_FIELDS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="New value..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value) {
            onApply(field, value);
            setValue("");
          }
        }}
      />
      <button
        disabled={!value}
        onClick={() => {
          onApply(field, value);
          setValue("");
        }}
      >
        Apply to all
      </button>
    </div>
  );
}

// ── Beacon Table ───────────────────────────────────────────────────────────

type Filters = Record<keyof Omit<BeaconRow, "id">, string>;

const emptyFilters: Filters = Object.fromEntries(
  COLUMNS.map((c) => [c, ""]),
) as Filters;

function filterRows(rows: BeaconRow[], filters: Filters): BeaconRow[] {
  return rows.filter((row) =>
    COLUMNS.every((col) => {
      const f = filters[col];
      if (!f) return true;
      return row[col].toLowerCase().includes(f.toLowerCase());
    }),
  );
}

function emptyRow(): BeaconRow {
  return {
    id: nextId++,
    Major: "", Minor: "", Building: "", Floor: "",
    ExactPos1: "", ExactPos2: "", Strength: "0",
    Latitude: "", Longitude: "", ZoneId: "", Comment: "",
  };
}

function BeaconTable({
  rows,
  filters,
  selected,
  existingKeys,
  onFilterChange,
  onCellChange,
  onToggle,
  onToggleAll,
  onAddRow,
  onDeleteRow,
}: {
  rows: BeaconRow[];
  filters: Filters;
  selected: Set<number>;
  existingKeys?: Set<string>;
  onFilterChange: (col: keyof Omit<BeaconRow, "id">, value: string) => void;
  onCellChange: (id: number, col: keyof Omit<BeaconRow, "id">, value: string) => void;
  onToggle: (id: number) => void;
  onToggleAll: (ids: number[], checked: boolean) => void;
  onAddRow?: () => void;
  onDeleteRow?: (id: number) => void;
}) {
  if (rows.length === 0) return null;

  const filtered = filterRows(rows, filters);
  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const hasActiveFilters = COLUMNS.some((c) => filters[c]);

  return (
    <div className="bb-table-wrap">
      <table className="bb-table">
        <thead>
          <tr>
            <th className="bb-checkbox-col">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(e) =>
                  onToggleAll(filtered.map((r) => r.id), e.target.checked)
                }
              />
            </th>
            <th>#</th>
            {COLUMNS.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
          <tr className="bb-filter-row">
            <th></th>
            <th></th>
            {COLUMNS.map((col) => (
              <th key={col}>
                <input
                  type="text"
                  className="bb-filter-input"
                  placeholder="Filter..."
                  value={filters[col]}
                  onChange={(e) => onFilterChange(col, e.target.value)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((row, idx) => {
            const isDup = existingKeys?.has(`${row.Major}:${row.Minor}`) ?? false;
            const cls = [
              !selected.has(row.id) && "bb-row-deselected",
              isDup && "bb-row-duplicate",
            ].filter(Boolean).join(" ");
            return (
              <tr
                key={row.id}
                className={cls}
                title={isDup ? "This Major/Minor combo already exists in the DB — saving will upsert" : undefined}
              >
                <td className="bb-checkbox-col">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => onToggle(row.id)}
                  />
                </td>
                <td className="bb-row-num">
                  {onDeleteRow ? (
                    <button
                      className="bb-delete-row-btn"
                      onClick={() => onDeleteRow(row.id)}
                      title="Delete row"
                    >&times;</button>
                  ) : (idx + 1)}
                </td>
                {COLUMNS.map((col) => (
                  <td key={col} className={MANDATORY_FIELDS.has(col) && !row[col] ? "bb-cell-missing" : undefined}>
                    <input
                      type="text"
                      value={row[col]}
                      onChange={(e) => onCellChange(row.id, col, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
          {onAddRow && !hasActiveFilters && (
            <tr className="bb-row-new">
              <td className="bb-checkbox-col">
                <button className="bb-add-btn" onClick={onAddRow} title="Add row">+</button>
              </td>
              <td className="bb-row-num"></td>
              {COLUMNS.map((col) => (
                <td key={col}></td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── API helpers ─────────────────────────────────────────────────────────────

async function fetchBeacons(): Promise<BeaconRow[]> {
  const res = await fetch("/api/beacon-boy/beacons");
  return res.json();
}

async function saveAllBeacons(
  rows: BeaconRow[],
  mode: "replace" | "append" = "replace",
): Promise<BeaconRow[]> {
  const res = await fetch("/api/beacon-boy/beacons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows, mode }),
  });
  return res.json();
}

// ── Deflate URL encoding ────────────────────────────────────────────────────

function rowsToCsv(rows: BeaconRow[]): string {
  return Papa.unparse(rows, { columns: COLUMNS as string[] });
}

function decompressFromParam(param: string): BeaconRow[] | null {
  try {
    // restore base64url → standard base64
    const b64 = param.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const csv = new TextDecoder().decode(inflate(bytes));
    const result = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: true,
    });
    if (result.data.length === 0) return null;
    return parseRows(result.data);
  } catch {
    return null;
  }
}

// ── LocalStorage persistence ────────────────────────────────────────────────

const STORAGE_KEY = "beacon-boy-fill";

interface FillState {
  rows: BeaconRow[];
  selected: number[];
  dirty: boolean;
}

function saveFillState(rows: BeaconRow[], selected: Set<number>, dirty: boolean) {
  try {
    const state: FillState = { rows, selected: [...selected], dirty };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded — ignore */ }
}

function loadFillState(): FillState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as FillState;
    if (!Array.isArray(state.rows)) return null;
    return state;
  } catch {
    return null;
  }
}

// ── Fill Database Tab ───────────────────────────────────────────────────────

function FillTab() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Priority: ?data= param > localStorage
  const initRef = useRef(() => {
    const dataParam = searchParams.get("data");
    if (dataParam) {
      const fromUrl = decompressFromParam(dataParam);
      if (fromUrl) return { rows: fromUrl, selected: fromUrl.map((r) => r.id), dirty: true };
    }
    const ls = loadFillState();
    if (ls) return ls;
    return { rows: [] as BeaconRow[], selected: [] as number[], dirty: false };
  });
  const init = useRef(initRef.current());

  const [rows, setRows] = useState<BeaconRow[]>(init.current.rows);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [selected, setSelected] = useState<Set<number>>(
    new Set(init.current.selected),
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(init.current.dirty);
  const [existingKeys, setExistingKeys] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [originalRows, setOriginalRows] = useState<BeaconRow[] | null>(null);

  // Keep nextId in sync with restored rows
  useEffect(() => {
    if (rows.length > 0) {
      const maxId = Math.max(...rows.map((r) => r.id));
      if (maxId >= nextId) nextId = maxId + 1;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist to localStorage + sync URL on every row change
  useEffect(() => {
    saveFillState(rows, selected, dirty);
    const next = new URLSearchParams(window.location.search);
    next.set("tab", "fill");
    if (rows.length > 0) {
      const csv = rowsToCsv(rows);
      const compressed = deflate(new TextEncoder().encode(csv));
      const b64 = btoa(String.fromCharCode(...compressed))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      next.set("data", b64);
    } else {
      next.delete("data");
    }
    setSearchParams(next, { replace: true });
  }, [rows, selected, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const [dbRows, setDbRows] = useState<BeaconRow[]>([]);

  // Load existing beacons from DB on mount
  useEffect(() => {
    fetchBeacons().then((fetched) => {
      setDbRows(fetched);
      setExistingKeys(new Set(fetched.map((r) => `${r.Major}:${r.Minor}`)));
    });
  }, []);

  const handleFilterChange = useCallback(
    (col: keyof Omit<BeaconRow, "id">, value: string) => {
      setFilters((prev) => ({ ...prev, [col]: value }));
    },
    [],
  );

  const handleToggle = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback((ids: number[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const handleParsed = useCallback((parsed: BeaconRow[]) => {
    setOriginalRows(parsed.map((r) => ({ ...r })));
    setRows(parsed);
    setSelected(new Set(parsed.map((r) => r.id)));
    setDirty(true);
  }, []);

  const handleRevert = useCallback(() => {
    if (!originalRows) return;
    const reverted = originalRows.map((r) => ({ ...r }));
    setRows(reverted);
    setSelected(new Set(reverted.map((r) => r.id)));
    setDirty(true);
  }, [originalRows]);

  const handleCellChange = useCallback(
    (id: number, col: keyof Omit<BeaconRow, "id">, value: string) => {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, [col]: value } : r)),
      );
      setDirty(true);
    },
    [],
  );

  const handleMassEdit = useCallback(
    (field: MassEditField, value: string) => {
      const col: keyof Omit<BeaconRow, "id"> =
        field === "Zone" ? "Comment" : field as keyof Omit<BeaconRow, "id">;
      setRows((prev) => prev.map((r) => ({ ...r, [col]: value })));
      setDirty(true);
    },
    [],
  );

  const selectedCount = selected.size;

  const handleSave = useCallback(async () => {
    setSaving(true);
    const toSave = rows.filter((r) => selected.has(r.id));
    const saved = await saveAllBeacons(toSave, "replace");
    setRows(saved);
    setSelected(new Set(saved.map((r) => r.id)));
    setDirty(false);
    setSaving(false);
  }, [rows, selected]);

  const handleClear = useCallback(() => {
    setRows([]);
    setSelected(new Set());
    setDirty(false);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const handleCopyUrl = useCallback(() => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  return (
    <>
      <TileMap rows={rows} dbRows={dbRows} onUpdateRow={(id, updates) => {
        setRows((prev) => prev.map((r) => r.id === id ? { ...r, ...updates } : r));
        setDirty(true);
      }} onAddRow={(row) => {
        setRows((prev) => [...prev, row]);
        setSelected((prev) => new Set(prev).add(row.id));
        setDirty(true);
      }} onRemoveRow={(id) => {
        setRows((prev) => prev.filter((r) => r.id !== id));
        setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
        setDirty(true);
      }} />
      <CsvUploader onParsed={handleParsed} />
      {rows.length > 0 && (
        <>
          <div className="bb-actions">
            <MassEditToolbar onApply={handleMassEdit} />
            <button
              className="bb-save-btn"
              disabled={!dirty || saving}
              onClick={handleSave}
            >
              {saving ? "Saving..." : dirty ? `Save ${selectedCount} to DB` : "Saved"}
            </button>
            {originalRows && (
              <button className="bb-clear-btn" onClick={handleRevert}>
                Revert
              </button>
            )}
            <button className="bb-clear-btn" onClick={handleCopyUrl}>
              {copied ? "Copied!" : "Copy URL"}
            </button>
            <button className="bb-clear-btn" onClick={handleClear}>
              Clear
            </button>
          </div>
          <p className="bb-count">
            {rows.length} beacons loaded
            {selectedCount < rows.length && ` \u00b7 ${selectedCount} selected`}
          </p>
          <BeaconTable
            rows={rows}
            filters={filters}
            selected={selected}
            existingKeys={existingKeys}
            onFilterChange={handleFilterChange}
            onCellChange={handleCellChange}
            onToggle={handleToggle}
            onToggleAll={handleToggleAll}
            onAddRow={() => {
              const newRow = emptyRow();
              setRows((prev) => [...prev, newRow]);
              setSelected((prev) => new Set(prev).add(newRow.id));
              setDirty(true);
            }}
            onDeleteRow={(id) => {
              setRows((prev) => prev.filter((r) => r.id !== id));
              setSelected((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
              setDirty(true);
            }}
          />
        </>
      )}
    </>
  );
}

// ── Tile Map ────────────────────────────────────────────────────────────────

interface FloorDef {
  floorNumber: number;
  maptilerUrl: string;
}

interface ZoneDef {
  id: string;
  name: string;
  floors: FloorDef[];
}

interface MapJson {
  zones: ZoneDef[];
}

function TileMap({ rows, dbRows, onUpdateRow, onAddRow, onRemoveRow }: {
  rows: BeaconRow[];
  dbRows: BeaconRow[];
  onUpdateRow?: (id: number, updates: Partial<Omit<BeaconRow, "id">>) => void;
  onAddRow?: (row: BeaconRow) => void;
  onRemoveRow?: (id: number) => void;
}) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const onUpdateRowRef = useRef(onUpdateRow);
  onUpdateRowRef.current = onUpdateRow;
  const dragStateRef = useRef<{ id: number; source: string; active: boolean; startX: number; startY: number } | null>(null);
  const geojsonDataRef = useRef<Record<string, GeoJSON.FeatureCollection>>({});
  const onAddRowRef = useRef(onAddRow);
  onAddRowRef.current = onAddRow;
  const onRemoveRowRef = useRef(onRemoveRow);
  onRemoveRowRef.current = onRemoveRow;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; lngLat: [number, number]; poiId?: number; poiSource?: string } | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Read initial map options from URL
  const params = new URLSearchParams(window.location.search);
  const initZone = params.get("zone") ?? "";
  const initFloor = params.get("floor") ? Number(params.get("floor")) : 0;
  const initBeaconZone = params.get("bzone") ?? "all";
  const initBeaconFloor = params.get("bfloor") ?? "all";
  const initCollapsed = params.get("mapcol") === "1";
  const initAreaVerts = (() => {
    try {
      const raw = params.get("area");
      if (!raw) return [];
      return JSON.parse(raw) as Coord[];
    } catch { return []; }
  })();
  const initAreaKante = (params.get("kante") ?? "south") as Kante;

  const [zones, setZones] = useState<string[]>([]);
  const [selectedZone, setSelectedZone] = useState<string>(initZone);
  const [mapData, setMapData] = useState<MapJson | null>(null);
  const [selectedFloor, setSelectedFloor] = useState<number>(initFloor);
  const [beaconFloorFilter, setBeaconFloorFilter] = useState<string>(initBeaconFloor);
  const [beaconZoneFilter, setBeaconZoneFilter] = useState<string>(initBeaconZone);
  const [collapsed, setCollapsed] = useState(initCollapsed);
  const lastBoundsRef = useRef<[number, number, number, number] | null>(null);

  // Persist all map options to URL
  useEffect(() => {
    if (!selectedZone) return;
    const next = new URLSearchParams(window.location.search);
    next.set("zone", selectedZone);
    next.set("floor", String(selectedFloor));
    if (beaconZoneFilter !== "all") next.set("bzone", beaconZoneFilter); else next.delete("bzone");
    if (beaconFloorFilter !== "all") next.set("bfloor", beaconFloorFilter); else next.delete("bfloor");
    if (collapsed) next.set("mapcol", "1"); else next.delete("mapcol");
    window.history.replaceState(null, "", `?${next.toString()}`);
  }, [selectedZone, selectedFloor, beaconZoneFilter, beaconFloorFilter, collapsed]);

  // Load available zones
  useEffect(() => {
    fetch("/api/beacon-boy/zones")
      .then((r) => r.json())
      .then((dirs: string[]) => {
        setZones(dirs);
        if (dirs.length > 0 && !selectedZone) setSelectedZone(dirs[0]);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load zone map.json when zone changes
  useEffect(() => {
    if (!selectedZone) return;
    fetch(`/api/beacon-boy/zones/${selectedZone}`)
      .then((r) => r.json())
      .then((data: MapJson) => {
        setMapData(data);
        const floors = data.zones[0]?.floors ?? [];
        if (floors.length > 0 && !floors.some((f) => f.floorNumber === selectedFloor)) {
          setSelectedFloor(floors[0].floorNumber);
        }
      });
  }, [selectedZone]);

  // Initialize map with real-world satellite/streets base
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    // Fetch the key from the API (already loaded zone data has it, but we need it for base style)
    fetch("/api/beacon-boy/zones/" + (initZone || "skrapid"))
      .then((r) => r.json())
      .then(async (data: MapJson) => {
        const floor = data.zones[0]?.floors.find((f) => f.floorNumber === initFloor) ?? data.zones[0]?.floors[0];
        const keyMatch = floor?.maptilerUrl.match(/key=([^&]+)/);
        const key = keyMatch ? keyMatch[1] : "";

        // Fetch tile bounds to center the map on the maptile
        let initCenter: [number, number] = [16.3, 48.2];
        let initBounds: [number, number, number, number] | null = null;
        if (floor) {
          const uuidMatch = floor.maptilerUrl.match(/tiles\/([0-9a-f-]+)\//);
          if (uuidMatch) {
            try {
              const tilesJson = await fetch(`https://api.maptiler.com/tiles/${uuidMatch[1]}/tiles.json?key=${key}`).then((r) => r.json());
              if (tilesJson.bounds) {
                initBounds = tilesJson.bounds;
                initCenter = [(tilesJson.bounds[0] + tilesJson.bounds[2]) / 2, (tilesJson.bounds[1] + tilesJson.bounds[3]) / 2];
                lastBoundsRef.current = tilesJson.bounds;
              }
            } catch { /* ignore */ }
          }
        }

        const map = new maplibregl.Map({
          container: mapContainer.current!,
          style: `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${key}`,
          center: initCenter,
          zoom: 15,
        });

        if (initBounds) {
          map.once("style.load", () => {
            map.fitBounds([[initBounds![0], initBounds![1]], [initBounds![2], initBounds![3]]], { padding: 20, duration: 0 });
          });
        }

        map.addControl(new maplibregl.NavigationControl(), "top-right");

        // Right-click context menu — detect if on a CSV POI
        map.on("contextmenu", (e) => {
          e.preventDefault();
          const rect = map.getContainer().getBoundingClientRect();
          const menu: { x: number; y: number; lngLat: [number, number]; poiId?: number; poiSource?: string } = {
            x: e.point.x + rect.left,
            y: e.point.y + rect.top,
            lngLat: [e.lngLat.lng, e.lngLat.lat],
          };
          // Check if right-clicking on a CSV POI
          const features = map.queryRenderedFeatures(e.point, { layers: ["csv-pois-circle"] });
          if (features.length > 0) {
            menu.poiId = Number(features[0].properties!.id);
            menu.poiSource = "csv";
          }
          setCtxMenu(menu);
        });

        // Dismiss context menu on click; shift+click adds beacon
        map.on("click", (e) => {
          setCtxMenu(null);
          if (e.originalEvent.altKey && onAddRowRef.current) {
            const newRow = emptyRow();
            newRow.Latitude = String(e.lngLat.lat);
            newRow.Longitude = String(e.lngLat.lng);
            onAddRowRef.current(newRow);
          }
        });

        map.once("style.load", () => setMapReady(true));
        mapRef.current = map;
      });

    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update tile layer when floor or map data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapData) return;

    const zone = mapData.zones[0];
    if (!zone) return;

    const floor = zone.floors.find((f: FloorDef) => f.floorNumber === selectedFloor);
    if (!floor) return;

    const tileUrl = floor.maptilerUrl;
    const uuidMatch = tileUrl.match(/tiles\/([0-9a-f-]+)\//);

    const applyTileLayer = (bounds?: [number, number, number, number]) => {
      if (map.getLayer("floor-tiles")) map.removeLayer("floor-tiles");
      if (map.getSource("floor-tiles")) map.removeSource("floor-tiles");

      map.addSource("floor-tiles", {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
        ...(bounds ? { bounds } : {}),
      });
      map.addLayer({
        id: "floor-tiles",
        type: "raster",
        source: "floor-tiles",
        paint: {
          "raster-opacity": 1,
          "raster-brightness-min": 0.5,
          "raster-brightness-max": 1,
          "raster-contrast": 0.6,
          "raster-saturation": -0.8,
        },
      });

      // Move POI layers on top of tile layer
      for (const id of ["db-pois-circle", "db-pois-label", "csv-pois-circle", "csv-pois-label"]) {
        if (map.getLayer(id)) map.moveLayer(id);
      }

      if (bounds) {
        lastBoundsRef.current = bounds;
        map.fitBounds(
          [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
          { padding: 20, duration: 500 },
        );
      }
    };

    const run = () => {
      if (uuidMatch) {
        const keyMatch = tileUrl.match(/key=([^&]+)/);
        const key = keyMatch ? keyMatch[1] : "";
        fetch(`https://api.maptiler.com/tiles/${uuidMatch[1]}/tiles.json?key=${key}`)
          .then((r) => r.json())
          .then((tilesJson) => {
            const b = tilesJson.bounds as [number, number, number, number] | undefined;
            applyTileLayer(b);
          })
          .catch(() => applyTileLayer());
      } else {
        applyTileLayer();
      }
    };

    if (!mapReady) return;
    run();
  }, [mapData, selectedFloor, mapReady]);

  // Show DB rows (green) and CSV rows (salmon) as POI markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const toGeojson = (items: BeaconRow[], source: string): GeoJSON.FeatureCollection => ({
      type: "FeatureCollection",
      features: items
        .filter((r) => {
          const lat = parseFloat(r.Latitude);
          const lng = parseFloat(r.Longitude);
          if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return false;
          if (beaconFloorFilter !== "all" && r.Floor !== beaconFloorFilter) return false;
          if (beaconZoneFilter !== "all" && r.ZoneId !== beaconZoneFilter) return false;
          return true;
        })
        .map((r) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [parseFloat(r.Longitude), parseFloat(r.Latitude)] },
          properties: {
            id: r.id, source, Major: r.Major, Minor: r.Minor,
            Building: r.Building, Floor: r.Floor, ExactPos1: r.ExactPos1,
            ExactPos2: r.ExactPos2, Strength: r.Strength, ZoneId: r.ZoneId, Comment: r.Comment,
          },
        })),
    });

    const editableFields: (keyof Omit<BeaconRow, "id">)[] = [
      "Major", "Minor", "Building", "Floor", "ExactPos1", "ExactPos2",
      "Strength", "ZoneId", "Comment",
    ];

    const showPopup = (coords: [number, number], p: Record<string, unknown>, color: string, source: string) => {
      const label = source === "db" ? "DB" : "CSV";
      const canEdit = !!onUpdateRowRef.current;
      const mandatorySet = new Set(["Major", "Minor", "Building", "Floor", "ExactPos1", "ZoneId"]);
      const inputRows = editableFields.map((f) => {
        const val = String(p[f] ?? "");
        const isMissing = mandatorySet.has(f) && !val;
        return `<div class="bb-poi-field${isMissing ? " bb-poi-field--missing" : ""}">
          <label>${f}${mandatorySet.has(f) ? " *" : ""}</label>
          ${canEdit
            ? `<input type="text" data-field="${f}" value="${val.replace(/"/g, "&quot;")}" />`
            : `<span>${val}</span>`
          }
        </div>`;
      }).join("");

      const html = `<div class="bb-poi-popup">
        <div class="bb-poi-header">
          <strong>${p.Major}:${p.Minor}</strong>
          <span style="color:${color};font-size:0.75rem">${label}</span>
        </div>
        ${inputRows}
        <div class="bb-poi-coords">${coords[1].toFixed(6)}, ${coords[0].toFixed(6)}</div>
        ${canEdit ? `<div class="bb-poi-actions">
          <button class="bb-poi-save" data-id="${p.id}">Save</button>
          ${source === "csv" ? `<button class="bb-poi-delete" data-id="${p.id}">Delete</button>` : ""}
          <span class="bb-poi-drag-hint">Drag circle to move</span>
        </div>` : ""}
      </div>`;

      if (popupRef.current) popupRef.current.remove();
      const popup = new maplibregl.Popup({ offset: 12, maxWidth: "300px" })
        .setLngLat(coords).setHTML(html).addTo(map);
      popupRef.current = popup;

      // Wire save button
      if (canEdit) {
        const el = popup.getElement();
        const saveBtn = el?.querySelector(".bb-poi-save");
        saveBtn?.addEventListener("click", () => {
          const id = Number((saveBtn as HTMLElement).dataset.id);
          const updates: Record<string, string> = {};
          el?.querySelectorAll<HTMLInputElement>("input[data-field]").forEach((inp) => {
            updates[inp.dataset.field!] = inp.value;
          });
          // Read current popup position (may have been dragged)
          const currentLngLat = popup.getLngLat();
          updates.Latitude = String(currentLngLat.lat);
          updates.Longitude = String(currentLngLat.lng);
          onUpdateRowRef.current?.(id, updates);
          popup.remove();
        });

        const deleteBtn = el?.querySelector(".bb-poi-delete");
        deleteBtn?.addEventListener("click", () => {
          const id = Number((deleteBtn as HTMLElement).dataset.id);
          onRemoveRowRef.current?.(id);
          popup.remove();
        });
      }
    };

    const addPoiLayer = (
      name: string, data: GeoJSON.FeatureCollection, color: string, source: string,
    ) => {
      geojsonDataRef.current[name] = data;
      if (map.getSource(name)) {
        (map.getSource(name) as maplibregl.GeoJSONSource).setData(data);
        return;
      }
      map.addSource(name, { type: "geojson", data });
      map.addLayer({
        id: `${name}-circle`, type: "circle", source: name,
        paint: { "circle-radius": 7, "circle-color": color, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });
      map.addLayer({
        id: `${name}-label`, type: "symbol", source: name,
        layout: {
          "text-field": ["concat", ["get", "Major"], ":", ["get", "Minor"]],
          "text-size": 11, "text-offset": [0, 1.5], "text-anchor": "top",
        },
        paint: { "text-color": "#ccc", "text-halo-color": "#111", "text-halo-width": 1 },
      });

      // Click → editable popup (skip shift+click which adds beacon)
      map.on("click", `${name}-circle`, (e) => {
        if (dragStateRef.current) return;
        if (e.originalEvent.altKey) return;
        if (!e.features || e.features.length === 0) return;
        const f = e.features[0];
        const coords = (f.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
        showPopup(coords, f.properties!, color, source);
      });

      // Drag support
      map.on("mousedown", `${name}-circle`, (e) => {
        if (!onUpdateRowRef.current) return;
        if (!e.features || e.features.length === 0) return;
        e.preventDefault();
        const f = e.features[0];
        const point = e.point;
        dragStateRef.current = {
          id: Number(f.properties!.id), source: name,
          active: false, startX: point.x, startY: point.y,
        };
      });

      map.on("mouseenter", `${name}-circle`, () => {
        if (!dragStateRef.current) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", `${name}-circle`, () => {
        if (!dragStateRef.current?.active) map.getCanvas().style.cursor = "";
      });
    };

    // Global drag handlers (only set up once via a flag)
    if (!(map as unknown as Record<string, boolean>).__bbDragSetup) {
      (map as unknown as Record<string, boolean>).__bbDragSetup = true;

      const DRAG_THRESHOLD = 5;

      map.on("mousemove", (e) => {
        const drag = dragStateRef.current;
        if (!drag) return;

        // Check threshold before activating drag
        if (!drag.active) {
          const dx = e.point.x - drag.startX;
          const dy = e.point.y - drag.startY;
          if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
          drag.active = true;
          map.getCanvas().style.cursor = "grabbing";
          // Make popup see-through during drag
          if (popupRef.current) {
            popupRef.current.getElement()?.classList.add("bb-popup-dragging");
          }
        }

        // Move popup along with the POI
        if (popupRef.current) {
          popupRef.current.setLngLat([e.lngLat.lng, e.lngLat.lat]);
          const coordsEl = popupRef.current.getElement()?.querySelector(".bb-poi-coords");
          if (coordsEl) coordsEl.textContent = `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`;
        }

        // Move POI circle
        const geoData = geojsonDataRef.current[drag.source];
        if (geoData) {
          const feat = geoData.features.find((f) => Number(f.properties?.id) === drag.id);
          if (feat && feat.geometry.type === "Point") {
            feat.geometry.coordinates = [e.lngLat.lng, e.lngLat.lat];
            const src = map.getSource(drag.source) as maplibregl.GeoJSONSource | undefined;
            if (src) src.setData(geoData);
          }
        }
      });

      map.on("mouseup", (e) => {
        const drag = dragStateRef.current;
        if (!drag) return;
        dragStateRef.current = null;
        map.getCanvas().style.cursor = "";
        if (drag.active) {
          // Remove dragging transparency
          if (popupRef.current) {
            popupRef.current.getElement()?.classList.remove("bb-popup-dragging");
            // Update coordinates display in popup
            const coordsEl = popupRef.current.getElement()?.querySelector(".bb-poi-coords");
            if (coordsEl) coordsEl.textContent = `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`;
          }
          onUpdateRowRef.current?.(drag.id, {
            Latitude: String(e.lngLat.lat),
            Longitude: String(e.lngLat.lng),
          });
        }
      });
    }

    const addAll = () => {
      addPoiLayer("db-pois", toGeojson(dbRows, "db"), "#4caf50", "db");
      addPoiLayer("csv-pois", toGeojson(rows, "csv"), "#fa8072", "csv");
    };

    addAll();
  }, [rows, dbRows, mapData, selectedFloor, beaconFloorFilter, beaconZoneFilter, mapReady]);

  // Collect unique floor and zoneId values from both row sets for filter dropdowns
  const allBeacons = [...rows, ...dbRows];
  const beaconFloors = [...new Set(allBeacons.map((r) => r.Floor).filter(Boolean))].sort(
    (a, b) => Number(a) - Number(b),
  );
  const beaconZoneIds = [...new Set(allBeacons.map((r) => r.ZoneId).filter(Boolean))].sort();

  // ── Area Select Tool (polygon) ────────────────────────────────────────
  type Coord = [number, number]; // [lng, lat]
  type Kante = "north" | "south" | "east" | "west";

  const [areaMode, setAreaMode] = useState(false);
  const [areaVertices, setAreaVertices] = useState<Coord[]>(initAreaVerts);
  const [areaClosed, setAreaClosed] = useState(initAreaVerts.length >= 3);
  const initGridRows = params.get("grows") ? Number(params.get("grows")) : 3;
  const initGridCols = params.get("gcols") ? Number(params.get("gcols")) : 3;
  const [gridRows, setGridRows] = useState(initGridRows);
  const [gridCols, setGridCols] = useState(initGridCols);
  const [gridKante, setGridKante] = useState<Kante>(initAreaKante);
  const areaClickRef = useRef<((e: maplibregl.MapMouseEvent) => void) | null>(null);

  // Persist area to URL
  useEffect(() => {
    const next = new URLSearchParams(window.location.search);
    if (areaVertices.length >= 3 && areaClosed) {
      next.set("area", JSON.stringify(areaVertices.map(([lng, lat]) => [+lng.toFixed(7), +lat.toFixed(7)])));
      next.set("kante", gridKante);
      next.set("grows", String(gridRows));
      next.set("gcols", String(gridCols));
    } else {
      next.delete("area");
      next.delete("kante");
      next.delete("grows");
      next.delete("gcols");
    }
    window.history.replaceState(null, "", `?${next.toString()}`);
  }, [areaVertices, areaClosed, gridKante, gridRows, gridCols]);

  const CLOSE_THRESHOLD = 15; // pixels

  // Handle map clicks for polygon drawing
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (areaClickRef.current) {
      map.off("click", areaClickRef.current);
      areaClickRef.current = null;
    }

    if (!areaMode || areaClosed) return;

    const handler = (e: maplibregl.MapMouseEvent) => {
      if (e.originalEvent.altKey) return; // shift+click adds beacon, not vertex
      setAreaVertices((prev) => {
        // Check if clicking near the first vertex to close
        if (prev.length >= 3) {
          const first = map.project(new maplibregl.LngLat(prev[0][0], prev[0][1]));
          const click = e.point;
          const dist = Math.sqrt((first.x - click.x) ** 2 + (first.y - click.y) ** 2);
          if (dist < CLOSE_THRESHOLD) {
            setAreaClosed(true);
            return prev;
          }
        }
        return [...prev, [e.lngLat.lng, e.lngLat.lat]];
      });
    };
    areaClickRef.current = handler;
    map.on("click", handler);

    return () => { map.off("click", handler); areaClickRef.current = null; };
  }, [areaMode, areaClosed]);

  // Get the 4 quad corners from polygon vertices, rotated by Kante.
  // Vertices are expected in order: bottom-left, bottom-right, top-right, top-left (CCW from bottom-left).
  // Kante rotates which vertex is the origin (0:0).
  const getQuadCorners = useCallback((): { c00: Coord; c01: Coord; c10: Coord; c11: Coord } | null => {
    if (areaVertices.length < 3 || !areaClosed) return null;
    // Use first 4 vertices (or 3 with 4th as midpoint)
    const verts = areaVertices.length >= 4
      ? areaVertices.slice(0, 4)
      : [...areaVertices, [(areaVertices[0][0] + areaVertices[2][0]) / 2, (areaVertices[0][1] + areaVertices[2][1]) / 2] as Coord];

    // Rotate based on Kante: south=0, west=1, north=2, east=3
    const rotations: Record<Kante, number> = { south: 0, west: 1, north: 2, east: 3 };
    const rot = rotations[gridKante];
    const rotated = [...verts.slice(rot), ...verts.slice(0, rot)];

    // c00=origin (row 0, col 0), c01=col end (row 0, col max), c10=row end (row max, col 0), c11=opposite
    return { c00: rotated[0], c01: rotated[1], c11: rotated[2], c10: rotated[3] };
  }, [areaVertices, areaClosed, gridKante]);

  // Draw polygon + grid on map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const LAYERS = ["area-poly", "area-poly-outline", "area-verts", "area-grid-lines", "area-grid-points", "area-grid-labels", "area-kante"];
    const SOURCES = ["area-poly-src", "area-verts-src", "area-grid-src", "area-grid-pts-src", "area-kante-src"];
    for (const id of LAYERS) { if (map.getLayer(id)) map.removeLayer(id); }
    for (const id of SOURCES) { if (map.getSource(id)) map.removeSource(id); }

    if (areaVertices.length < 1) return;

    // Draw vertices
    const vertFeatures: GeoJSON.Feature[] = areaVertices.map((v, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: v },
      properties: { idx: i, first: i === 0 },
    }));
    map.addSource("area-verts-src", { type: "geojson", data: { type: "FeatureCollection", features: vertFeatures } });
    map.addLayer({
      id: "area-verts", type: "circle", source: "area-verts-src",
      paint: {
        "circle-radius": ["case", ["get", "first"], 8, 5],
        "circle-color": ["case", ["get", "first"], "#ffb74d", "#7c9aff"],
        "circle-stroke-color": "#fff", "circle-stroke-width": 2,
      },
    });

    // Draw polygon outline (or open polyline)
    if (areaVertices.length >= 2) {
      const coords = areaClosed
        ? [...areaVertices, areaVertices[0]]
        : areaVertices;

      const polyFeature: GeoJSON.Feature = areaClosed
        ? { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {} }
        : { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} };

      map.addSource("area-poly-src", { type: "geojson", data: { type: "FeatureCollection", features: [polyFeature] } });
      if (areaClosed) {
        map.addLayer({
          id: "area-poly", type: "fill", source: "area-poly-src",
          paint: { "fill-color": "#7c9aff", "fill-opacity": 0.1 },
        });
      }
      map.addLayer({
        id: "area-poly-outline", type: "line", source: "area-poly-src",
        paint: { "line-color": "#7c9aff", "line-width": 2, "line-dasharray": [4, 2] },
      });
    }

    // Grid (only when polygon is closed, uses bilinear interpolation across quad)
    const quad = getQuadCorners();
    if (quad && gridRows >= 1 && gridCols >= 1) {
      const { c00, c01, c10, c11 } = quad;
      const lines: GeoJSON.Feature[] = [];
      const points: GeoJSON.Feature[] = [];

      // Bilinear interpolation across the quad
      const gridPt = (r: number, c: number): Coord => {
        const u = gridCols === 0 ? 0 : c / gridCols;  // col fraction
        const v = gridRows === 0 ? 0 : r / gridRows;  // row fraction
        const lng = (1 - u) * (1 - v) * c00[0] + u * (1 - v) * c01[0] + u * v * c11[0] + (1 - u) * v * c10[0];
        const lat = (1 - u) * (1 - v) * c00[1] + u * (1 - v) * c01[1] + u * v * c11[1] + (1 - u) * v * c10[1];
        return [lng, lat];
      };

      for (let r = 0; r <= gridRows; r++) {
        for (let c = 0; c <= gridCols; c++) {
          const [lng, lat] = gridPt(r, c);
          points.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [lng, lat] },
            properties: { row: r, col: c, label: c === 0 ? `${r}:${c}` : "" },
          });
        }
      }

      for (let r = 0; r <= gridRows; r++) {
        const coords: Coord[] = [];
        for (let c = 0; c <= gridCols; c++) coords.push(gridPt(r, c));
        lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });
      }
      for (let c = 0; c <= gridCols; c++) {
        const coords: Coord[] = [];
        for (let r = 0; r <= gridRows; r++) coords.push(gridPt(r, c));
        lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });
      }

      map.addSource("area-grid-src", { type: "geojson", data: { type: "FeatureCollection", features: lines } });
      map.addLayer({ id: "area-grid-lines", type: "line", source: "area-grid-src", paint: { "line-color": "#ffb74d", "line-width": 1, "line-opacity": 0.6 } });
      map.addSource("area-grid-pts-src", { type: "geojson", data: { type: "FeatureCollection", features: points } });
      map.addLayer({ id: "area-grid-points", type: "circle", source: "area-grid-pts-src", paint: { "circle-radius": 2, "circle-color": "#ffb74d", "circle-stroke-color": "#fff", "circle-stroke-width": 0.5 } });
      map.addLayer({ id: "area-grid-labels", type: "symbol", source: "area-grid-pts-src", layout: { "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, -1.2], "text-anchor": "bottom" }, paint: { "text-color": "#ffb74d", "text-halo-color": "#111", "text-halo-width": 1 } });

      // Draw selected Kante edge in bright red
      const kanteFeature: GeoJSON.Feature = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [c00, c01] },
        properties: {},
      };
      map.addSource("area-kante-src", { type: "geojson", data: { type: "FeatureCollection", features: [kanteFeature] } });
      map.addLayer({
        id: "area-kante", type: "line", source: "area-kante-src",
        paint: { "line-color": "#ff3333", "line-width": 4, "line-opacity": 0.9 },
      });
    }

    // Vertex drag support (when polygon is closed)
    if (areaClosed && !(map as unknown as Record<string, boolean>).__bbVertDragSetup) {
      (map as unknown as Record<string, boolean>).__bbVertDragSetup = true;
      let draggingVertIdx: number | null = null;

      map.on("mousedown", "area-verts", (e) => {
        if (!e.features || e.features.length === 0) return;
        e.preventDefault();
        draggingVertIdx = Number(e.features[0].properties!.idx);
        map.getCanvas().style.cursor = "grabbing";
      });

      map.on("mousemove", (e) => {
        if (draggingVertIdx === null) return;
        setAreaVertices((prev) => {
          const next = [...prev];
          next[draggingVertIdx!] = [e.lngLat.lng, e.lngLat.lat];
          return next;
        });
      });

      map.on("mouseup", () => {
        if (draggingVertIdx === null) return;
        draggingVertIdx = null;
        map.getCanvas().style.cursor = "";
      });

      map.on("mouseenter", "area-verts", () => {
        if (draggingVertIdx === null) map.getCanvas().style.cursor = "grab";
      });
      map.on("mouseleave", "area-verts", () => {
        if (draggingVertIdx === null) map.getCanvas().style.cursor = "";
      });
    }
  }, [areaVertices, areaClosed, gridRows, gridCols, gridKante, getQuadCorners, mapReady]);

  const clearArea = useCallback(() => {
    setAreaVertices([]);
    setAreaClosed(false);
    setAreaMode(false);
    const map = mapRef.current;
    if (!map) return;
    for (const id of ["area-poly", "area-poly-outline", "area-verts", "area-grid-lines", "area-grid-points", "area-grid-labels"]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of ["area-poly-src", "area-verts-src", "area-grid-src", "area-grid-pts-src"]) {
      if (map.getSource(id)) map.removeSource(id);
    }
  }, []);

  const generateGridRows = useCallback(() => {
    const quad = getQuadCorners();
    if (!quad) return;
    const { c00, c01, c10, c11 } = quad;

    const gridPt = (r: number, c: number): Coord => {
      const u = gridCols === 0 ? 0 : c / gridCols;
      const v = gridRows === 0 ? 0 : r / gridRows;
      const lng = (1 - u) * (1 - v) * c00[0] + u * (1 - v) * c01[0] + u * v * c11[0] + (1 - u) * v * c10[0];
      const lat = (1 - u) * (1 - v) * c00[1] + u * (1 - v) * c01[1] + u * v * c11[1] + (1 - u) * v * c10[1];
      return [lng, lat];
    };

    const newRows: BeaconRow[] = [];
    for (let r = 0; r <= gridRows; r++) {
      for (let c = 0; c <= gridCols; c++) {
        const [lng, lat] = gridPt(r, c);
        newRows.push({ ...emptyRow(), ExactPos1: `R${r}`, ExactPos2: `C${c}`, Latitude: String(lat), Longitude: String(lng) });
      }
    }
    return newRows;
  }, [getQuadCorners, gridRows, gridCols]);

  const currentZone = mapData?.zones[0];
  const floors = currentZone?.floors ?? [];

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      if (prev && mapRef.current) {
        setTimeout(() => {
          mapRef.current?.resize();
          const b = lastBoundsRef.current;
          if (b && mapRef.current) {
            mapRef.current.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 20, duration: 300 });
          }
        }, 0);
      }
      return !prev;
    });
  }, []);

  return (
    <div className="bb-map-section">
      <div className="bb-map-controls">
        <span className="bb-map-group-label">Maptile</span>
        <span className="bb-map-sep">&rsaquo;</span>
        <select value={selectedZone} onChange={(e) => setSelectedZone(e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
        {floors.length > 0 && (
          <select
            value={selectedFloor}
            onChange={(e) => setSelectedFloor(Number(e.target.value))}
          >
            {floors.map((f) => (
              <option key={f.floorNumber} value={f.floorNumber}>
                Floor {f.floorNumber}
              </option>
            ))}
          </select>
        )}

        <span className="bb-map-divider" />

        <span className="bb-map-group-label">Beacons</span>
        <span className="bb-map-sep">&rsaquo;</span>
        <select
          value={beaconZoneFilter}
          onChange={(e) => setBeaconZoneFilter(e.target.value)}
        >
          <option value="all">All zones</option>
          {beaconZoneIds.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
        <select
          value={beaconFloorFilter}
          onChange={(e) => setBeaconFloorFilter(e.target.value)}
        >
          <option value="all">All floors</option>
          {beaconFloors.map((f) => (
            <option key={f} value={f}>Floor {f}</option>
          ))}
        </select>

        <span className="bb-map-divider" />

        <button
          className={`bb-area-btn ${areaMode ? "bb-area-btn--active" : ""}`}
          onClick={() => { setAreaMode(!areaMode); if (areaMode) clearArea(); }}
        >
          {areaMode ? "Cancel Area" : "Area Select"}
        </button>

        <button className="bb-collapse-btn" onClick={toggleCollapsed}>
          {collapsed ? "Enlarge" : "Collapse"}
        </button>
      </div>
      {areaClosed && (
        <div className="bb-area-panel">
          <label>Rows:</label>
          <input type="number" min={1} max={50} value={gridRows} onChange={(e) => setGridRows(Number(e.target.value))} />
          <label>Cols:</label>
          <input type="number" min={1} max={50} value={gridCols} onChange={(e) => setGridCols(Number(e.target.value))} />
          <label>Align to Kante:</label>
          <select value={gridKante} onChange={(e) => setGridKante(e.target.value as Kante)}>
            <option value="south">South</option>
            <option value="north">North</option>
            <option value="west">West</option>
            <option value="east">East</option>
          </select>
          <button className="bb-clear-btn" onClick={clearArea}>Clear Area</button>
        </div>
      )}
      {areaMode && !areaClosed && (
        <div className="bb-area-hint">
          {areaVertices.length === 0
            ? "Click to place first vertex"
            : areaVertices.length < 3
              ? `${areaVertices.length} vertices placed — keep clicking to add more`
              : `${areaVertices.length} vertices — click near the first vertex (orange dot) to close`
          }
        </div>
      )}
      <div
        className="bb-map-container"
        ref={mapContainer}
        style={{ display: collapsed ? "none" : undefined }}
      />
      {ctxMenu && (
        <div
          className="bb-ctx-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
        >
          {onAddRow && (
            <button onClick={() => {
              const newRow = emptyRow();
              newRow.Latitude = String(ctxMenu.lngLat[1]);
              newRow.Longitude = String(ctxMenu.lngLat[0]);
              onAddRowRef.current?.(newRow);
              setCtxMenu(null);
            }}>
              Add beacon here
            </button>
          )}
          {ctxMenu.poiSource === "csv" && onRemoveRow && (
            <button className="bb-ctx-danger" onClick={() => {
              onRemoveRowRef.current?.(ctxMenu.poiId!);
              setCtxMenu(null);
            }}>
              Remove beacon
            </button>
          )}
          <div className="bb-ctx-coords">{ctxMenu.lngLat[1].toFixed(6)}, {ctxMenu.lngLat[0].toFixed(6)}</div>
        </div>
      )}
    </div>
  );
}

// ── View Database Tab ───────────────────────────────────────────────────────

async function patchBeacon(id: number, data: Record<string, string>): Promise<void> {
  await fetch(`/api/beacon-boy/beacons/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function deleteBeacon(id: number): Promise<void> {
  await fetch(`/api/beacon-boy/beacons/${id}`, { method: "DELETE" });
}

function RowMenu({
  onEdit,
  onDelete,
  onRevert,
  isEditing,
  isDeleted,
}: {
  onEdit: () => void;
  onDelete: () => void;
  onRevert: () => void;
  isEditing: boolean;
  isDeleted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const toggle = useCallback(() => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 2, left: rect.left });
    }
    setOpen(!open);
  }, [open]);

  return (
    <div className="bb-menu-wrap" ref={wrapRef}>
      <button ref={btnRef} className="bb-menu-trigger" onClick={toggle}>&#x22EE;</button>
      {open && (
        <div className="bb-menu-dropdown" style={{ top: pos.top, left: pos.left }}>
          {!isDeleted && !isEditing && (
            <button onClick={() => { onEdit(); setOpen(false); }}>Edit</button>
          )}
          {!isDeleted && (
            <button className="bb-menu-danger" onClick={() => { onDelete(); setOpen(false); }}>
              Delete
            </button>
          )}
          {(isDeleted || isEditing) && (
            <button onClick={() => { onRevert(); setOpen(false); }}>Revert</button>
          )}
        </div>
      )}
    </div>
  );
}

function ViewTab() {
  const [dbRows, setDbRows] = useState<BeaconRow[]>([]);
  const [rows, setRows] = useState<BeaconRow[]>([]);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [editingIds, setEditingIds] = useState<Set<number>>(new Set());
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [editedIds, setEditedIds] = useState<Set<number>>(new Set());

  const hasPending = deletedIds.size > 0 || editedIds.size > 0;

  useEffect(() => {
    setLoading(true);
    fetchBeacons().then((data) => {
      setDbRows(data);
      setRows(data);
    }).finally(() => setLoading(false));
  }, []);

  const handleFilterChange = useCallback(
    (col: keyof Omit<BeaconRow, "id">, value: string) => {
      setFilters((prev) => ({ ...prev, [col]: value }));
    },
    [],
  );

  const reload = useCallback(() => {
    setLoading(true);
    setEditingIds(new Set());
    setDeletedIds(new Set());
    setEditedIds(new Set());
    fetchBeacons().then((data) => {
      setDbRows(data);
      setRows(data);
    }).finally(() => setLoading(false));
  }, []);

  const handleEdit = useCallback((id: number) => {
    setEditingIds((prev) => new Set(prev).add(id));
  }, []);

  const handleDelete = useCallback((id: number) => {
    setDeletedIds((prev) => new Set(prev).add(id));
    setEditingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleRevert = useCallback((id: number) => {
    // Restore original row from dbRows
    const original = dbRows.find((r) => r.id === id);
    if (original) {
      setRows((prev) => prev.map((r) => (r.id === id ? original : r)));
    }
    setDeletedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setEditingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setEditedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [dbRows]);

  const handleCellChange = useCallback(
    (id: number, col: keyof Omit<BeaconRow, "id">, value: string) => {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, [col]: value } : r)),
      );
      setEditedIds((prev) => new Set(prev).add(id));
    },
    [],
  );

  const handleCommit = useCallback(async () => {
    setCommitting(true);
    // Delete marked rows
    for (const id of deletedIds) {
      await deleteBeacon(id);
    }
    // Patch edited rows (that aren't also deleted)
    for (const id of editedIds) {
      if (deletedIds.has(id)) continue;
      const row = rows.find((r) => r.id === id);
      if (row) await patchBeacon(id, row as unknown as Record<string, string>);
    }
    // Reload fresh state
    const fresh = await fetchBeacons();
    setDbRows(fresh);
    setRows(fresh);
    setDeletedIds(new Set());
    setEditedIds(new Set());
    setEditingIds(new Set());
    setCommitting(false);
  }, [rows, deletedIds, editedIds]);

  const filtered = filterRows(rows, filters);

  if (loading) return <p className="bb-count">Loading database...</p>;
  if (dbRows.length === 0) return <p className="bb-count">Database is empty.</p>;

  const pendingCount = deletedIds.size + editedIds.size;

  return (
    <>
      <TileMap rows={[]} dbRows={rows} />
      <div className="bb-actions">
        <p className="bb-count" style={{ margin: 0 }}>
          {rows.length} beacons in database
          {hasPending && ` \u00b7 ${pendingCount} pending change${pendingCount > 1 ? "s" : ""}`}
        </p>
        <button
          className="bb-save-btn"
          disabled={!hasPending || committing}
          onClick={handleCommit}
        >
          {committing ? "Committing..." : "Commit & Persist"}
        </button>
        <button className="bb-reload-btn" onClick={reload}>
          {hasPending ? "Discard & Reload" : "Reload"}
        </button>
      </div>
      <div className="bb-table-wrap">
        <table className="bb-table">
          <thead>
            <tr>
              <th className="bb-menu-cell"></th>
              <th>#</th>
              {COLUMNS.map((col) => (
                <th key={col}>{col}</th>
              ))}
            </tr>
            <tr className="bb-filter-row">
              <th></th>
              <th></th>
              {COLUMNS.map((col) => (
                <th key={col}>
                  <input
                    type="text"
                    className="bb-filter-input"
                    placeholder="Filter..."
                    value={filters[col]}
                    onChange={(e) => handleFilterChange(col, e.target.value)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, idx) => {
              const isDeleted = deletedIds.has(row.id);
              const isEditing = editingIds.has(row.id);
              const isEdited = editedIds.has(row.id);
              const cls = [
                isDeleted && "bb-row-deleted",
                isEdited && !isDeleted && "bb-row-edited",
              ].filter(Boolean).join(" ");
              return (
                <tr key={row.id} className={cls}>
                  <td className="bb-menu-cell">
                    <RowMenu
                      isEditing={isEditing}
                      isDeleted={isDeleted}
                      onEdit={() => handleEdit(row.id)}
                      onDelete={() => handleDelete(row.id)}
                      onRevert={() => handleRevert(row.id)}
                    />
                  </td>
                  <td className="bb-row-num">{idx + 1}</td>
                  {COLUMNS.map((col) => (
                    <td key={col}>
                      {isEditing && !isDeleted ? (
                        <input
                          type="text"
                          value={row[col]}
                          onChange={(e) => handleCellChange(row.id, col, e.target.value)}
                        />
                      ) : (
                        <span className="bb-cell-text">{row[col]}</span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

type Tab = "fill" | "view" | "ble";

export default function BeaconBoyPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (["fill", "view", "ble"].includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : "fill") as Tab;
  const [tab, setTab] = useState<Tab>(initialTab);

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    const next = new URLSearchParams(window.location.search);
    next.set("tab", t);
    if (t !== "fill") {
      next.delete("data");
    }
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);

  return (
    <div className="bb-page">
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <BeaconBoySvg size={64} />
        <h1 style={{ margin: 0 }}>Beacon Boy</h1>
      </div>
      <nav className="bb-tabs">
        <button
          className={`bb-tab ${tab === "fill" ? "bb-tab--active" : ""}`}
          onClick={() => switchTab("fill")}
        >
          Fill Database
        </button>
        <button
          className={`bb-tab ${tab === "view" ? "bb-tab--active" : ""}`}
          onClick={() => switchTab("view")}
        >
          View Database
        </button>
        <button
          className={`bb-tab ${tab === "ble" ? "bb-tab--active" : ""}`}
          onClick={() => switchTab("ble")}
        >
          BLE Scanner
        </button>
      </nav>
      {tab === "fill" && <FillTab />}
      {tab === "view" && <ViewTab />}
      {tab === "ble" && <BleScanner />}
    </div>
  );
}
