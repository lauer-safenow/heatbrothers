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

dashboardRouter.get("/dashboard", async (_req, res) => {
  try {
    const stats = getStats();
    const eventsByType = stats.byType.map((e) => ({
      event_type: e.event_type,
      displayName: DISPLAY_NAMES[e.event_type] ?? e.event_type,
      count: e.count,
    }));

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
    const todayByType = todayRows.map((r) => ({
      event_type: r.event_type,
      displayName: DISPLAY_NAMES[r.event_type] ?? r.event_type,
      count: r.count,
    }));
    const todayTotal = todayRows.reduce((sum, r) => sum + r.count, 0);

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

    const byCountry = [...countryMap.entries()]
      .map(([country, zones]) => ({
        country,
        count: zones.length,
        zones: zones.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => b.count - a.count);

    res.json({
      events: { total: stats.total, byType: eventsByType },
      eventsToday: { total: todayTotal, byType: todayByType },
      zones: { total: activePublic.length, byCountry },
    });
  } catch (err) {
    console.error("Dashboard fetch failed:", err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});
