-- Add user_language_levels table for per-language proficiency tracking.
-- Migration: 2026-06-25
-- Replaces the global `users.proficiencyLevel` field with a per-language
-- resolution so the tutor can handle multi-language users (PT + RU, etc.).

CREATE TABLE IF NOT EXISTS "user_language_levels" (
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "language_code" text NOT NULL,
  "proficiency_level" text NOT NULL DEFAULT 'pre_a1',
  "confidence" real NOT NULL DEFAULT 0.0,
  "source" text NOT NULL DEFAULT 'inferred',
  "inferred_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "language_code")
);

-- Backfill: copy any existing global users.proficiencyLevel to per-language rows.
-- The dashboard's user settings show target_language = 'pt' and 'ru', so seed those.
INSERT INTO "user_language_levels" ("user_id", "language_code", "proficiency_level", "confidence", "source")
SELECT
  u.id,
  u.target_language,
  COALESCE(u.proficiency_level, 'pre_a1'),
  1.0,  -- manual backfill from global = high confidence
  'manual'
FROM "users" u
WHERE u.target_language IS NOT NULL
ON CONFLICT ("user_id", "language_code") DO NOTHING;

-- Index for the hot path: lookup level by (user_id, language_code) for inference
CREATE INDEX IF NOT EXISTS "user_language_levels_user_lang_idx"
  ON "user_language_levels" ("user_id", "language_code");
