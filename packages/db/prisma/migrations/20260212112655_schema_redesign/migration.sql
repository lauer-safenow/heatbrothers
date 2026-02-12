/*
  Warnings:

  - You are about to drop the column `city` on the `events` table. All the data in the column will be lost.
  - You are about to drop the column `country` on the `events` table. All the data in the column will be lost.
  - Added the required column `distinct_id` to the `events` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "posthog_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "geohash" TEXT,
    "timestamp" INTEGER NOT NULL,
    "distinct_id" TEXT NOT NULL,
    "env" TEXT NOT NULL DEFAULT 'prod',
    "event_source" TEXT,
    "pss_id" TEXT,
    "pss_name" TEXT,
    "pss_type" TEXT,
    "company_name" TEXT,
    "alarm_source" TEXT,
    "properties" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO "new_events" ("created_at", "event_type", "id", "latitude", "longitude", "posthog_id", "properties", "timestamp") SELECT "created_at", "event_type", "id", "latitude", "longitude", "posthog_id", "properties", "timestamp" FROM "events";
DROP TABLE "events";
ALTER TABLE "new_events" RENAME TO "events";
CREATE UNIQUE INDEX "events_posthog_id_key" ON "events"("posthog_id");
CREATE INDEX "idx_event_type" ON "events"("event_type");
CREATE INDEX "idx_timestamp" ON "events"("timestamp");
CREATE INDEX "idx_geo" ON "events"("latitude", "longitude");
CREATE INDEX "idx_geohash" ON "events"("geohash");
CREATE INDEX "idx_distinct_id" ON "events"("distinct_id");
CREATE INDEX "idx_pss_id" ON "events"("pss_id");
CREATE INDEX "idx_event_source" ON "events"("event_source");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
