import { Router } from "express";
import { sqlite } from "@heatbrothers/db";

export const featureRequestsRouter = Router();

interface FeatureRequestRow {
  id: number;
  requestor: string;
  description: string;
  upvotes: number;
  created_at: number;
}

const listStmt = sqlite.prepare<[], FeatureRequestRow>(
  `SELECT id, requestor, description, upvotes, created_at
   FROM feature_requests
   ORDER BY upvotes DESC, created_at DESC`,
);

const insertStmt = sqlite.prepare(
  `INSERT INTO feature_requests (requestor, description) VALUES (@requestor, @description)`,
);

const upvoteStmt = sqlite.prepare(
  `UPDATE feature_requests SET upvotes = upvotes + 1 WHERE id = @id`,
);

const unvoteStmt = sqlite.prepare(
  `UPDATE feature_requests SET upvotes = MAX(0, upvotes - 1) WHERE id = @id`,
);

featureRequestsRouter.get("/feature-requests", (_req, res) => {
  res.json({ requests: listStmt.all() });
});

featureRequestsRouter.post("/feature-requests", (req, res) => {
  const { requestor, description } = req.body as { requestor?: string; description?: string };
  if (!requestor?.trim() || !description?.trim()) {
    res.status(400).json({ error: "requestor and description are required" });
    return;
  }
  const result = insertStmt.run({ requestor: requestor.trim(), description: description.trim() });
  res.status(201).json({ id: result.lastInsertRowid });
});

featureRequestsRouter.post("/feature-requests/:id/upvote", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const result = upvoteStmt.run({ id });
  if (result.changes === 0) { res.status(404).json({ error: "not found" }); return; }
  res.json({ ok: true });
});

featureRequestsRouter.post("/feature-requests/:id/unvote", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const result = unvoteStmt.run({ id });
  if (result.changes === 0) { res.status(404).json({ error: "not found" }); return; }
  res.json({ ok: true });
});
