import { useState, useCallback } from "react";

export const DEFAULT_OVERRIDE_COLORS = ["#f58ca0", "#f0506e", "#f0093f", "#dc0750", "#cc0560", "#960046"];

export interface MapSettings {
  mapTheme: "dark" | "light";
  osmStyle: boolean;
  geohashEnabled: boolean;
  geohashPrecision: 5 | 6;
  zoneAutoDiscover: boolean;
  showZoomControls: boolean;
  colorOverride: boolean;
  heatmapColors: string[];
  showActiveZones: boolean;
  jitterEnabled: boolean;
}

const DEFAULTS: MapSettings = {
  mapTheme: "light",
  osmStyle: false,
  geohashEnabled: false,
  geohashPrecision: 5,
  zoneAutoDiscover: true,
  showZoomControls: true,
  colorOverride: false,
  heatmapColors: DEFAULT_OVERRIDE_COLORS,
  showActiveZones: false,
  jitterEnabled: true,
};

const STORAGE_KEY = "heatbrothers-map-settings";

function loadSettings(): MapSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

export function usePersistedSettings(): [MapSettings, (patch: Partial<MapSettings>) => void] {
  const [settings, setSettings] = useState<MapSettings>(loadSettings);

  const update = useCallback((patch: Partial<MapSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return [settings, update];
}
