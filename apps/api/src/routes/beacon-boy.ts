import { Router } from "express";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { ROOT_DIR } from "../env.js";

// ── Separate SQLite DB for beacon-boy ──────────────────────────────────────

const dataDir = path.resolve(ROOT_DIR, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "beacon.db"));
db.pragma("journal_mode = WAL");

// Drop old table if schema changed (column renames)
const cols = db.prepare("PRAGMA table_info(beacon)").all() as { name: string }[];
if (cols.length > 0 && cols.some((c) => c.name === "latitude")) {
  db.exec("DROP TABLE beacon");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS beacon (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    Major     TEXT NOT NULL DEFAULT '',
    Minor     TEXT NOT NULL DEFAULT '',
    Building  TEXT NOT NULL DEFAULT '',
    Floor     TEXT NOT NULL DEFAULT '',
    ExactPos1 TEXT NOT NULL DEFAULT '',
    ExactPos2 TEXT NOT NULL DEFAULT '',
    Strength  TEXT NOT NULL DEFAULT '',
    Latitude  TEXT NOT NULL DEFAULT '',
    Longitude TEXT NOT NULL DEFAULT '',
    ZoneId    TEXT NOT NULL DEFAULT '',
    Comment   TEXT NOT NULL DEFAULT ''
  )
`);

// ── Prepared statements ────────────────────────────────────────────────────

const selectAll = db.prepare("SELECT * FROM beacon ORDER BY id");

const insertOne = db.prepare(`
  INSERT INTO beacon (Major, Minor, Building, Floor, ExactPos1, ExactPos2, Strength, Latitude, Longitude, ZoneId, Comment)
  VALUES (@Major, @Minor, @Building, @Floor, @ExactPos1, @ExactPos2, @Strength, @Latitude, @Longitude, @ZoneId, @Comment)
`);

const updateOne = db.prepare(`
  UPDATE beacon SET
    Major = @Major, Minor = @Minor, Building = @Building, Floor = @Floor,
    ExactPos1 = @ExactPos1, ExactPos2 = @ExactPos2, Strength = @Strength,
    Latitude = @Latitude, Longitude = @Longitude, ZoneId = @ZoneId, Comment = @Comment
  WHERE id = @id
`);

const deleteOne = db.prepare("DELETE FROM beacon WHERE id = @id");
const deleteAll = db.prepare("DELETE FROM beacon");

function rowParams(row: Record<string, string>) {
  return {
    Major: row.Major ?? "",
    Minor: row.Minor ?? "",
    Building: row.Building ?? "",
    Floor: row.Floor ?? "",
    ExactPos1: row.ExactPos1 ?? "",
    ExactPos2: row.ExactPos2 ?? "",
    Strength: row.Strength ?? "",
    Latitude: row.Latitude ?? "",
    Longitude: row.Longitude ?? "",
    ZoneId: row.ZoneId ?? "",
    Comment: row.Comment ?? "",
  };
}

const bulkInsert = db.transaction((rows: Record<string, string>[]) => {
  for (const row of rows) insertOne.run(rowParams(row));
});

const bulkReplace = db.transaction((rows: Record<string, string>[]) => {
  deleteAll.run();
  for (const row of rows) insertOne.run(rowParams(row));
});

// ── Routes ─────────────────────────────────────────────────────────────────

export const beaconBoyRouter = Router();

// GET all beacons
beaconBoyRouter.get("/beacon-boy/beacons", (_req, res) => {
  const rows = selectAll.all();
  res.json(rows);
});

// POST — bulk insert (append) or replace all
// Body: { rows: [...], mode?: "append" | "replace" }
beaconBoyRouter.post("/beacon-boy/beacons", (req, res) => {
  const { rows, mode = "replace" } = req.body as {
    rows: Record<string, string>[];
    mode?: "append" | "replace";
  };

  if (!Array.isArray(rows)) {
    res.status(400).json({ error: "rows must be an array" });
    return;
  }

  if (mode === "replace") {
    bulkReplace(rows);
  } else {
    bulkInsert(rows);
  }

  const all = selectAll.all();
  res.json(all);
});

// PATCH — update a single beacon
beaconBoyRouter.patch("/beacon-boy/beacons/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const body = req.body as Record<string, string>;
  updateOne.run({ ...body, id });
  const row = db.prepare("SELECT * FROM beacon WHERE id = ?").get(id);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

// DELETE — single beacon
beaconBoyRouter.delete("/beacon-boy/beacons/:id", (req, res) => {
  const id = parseInt(req.params.id);
  deleteOne.run({ id });
  res.json({ ok: true });
});

// DELETE — all beacons
beaconBoyRouter.delete("/beacon-boy/beacons", (_req, res) => {
  deleteAll.run();
  res.json({ ok: true });
});

// ── Beacon images ──────────────────────────────────────────────────────────

import multer from "multer";

const imagesDir = path.resolve(ROOT_DIR, "data/beacon-images");
fs.mkdirSync(imagesDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: imagesDir,
    filename: (_req, file, cb) => {
      const id = (_req as unknown as { params: { id: string } }).params.id;
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// POST — upload image for a beacon
beaconBoyRouter.post("/beacon-boy/beacons/:id/image", upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "no file" });
    return;
  }
  res.json({ ok: true, filename: req.file.filename });
});

// GET — serve beacon image
beaconBoyRouter.get("/beacon-boy/beacons/:id/image", (req, res) => {
  const id = req.params.id;
  // Find any file matching the id
  const files = fs.readdirSync(imagesDir).filter((f) => f.startsWith(`${id}.`));
  if (files.length === 0) {
    res.status(404).json({ error: "no image" });
    return;
  }
  res.sendFile(path.join(imagesDir, files[0]));
});

// ── Maptiler zones ─────────────────────────────────────────────────────────

const __beaconDirname = path.dirname(new URL(import.meta.url).pathname);
const maptilerDir = path.resolve(__beaconDirname, "../zones");

// GET — list all available zones
beaconBoyRouter.get("/beacon-boy/zones", (_req, res) => {
  try {
    const dirs = fs.readdirSync(maptilerDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    res.json(dirs);
  } catch {
    res.json([]);
  }
});

// GET — zone map.json with MAPTILER_KEY substituted
beaconBoyRouter.get("/beacon-boy/zones/:zone", (req, res) => {
  const zonePath = path.join(maptilerDir, req.params.zone, "map.json");
  try {
    const raw = fs.readFileSync(zonePath, "utf-8");
    const key = process.env.MAPTILER_KEY ?? "";
    const substituted = raw.replace(/\$\{MAPTILER_KEY\}/g, key);
    res.json(JSON.parse(substituted));
  } catch {
    res.status(404).json({ error: "zone not found" });
  }
});
