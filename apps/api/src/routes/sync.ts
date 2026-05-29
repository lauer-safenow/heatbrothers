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

syncRouter.post("/sync/reset", (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days ?? 7), 1), 365);
  const sinceEpoch = Math.floor(Date.now() / 1000) - days * 86_400;
  // Fire and forget — watch with: journalctl --user -u heatbrothers -f | grep reset
  hardReset(sinceEpoch)
    .then(() => refreshCache())
    .catch((err: unknown) => console.error("[reset] failed:", err));
  res.json({ ok: true, days, since: new Date(sinceEpoch * 1000).toISOString() });
});
