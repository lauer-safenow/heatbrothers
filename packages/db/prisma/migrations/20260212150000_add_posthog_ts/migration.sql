-- Add posthog_ts column to store the raw PostHog timestamp string
ALTER TABLE "events" ADD COLUMN "posthog_ts" TEXT NOT NULL DEFAULT '';
