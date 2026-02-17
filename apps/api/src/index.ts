import { ROOT_DIR } from "./env.js";
import path from "path";
import express from "express";
import cors from "cors";
import { syncRouter } from "./routes/sync.js";
import { eventsRouter } from "./routes/events.js";
import { zonesRouter } from "./routes/zones.js";
import { startCronSync } from "./sync/cron.js";
import { loadCache } from "./cache.js";

const WEB_ROOT = path.resolve(ROOT_DIR, "apps/web");

const app = express();
const port = parseInt(process.env.PORT || "3001");
const isDev = process.env.NODE_ENV !== "production";

app.use(cors());
app.use(express.json());

if (isDev) {
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.url}`);
    next();
  });
}

app.use("/api", syncRouter);
app.use("/api", eventsRouter);
app.use("/api", zonesRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

if (isDev) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(WEB_ROOT, "dist");
  app.use(express.static(distPath));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Heatbrothers running on http://localhost:${port}`);
  loadCache();
  startCronSync();
});
