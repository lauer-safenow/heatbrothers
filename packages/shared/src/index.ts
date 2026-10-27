/** Sync interval in seconds — used by cron, API polling, and live UI countdown */
export const SYNC_INTERVAL_S = 60;

/** Slow sync interval in minutes — used by cron for background event types */
export const SLOW_SYNC_INTERVAL_M = 5;

/** The event type used by the live map */
export const LIVE_EVENT_TYPE = "DETAILED_ALARM_STARTED_PRIVATE_GROUP";

/** The event type used for zone-specific replay */
export const ZONE_EVENT_TYPE = "DETAILED_ALARM_STARTED_ZONE";

/** Max events returned by the replay between endpoint */
export const REPLAY_MAX_EVENTS = 5_000;

/** Areas tool: what kind of place an area ref points at */
export type AreaKind = "country" | "city" | "region";

/** Border simplification per kind (degrees): ~1 km for countries/regions, ~100 m for cities */
const AREA_SIMPLIFY: Record<AreaKind, number> = { country: 0.01, city: 0.001, region: 0.01 };

/** OSM relation ids of countries used by the predefined regions below. */
const C = {
  AD: "R9407", AL: "R53292", AT: "R16239", BA: "R2528142", BE: "R52411", BG: "R186382", BY: "R59065",
  CH: "R51701", CY: "R307787", CZ: "R51684", DE: "R51477", DK: "R50046", EE: "R79510", ES: "R1311341",
  FI: "R54224", FR: "R2202162", GB: "R62149", GR: "R192307", HR: "R214885", HU: "R21335", IE: "R62273",
  IS: "R299133", IT: "R365331", LI: "R1155955", LT: "R72596", LU: "R2171347", LV: "R72594", MC: "R1124039",
  MD: "R58974", ME: "R53296", MK: "R53293", MT: "R365307", NL: "R47796", NO: "R2978650", PL: "R49715",
  PT: "R295480", RO: "R90689", RS: "R1741311", SE: "R52822", SI: "R218657", SK: "R14296", SM: "R54624",
  UA: "R60199", VA: "R36989", XK: "R2088990",
} as const;

/** English names for the ids above (tooltips). */
const COUNTRY_NAMES: Record<string, string> = {
  [C.AD]: "Andorra", [C.AL]: "Albania", [C.AT]: "Austria", [C.BA]: "Bosnia and Herzegovina", [C.BE]: "Belgium",
  [C.BG]: "Bulgaria", [C.BY]: "Belarus", [C.CH]: "Switzerland", [C.CY]: "Cyprus", [C.CZ]: "Czechia",
  [C.DE]: "Germany", [C.DK]: "Denmark", [C.EE]: "Estonia", [C.ES]: "Spain", [C.FI]: "Finland", [C.FR]: "France",
  [C.GB]: "United Kingdom", [C.GR]: "Greece", [C.HR]: "Croatia", [C.HU]: "Hungary", [C.IE]: "Ireland",
  [C.IS]: "Iceland", [C.IT]: "Italy", [C.LI]: "Liechtenstein", [C.LT]: "Lithuania", [C.LU]: "Luxembourg",
  [C.LV]: "Latvia", [C.MC]: "Monaco", [C.MD]: "Moldova", [C.ME]: "Montenegro", [C.MK]: "North Macedonia",
  [C.MT]: "Malta", [C.NL]: "Netherlands", [C.NO]: "Norway", [C.PL]: "Poland", [C.PT]: "Portugal",
  [C.RO]: "Romania", [C.RS]: "Serbia", [C.SE]: "Sweden", [C.SI]: "Slovenia", [C.SK]: "Slovakia",
  [C.SM]: "San Marino", [C.UA]: "Ukraine", [C.VA]: "Vatican City", [C.XK]: "Kosovo",
};

/** Country names of a region, alphabetical, for tooltips. */
export function regionCountryNames(key: string): string[] {
  return (REGIONS[key]?.countries ?? []).map((id) => COUNTRY_NAMES[id] ?? id).sort();
}

export interface Region {
  name: string;
  /** extra search words besides the name */
  aliases: string[];
  /** OSM relation ids; at most 50 (Nominatim lookup limit) */
  countries: string[];
}

const EU = [C.AT, C.BE, C.BG, C.HR, C.CY, C.CZ, C.DK, C.EE, C.FI, C.FR, C.DE, C.GR, C.HU, C.IE, C.IT, C.LV, C.LT, C.LU, C.MT, C.NL, C.PL, C.PT, C.RO, C.SK, C.SI, C.ES, C.SE];

/**
 * Predefined regions the Areas tool can search ("region:<key>"). A region is
 * the union of its countries' borders. Europe here means Europe west of
 * Russia/Belarus' eastern neighbours; no Russia, Turkey or the Caucasus.
 */
export const REGIONS: Record<string, Region> = {
  europe: {
    name: "Europe",
    aliases: ["europa", "eu"],
    countries: [...EU, C.AD, C.AL, C.BA, C.BY, C.CH, C.GB, C.IS, C.LI, C.MC, C.MD, C.ME, C.MK, C.NO, C.RS, C.SM, C.UA, C.VA, C.XK],
  },
  eu: { name: "European Union", aliases: ["eu", "eu27"], countries: EU },
  dach: { name: "DACH", aliases: ["germany austria switzerland"], countries: [C.DE, C.AT, C.CH] },
  benelux: { name: "Benelux", aliases: [], countries: [C.BE, C.NL, C.LU] },
  nordics: { name: "Nordics", aliases: ["scandinavia", "nordic"], countries: [C.DK, C.SE, C.NO, C.FI, C.IS] },
  baltics: { name: "Baltics", aliases: ["baltic"], countries: [C.EE, C.LV, C.LT] },
  balkans: {
    name: "Balkans",
    aliases: ["balkan"],
    countries: [C.SI, C.HR, C.BA, C.RS, C.ME, C.XK, C.MK, C.AL, C.GR, C.BG, C.RO],
  },
  iberia: { name: "Iberia", aliases: ["iberian", "spain portugal"], countries: [C.ES, C.PT, C.AD] },
  "british-isles": { name: "British Isles", aliases: ["uk ireland"], countries: [C.GB, C.IE] },
  "central-europe": { name: "Central Europe", aliases: [], countries: [C.DE, C.AT, C.CH, C.LI, C.PL, C.CZ, C.SK, C.HU, C.SI] },
};

/** Regions matching a search query (name, key or alias contains the query). */
export function searchRegions(query: string): { key: string; region: Region }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.entries(REGIONS)
    .filter(([key, r]) => key.includes(q) || r.name.toLowerCase().includes(q) || r.aliases.some((a) => a.includes(q)))
    .map(([key, region]) => ({ key, region }));
}

/**
 * Area ref: "<kind>:<id>[:mainland][:bbox]", e.g. "city:R62428",
 * "country:R2202162:mainland" or "region:balkans". The id is an OSM relation
 * for countries/cities and a REGIONS key for regions. `mainland` keeps only
 * the largest part of each multi-part border (drops islands / overseas
 * territories; per country for a region); `bbox` replaces the border with
 * its bounding rectangle.
 */
export function parseAreaRef(ref: string): { kind: AreaKind; id: string; mainland: boolean; bbox: boolean } | null {
  const m = /^(country|city):([RW]\d+)(:mainland)?(:bbox)?$/.exec(ref);
  if (m) return { kind: m[1] as AreaKind, id: m[2], mainland: !!m[3], bbox: !!m[4] };
  const r = /^region:([a-z-]+)(:mainland)?(:bbox)?$/.exec(ref);
  if (r && REGIONS[r[1]]) return { kind: "region", id: r[1], mainland: !!r[2], bbox: !!r[3] };
  return null;
}

/** Builds the ref back from its parts (inverse of parseAreaRef). */
export function formatAreaRef(base: string, mainland: boolean, bbox: boolean): string {
  return base + (mainland ? ":mainland" : "") + (bbox ? ":bbox" : "");
}

/** Several refs travel in one `area=` param, comma-separated (a ref never contains a comma). */
export function splitAreaRefs(param: string): string[] {
  return param.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Nominatim lookup URL for an area's border (GeoJSON Polygon/MultiPolygon).
 * Returns null for a malformed ref. Used by the map Areas tool and the CSV
 * export so both filter by the exact same border.
 */
export function areaBorderUrl(ref: string): string | null {
  const a = parseAreaRef(ref);
  if (!a) return null;
  const osmIds = a.kind === "region" ? REGIONS[a.id].countries.join(",") : a.id;
  return (
    `https://nominatim.openstreetmap.org/lookup?format=json&osm_ids=${osmIds}` +
    `&accept-language=en&polygon_geojson=1&polygon_threshold=${AREA_SIMPLIFY[a.kind]}`
  );
}
