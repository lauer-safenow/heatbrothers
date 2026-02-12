import { Router } from "express";
import { runSync } from "../sync/sync-service.js";
import { refreshCache, getStats } from "../cache.js";

export const syncRouter = Router();

syncRouter.post("/sync", async (_req, res) => {
  try {
    await runSync();
    refreshCache();
    res.json({ ok: true });
  } catch (err) {
    console.error("Manual sync failed:", err);
    res.status(500).json({ error: "Sync failed" });
  }
});

syncRouter.get("/stats", (_req, res) => {
  res.json(getStats());
});
