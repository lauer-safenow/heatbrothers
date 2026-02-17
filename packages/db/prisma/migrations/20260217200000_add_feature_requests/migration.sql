CREATE TABLE "feature_requests" (
  "id"          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "requestor"   TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "upvotes"     INTEGER NOT NULL DEFAULT 0,
  "downvotes"   INTEGER NOT NULL DEFAULT 0,
  "created_at"  INTEGER NOT NULL DEFAULT (unixepoch())
);
