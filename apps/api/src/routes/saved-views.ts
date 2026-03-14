import { Router } from "express";
import { sqlite } from "@heatbrothers/db";

export const savedViewsRouter = Router();

interface SavedViewRow {
  id: number;
  email: string;
  description: string;
  params: string;
  is_home: number;
  created_at: number;
}

const listStmt = sqlite.prepare<[string], SavedViewRow>(
  `SELECT id, email, description, params, is_home, created_at
   FROM saved_views
   WHERE email = ?
   ORDER BY is_home DESC, created_at DESC`,
);

const countStmt = sqlite.prepare<[string], { cnt: number }>(
  `SELECT COUNT(*) as cnt FROM saved_views WHERE email = ?`,
);

const insertStmt = sqlite.prepare(
  `INSERT INTO saved_views (email, description, params) VALUES (@email, @description, @params)`,
);

const deleteStmt = sqlite.prepare(
  `DELETE FROM saved_views WHERE id = @id AND email = @email`,
);

const renameStmt = sqlite.prepare(
  `UPDATE saved_views SET description = @description WHERE id = @id AND email = @email`,
);

const clearHomeStmt = sqlite.prepare(
  `UPDATE saved_views SET is_home = 0 WHERE email = @email`,
);

const setHomeStmt = sqlite.prepare(
  `UPDATE saved_views SET is_home = 1 WHERE id = @id AND email = @email`,
);

const getHomeStmt = sqlite.prepare<[string], SavedViewRow>(
  `SELECT id, email, description, params, is_home, created_at
   FROM saved_views
   WHERE email = ? AND is_home = 1
   LIMIT 1`,
);

function getEmail(req: { headers: Record<string, unknown> }): string {
  return (req.headers["remote-email"] as string) ?? "dev@local";
}

savedViewsRouter.get("/saved-views", (req, res) => {
  const email = getEmail(req);
  res.json({ views: listStmt.all(email) });
});

savedViewsRouter.get("/saved-views/home", (req, res) => {
  const email = getEmail(req);
  const home = getHomeStmt.get(email);
  res.json({ home: home ?? null });
});

savedViewsRouter.post("/saved-views", (req, res) => {
  const email = getEmail(req);
  const { description, params } = req.body as { description?: string; params?: string };

  if (!description?.trim() || !params?.trim()) {
    res.status(400).json({ error: "description and params are required" });
    return;
  }
  if (description.length > 100) {
    res.status(400).json({ error: "description must be 100 characters or less" });
    return;
  }
  if (params.length > 2000) {
    res.status(400).json({ error: "params too long" });
    return;
  }

  const { cnt } = countStmt.get(email)!;
  if (cnt >= 500) {
    res.status(409).json({ error: "maximum 500 saved views reached" });
    return;
  }

  const result = insertStmt.run({ email, description: description.trim(), params: params.trim() });
  res.status(201).json({ id: result.lastInsertRowid });
});

savedViewsRouter.patch("/saved-views/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const email = getEmail(req);
  const { description } = req.body as { description?: string };

  if (!description?.trim()) {
    res.status(400).json({ error: "description is required" });
    return;
  }
  if (description.length > 100) {
    res.status(400).json({ error: "description must be 100 characters or less" });
    return;
  }

  const result = renameStmt.run({ id, email, description: description.trim() });
  if (result.changes === 0) { res.status(404).json({ error: "not found" }); return; }
  res.json({ ok: true });
});

savedViewsRouter.post("/saved-views/:id/home", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const email = getEmail(req);

  // Clear any existing home, then set this one
  const setHome = sqlite.transaction(() => {
    clearHomeStmt.run({ email });
    setHomeStmt.run({ id, email });
  });
  setHome();
  res.json({ ok: true });
});

savedViewsRouter.delete("/saved-views/:id/home", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const email = getEmail(req);
  clearHomeStmt.run({ email });
  res.json({ ok: true });
});

savedViewsRouter.delete("/saved-views/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const email = getEmail(req);
  const result = deleteStmt.run({ id, email });
  if (result.changes === 0) { res.status(404).json({ error: "not found" }); return; }
  res.json({ ok: true });
});
