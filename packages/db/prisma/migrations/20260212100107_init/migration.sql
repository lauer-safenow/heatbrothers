-- CreateTable
CREATE TABLE "events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "posthog_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "city" TEXT,
    "country" TEXT,
    "properties" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

-- CreateTable
CREATE TABLE "sync_state" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "events_posthog_id_key" ON "events"("posthog_id");

-- CreateIndex
CREATE INDEX "idx_event_type" ON "events"("event_type");

-- CreateIndex
CREATE INDEX "idx_timestamp" ON "events"("timestamp");

-- CreateIndex
CREATE INDEX "idx_geo" ON "events"("latitude", "longitude");
