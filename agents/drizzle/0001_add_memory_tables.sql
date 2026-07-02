-- Add session_summaries and user_notes tables for cross-session memory
-- Migration: 2026-05-10

CREATE TABLE IF NOT EXISTS "session_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "duration_minutes" integer NOT NULL,
  "topics_covered" text,
  "words_worked" text,
  "errors_pattern" text,
  "summary" text NOT NULL,
  "next_session_hint" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "category" text NOT NULL,
  "content" text NOT NULL,
  "source" text NOT NULL,
  "superseded_by_id" uuid REFERENCES "user_notes"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "session_summaries_user_idx" ON "session_summaries" ("user_id");
CREATE INDEX IF NOT EXISTS "user_notes_user_category_idx" ON "user_notes" ("user_id", "category");
