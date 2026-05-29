import { Router, type Router as ExpressRouter } from "express";
import { runSync, hardReset } from "../sync/sync-service.js";
import { refreshCache, getStats } from "../cache.js";

export const syncRouter: ExpressRouter = Router();

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

syncRouter.post("/sync/hard-reset", (_req, res) => {
  // Fire and forget — watch with: journalctl --user -u heatbrothers -f | grep hard-reset
  hardReset().catch((err: unknown) => console.error("[hard-reset] failed:", err));
  res.json({ ok: true, message: "Hard reset started — all events deleted, full re-sync in progress" });
});
