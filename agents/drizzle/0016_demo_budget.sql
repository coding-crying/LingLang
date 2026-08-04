-- Global spending cap for anonymous public-demo traffic, which has no
-- auth and no per-user budget of its own — closes the gap where its
-- ElevenLabs fallback (demo.ts) and Gemini-realtime usage (the live
-- anonymous demo worker) were tracked nowhere.
-- Migration: 2026-08-03

CREATE TABLE IF NOT EXISTS "demo_budget" (
  "id" text PRIMARY KEY DEFAULT 'global',
  "spent_micros" integer NOT NULL DEFAULT 0,
  "limit_micros" integer NOT NULL DEFAULT 500000,
  "period_start" timestamp with time zone NOT NULL DEFAULT now()
);
