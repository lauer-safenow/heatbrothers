import { ROOT_DIR } from "./env.js";
import path from "path";
import { execSync } from "child_process";
import express from "express";
import cors from "cors";
import { syncRouter } from "./routes/sync.js";
import { eventsRouter } from "./routes/events.js";
import { zonesRouter } from "./routes/zones.js";
import { featureRequestsRouter } from "./routes/feature-requests.js";
import { hotspotsRouter } from "./routes/hotspots.js";
import { newsRouter } from "./routes/news.js";
import { savedViewsRouter } from "./routes/saved-views.js";
import { beaconBoyRouter } from "./routes/beacon-boy.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { startCronSync } from "./sync/cron.js";
import { loadCache } from "./cache.js";
import { initGeocoder } from "./geocode.js";
import { sqlite } from "@heatbrothers/db";

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
app.use("/api", featureRequestsRouter);
app.use("/api", hotspotsRouter);
app.use("/api", newsRouter);
app.use("/api", savedViewsRouter);
app.use("/api", beaconBoyRouter);
app.use("/api", dashboardRouter);

app.get("/api/me", (req, res) => {
  const user = req.headers["remote-user"] as string | undefined;
  const email = req.headers["remote-email"] as string | undefined;
  const name = req.headers["remote-name"] as string | undefined;
  res.json({ user: user ?? null, email: email ?? null, name: name ?? null });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

function getVersion() {
  try {
    const tag = execSync("git describe --tags --exact-match", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { type: "tag", value: tag };
  } catch {
    try {
      const hash = execSync("git log -1 --format=%h", { encoding: "utf8" }).trim();
      const date = execSync("git log -1 --format=%aI", { encoding: "utf8" }).trim();
      return { type: "commit", hash, date };
    } catch {
      return { type: "unknown" };
    }
  }
}

const version = getVersion();

app.get("/api/version", (_req, res) => {
  res.json(version);
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

await initGeocoder();

const server = app.listen(port, async () => {
  console.log(`Heatbrothers running on http://localhost:${port}`);
  await loadCache();
  startCronSync();
});

function shutdown() {
  server.close(() => {
    sqlite.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
