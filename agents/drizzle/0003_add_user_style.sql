-- Add user_style table for personality mirroring.
-- Migration: 2026-06-25
-- Detected style markers from the user's turns, EMA'd over time.
-- The conversation prompt reads this and tells the LLM to mirror the user's style.

CREATE TABLE IF NOT EXISTS "user_style" (
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "style_key" text NOT NULL,  -- 'humor' | 'pacing' | 'register' | 'profanity' | 'preamble' | 'bsCallouts'
  "style_value" text NOT NULL,
  "confidence" real NOT NULL DEFAULT 0.0,
  "sample_size" integer NOT NULL DEFAULT 0,
  "last_updated" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "style_key")
);

CREATE INDEX IF NOT EXISTS "user_style_user_idx" ON "user_style" ("user_id");
