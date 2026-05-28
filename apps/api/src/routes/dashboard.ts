import { Router } from "express";
import { getStats } from "../cache.js";
import { sqlite } from "@heatbrothers/db";
import { ensureZonesCache, getZonesData } from "./zones.js";
import { geocode } from "../geocode.js";

export const dashboardRouter = Router();

const todayCountsStmt = sqlite.prepare(
  `SELECT event_type, COUNT(*) as count FROM events
   WHERE timestamp >= @from AND timestamp <= @to
   GROUP BY event_type ORDER BY count DESC`,
);

const locationByTypeStmt = sqlite.prepare(
  `SELECT event_type, ROUND(latitude, 2) as lat, ROUND(longitude, 2) as lng, COUNT(*) as count
   FROM events GROUP BY event_type, lat, lng`,
);

const locationByTypeRangeStmt = sqlite.prepare(
  `SELECT event_type, ROUND(latitude, 2) as lat, ROUND(longitude, 2) as lng, COUNT(*) as count
   FROM events WHERE timestamp >= @from AND timestamp <= @to GROUP BY event_type, lat, lng`,
);

const DISPLAY_NAMES: Record<string, string> = {
  DETAILED_ALARM_STARTED_PRIVATE_GROUP: "Alarm started private",
  DETAILED_ATTENTION_STARTED_PRIVATE_GROUP: "Attention private",
  app_opening_ZONE: "App opening zone",
  FIRST_TIME_PHONE_STATUS_SENT: "Installs",
  DETAILED_ALARM_STARTED_ZONE: "Alarm started zone",
};

function parseAreaJson(raw: unknown): number[][] | null {
  let parsed = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "Feature") {
    const geom = obj.geometry as Record<string, unknown>;
    return (geom.coordinates as number[][][])[0];
  }
  if (obj.type === "Polygon") {
    return (obj.coordinates as number[][][])[0];
  }
  if (Array.isArray(parsed)) return parsed as number[][];
  return null;
}

function centroid(coords: number[][]): [number, number] {
  let latSum = 0, lngSum = 0;
  for (const [lng, lat] of coords) {
    lngSum += lng;
    latSum += lat;
  }
  return [latSum / coords.length, lngSum / coords.length];
}

dashboardRouter.get("/dashboard", async (req, res) => {
  try {
    // Parse optional filter params
    const fromParam = req.query.from ? Number(req.query.from) : null;
    const toParam = req.query.to ? Number(req.query.to) : null;
    const eventTypesFilter =
      typeof req.query.eventTypes === "string" && req.query.eventTypes
        ? req.query.eventTypes.split(",")
        : null;
    const countriesFilter =
      typeof req.query.countries === "string" && req.query.countries
        ? req.query.countries.split(",")
        : null;

    // Events — use date-range query if from+to provided, otherwise use cache
    let rawByType: { event_type: string; count: number }[];
    let eventsTotal: number;

    if (fromParam !== null && toParam !== null) {
      rawByType = todayCountsStmt.all({ from: fromParam, to: toParam }) as { event_type: string; count: number }[];
      eventsTotal = rawByType.reduce((sum, r) => sum + r.count, 0);
    } else {
      const stats = getStats();
      rawByType = stats.byType;
      eventsTotal = stats.total;
    }

    let eventsByType = rawByType.map((e) => ({
      event_type: e.event_type,
      displayName: DISPLAY_NAMES[e.event_type] ?? e.event_type,
      count: e.count,
    }));

    if (eventTypesFilter) {
      eventsByType = eventsByType.filter((e) => eventTypesFilter.includes(e.event_type));
      eventsTotal = eventsByType.reduce((sum, e) => sum + e.count, 0);
    }

    // Events today — midnight in Europe/Berlin, works on any server timezone.
    // Get today's date string in Berlin, then find the UTC epoch for that midnight.
    const berlinDate = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
    // Intl gives us the Berlin time at UTC midnight — the difference is the offset
    const utcMidnight = new Date(berlinDate + "T00:00:00Z");
    const berlinAtUtcMidnight = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin", hour: "numeric", hour12: false,
    }).format(utcMidnight);
    const offsetHours = parseInt(berlinAtUtcMidnight); // 1 for CET, 2 for CEST
    const fromEpoch = Math.floor(utcMidnight.getTime() / 1000) - offsetHours * 3600;
    const toEpoch = fromEpoch + 86400 - 1;

    const todayRows = todayCountsStmt.all({ from: fromEpoch, to: toEpoch }) as { event_type: string; count: number }[];
    let todayByType = todayRows.map((r) => ({
      event_type: r.event_type,
      displayName: DISPLAY_NAMES[r.event_type] ?? r.event_type,
      count: r.count,
    }));
    let todayTotal = todayRows.reduce((sum, r) => sum + r.count, 0);

    if (eventTypesFilter) {
      todayByType = todayByType.filter((e) => eventTypesFilter.includes(e.event_type));
      todayTotal = todayByType.reduce((sum, e) => sum + e.count, 0);
    }

    await ensureZonesCache();
    const allZones = getZonesData();
    const activePublic = allZones.filter((z) => z.is_active && z.is_public);

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

    const countryMap = new Map<string, ZoneInfo[]>();
    for (const zone of activePublic) {
      const polygon = parseAreaJson(zone.area_json);
      if (!polygon || polygon.length === 0) continue;
      const [lat, lng] = centroid(polygon);
      const [, cc] = geocode(lat, lng);
      const country = cc || "Unknown";
      const s3 = zone.pss_image?.s3_location ?? null;
      const info: ZoneInfo = {
        name: zone.name,
        image: s3 ? (s3.startsWith("http") ? s3 : `https://${s3}`) : null,
        description: zone.description,
        about: zone.about,
        number_of_members: zone.number_of_members,
        number_of_members_reachable: zone.number_of_members_reachable,
        max_number_of_members_allowed: zone.max_number_of_members_allowed,
        safe_spot_type: zone.safe_spot_type,
        created_at: zone.created_at,
        modified_at: zone.modified_at,
        valid_until: zone.valid_until,
        created_by: zone.person?.person_account?.display_name ?? null,
      };
      const list = countryMap.get(country);
      if (list) list.push(info);
      else countryMap.set(country, [info]);
    }

    let byCountry = [...countryMap.entries()]
      .map(([country, zones]) => ({
        country,
        count: zones.length,
        zones: zones.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => b.count - a.count);

    if (countriesFilter) {
      byCountry = byCountry.filter((c) => countriesFilter.includes(c.country));
    }

    const zonesTotal = byCountry.reduce((sum, c) => sum + c.count, 0);

    // Events by country — group by rounded lat/lng, geocode, aggregate
    type LocRow = { event_type: string; lat: number; lng: number; count: number };
    const locRows = (fromParam !== null && toParam !== null
      ? locationByTypeRangeStmt.all({ from: fromParam, to: toParam })
      : locationByTypeStmt.all()) as LocRow[];

    const filteredLocRows = eventTypesFilter
      ? locRows.filter((r) => eventTypesFilter.includes(r.event_type))
      : locRows;

    const countryEventCounts = new Map<string, number>();
    for (const row of filteredLocRows) {
      if (row.lat == null || row.lng == null) continue;
      const [, cc] = geocode(row.lat, row.lng);
      const country = cc || "Unknown";
      countryEventCounts.set(country, (countryEventCounts.get(country) ?? 0) + row.count);
    }

    let eventsByCountry = [...countryEventCounts.entries()]
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count);

    if (countriesFilter) {
      eventsByCountry = eventsByCountry.filter((c) => countriesFilter.includes(c.country));
    }

    res.json({
      events: { total: eventsTotal, byType: eventsByType },
      eventsToday: { total: todayTotal, byType: todayByType },
      zones: { total: zonesTotal, byCountry },
      eventsByCountry,
    });
  } catch (err) {
    console.error("Dashboard fetch failed:", err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});
