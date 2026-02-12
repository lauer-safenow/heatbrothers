import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { syncRouter } from "./routes/sync.js";
import { startCronSync } from "./sync/cron.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "../../web");

const app = express();
const port = parseInt(process.env.PORT || "3001");
const isDev = process.env.NODE_ENV !== "production";

app.use(cors());
app.use(express.json());

app.use("/api", syncRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

if (isDev) {
  // In dev: Vite middleware with HMR
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  // In prod: serve built static files
  const distPath = path.join(WEB_ROOT, "dist");
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

startCronSync();

app.listen(port, () => {
  console.log(`Heatbrothers running on http://localhost:${port}`);
});
