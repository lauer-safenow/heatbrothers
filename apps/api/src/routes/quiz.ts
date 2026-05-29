import { Router, type Router as ExpressRouter } from "express";
import { sqlite } from "@heatbrothers/db";
import { geocode } from "../geocode.js";
import { getZonesMap } from "./zones.js";

export const quizRouter: ExpressRouter = Router();

const DISPLAY_NAMES: Record<string, string> = {
  DETAILED_ALARM_STARTED_PRIVATE_GROUP: "Alarm started private",
  DETAILED_ATTENTION_STARTED_PRIVATE_GROUP: "Attention private",
  app_opening_ZONE: "App opening zone",
  FIRST_TIME_PHONE_STATUS_SENT: "Installs",
  DETAILED_ALARM_STARTED_ZONE: "Alarm started zone",
};

const locByTypeStmt = sqlite.prepare(
  `SELECT event_type, ROUND(latitude, 2) as lat, ROUND(longitude, 2) as lng, COUNT(*) as count
   FROM events WHERE timestamp >= @from AND timestamp <= @to GROUP BY event_type, lat, lng`,
);

const zoneByTypeStmt = sqlite.prepare(
  `SELECT pss_id, COUNT(*) as count FROM events
   WHERE timestamp >= @from AND timestamp <= @to AND pss_id IS NOT NULL AND event_type = @eventType
   GROUP BY pss_id ORDER BY count DESC`,
);

const zoneAnyTypeStmt = sqlite.prepare(
  `SELECT pss_id, COUNT(*) as count FROM events
   WHERE timestamp >= @from AND timestamp <= @to AND pss_id IS NOT NULL
   GROUP BY pss_id ORDER BY count DESC`,
);

const ZONE_EVENT_TYPES = [
  "DETAILED_ALARM_STARTED_ZONE",
  "app_opening_ZONE",
  "DETAILED_ALARM_STARTED_PRIVATE_GROUP",
];

type TimePeriod = "today" | "this week" | "this month";

function getBerlinMidnightEpoch(dateStr: string): number {
  const utcMidnight = new Date(dateStr + "T00:00:00Z");
  const berlinHour = parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "numeric",
      hour12: false,
    }).format(utcMidnight),
  );
  return Math.floor(utcMidnight.getTime() / 1000) - berlinHour * 3600;
}

function getEpochRange(period: TimePeriod): { from: number; to: number } {
  const now = new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const berlinDateStr = now.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });

  if (period === "today") {
    return { from: getBerlinMidnightEpoch(berlinDateStr), to: nowEpoch };
  }

  if (period === "this week") {
    const dayOfWeek = new Date(berlinDateStr).getDay(); // 0=Sun, 1=Mon...
    const daysSinceMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayDate = new Date(new Date(berlinDateStr).getTime() - daysSinceMon * 86_400_000);
    const mondayStr = mondayDate.toISOString().slice(0, 10);
    return { from: getBerlinMidnightEpoch(mondayStr), to: nowEpoch };
  }

  // this month
  const firstOfMonthStr = berlinDateStr.slice(0, 8) + "01";
  return { from: getBerlinMidnightEpoch(firstOfMonthStr), to: nowEpoch };
}

quizRouter.get("/quiz", async (req, res) => {
  try {
    const mode = (req.query.mode as string | undefined) ?? "both";
    const PERIODS: TimePeriod[] = ["today", "this week", "this month"];
    const timePeriod = PERIODS[Math.floor(Math.random() * PERIODS.length)];
    const { from, to } = getEpochRange(timePeriod);

    // Try zone quiz when mode is "zone" (always) or "both" (40% chance)
    const tryZone = mode === "zone" || (mode !== "country" && Math.random() < 0.4);
    if (tryZone) {
      const zonesMap = await getZonesMap();
      type ZoneRow = { pss_id: string; count: number };

      // Try zone-specific event types in random order, fall back to all types
      const shuffledTypes = [...ZONE_EVENT_TYPES].sort(() => Math.random() - 0.5);
      let zoneRows: ZoneRow[] = [];
      let zoneEventType: string | null = null;

      for (const et of shuffledTypes) {
        const rows = zoneByTypeStmt.all({ from, to, eventType: et }) as ZoneRow[];
        if (rows.filter((r) => zonesMap.has(r.pss_id)).length >= 4) {
          zoneRows = rows;
          zoneEventType = et;
          break;
        }
      }
      if (!zoneEventType) {
        zoneRows = zoneAnyTypeStmt.all({ from, to }) as ZoneRow[];
      }

      const enriched = zoneRows
        .map((row) => {
          const zone = zonesMap.get(row.pss_id);
          if (!zone) return null;
          const nameLower = zone.name.toLowerCase();
          if (nameLower.includes("test") || nameLower.includes("home")) return null;
          const s3 = zone.pss_image?.s3_location ?? null;
          const image = s3 ? (s3.startsWith("http") ? s3 : `https://${s3}`) : null;
          return { id: row.pss_id, name: zone.name, image, count: row.count };
        })
        .filter((z): z is NonNullable<typeof z> => z !== null);

      if (enriched.length >= 4) {
        const [top, ...rest] = enriched;
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        const chosen = [top, ...rest.slice(0, 3)];
        for (let i = chosen.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
        }
        const correctIndex = chosen.reduce(
          (best, c, i) => (c.count > chosen[best].count ? i : best),
          0,
        );
        res.json({
          mode: "zone",
          timePeriod,
          displayName: zoneEventType ? (DISPLAY_NAMES[zoneEventType] ?? zoneEventType) : "activity",
          zones: chosen,
          correctIndex,
        });
        return;
      }
      if (mode === "zone") { res.json({ error: "Not enough zone data for this period" }); return; }
      // fall through to country quiz
    }

    // Country quiz
    type LocRow = { event_type: string; lat: number; lng: number; count: number };
    const rows = locByTypeStmt.all({ from, to }) as LocRow[];

    const typeMap = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (row.lat == null || row.lng == null) continue;
      const [, cc] = geocode(row.lat, row.lng);
      if (!cc) continue;
      let cm = typeMap.get(row.event_type);
      if (!cm) { cm = new Map(); typeMap.set(row.event_type, cm); }
      cm.set(cc, (cm.get(cc) ?? 0) + row.count);
    }

    if (typeMap.size === 0) {
      res.json({ error: "No events for this period" });
      return;
    }

    const candidates = [...typeMap.entries()].sort((a, b) => b[1].size - a[1].size);
    const eligibles = candidates.filter(([, cm]) => cm.size >= 4);
    const pool = eligibles.length > 0 ? eligibles : candidates.slice(0, 1);

    if (pool[0][1].size < 2) {
      res.json({ error: "Not enough data for this period" });
      return;
    }

    const [eventType, countryMap] = pool[Math.floor(Math.random() * pool.length)];
    const sorted = [...countryMap.entries()].sort((a, b) => b[1] - a[1]);
    const [topCode, topCount] = sorted[0];

    const rest = sorted.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }

    const chosen: { code: string; count: number }[] = [
      { code: topCode, count: topCount },
      ...rest.slice(0, 3).map(([code, count]) => ({ code, count })),
    ];

    for (let i = chosen.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    }

    // 30/70 Germany re-roll
    const deIdx = chosen.findIndex((c) => c.code === "DE");
    if (deIdx !== -1 && Math.random() < 0.7) {
      const chosenCodes = new Set(chosen.map((c) => c.code));
      const alternatives = sorted.filter(([code]) => !chosenCodes.has(code));
      if (alternatives.length > 0) {
        const [altCode, altCount] = alternatives[Math.floor(Math.random() * alternatives.length)];
        chosen[deIdx] = { code: altCode, count: altCount };
      }
    }

    const correctIndex = chosen.reduce(
      (best, c, i) => (c.count > chosen[best].count ? i : best),
      0,
    );

    res.json({
      mode: "country",
      eventType,
      displayName: DISPLAY_NAMES[eventType] ?? eventType,
      timePeriod,
      countries: chosen,
      correctIndex,
    });
  } catch (err) {
    console.error("[quiz] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});
