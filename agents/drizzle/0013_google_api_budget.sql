-- Per-user Google API key (BYO) + usage budget for the shared key.
-- Migration: 2026-07-17

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_api_key_encrypted" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_usage_micros" integer NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_usage_limit_micros" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_usage_period_start" timestamp with time zone NOT NULL DEFAULT now();
