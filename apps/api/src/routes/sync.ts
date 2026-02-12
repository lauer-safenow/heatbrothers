import { Router } from "express";
import { sqlite } from "@heatbrothers/db";
import { runSync } from "../sync/sync-service.js";

export const syncRouter = Router();

syncRouter.post("/sync", async (_req, res) => {
  try {
    await runSync();
    res.json({ ok: true });
  } catch (err) {
    console.error("Manual sync failed:", err);
    res.status(500).json({ error: "Sync failed" });
  }
});

syncRouter.get("/stats", (_req, res) => {
  const rows = sqlite
    .prepare("SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC")
    .all() as { event_type: string; count: number }[];

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  res.json({ total, byType: rows });
});
