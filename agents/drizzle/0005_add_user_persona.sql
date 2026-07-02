-- Migration 0005: user_persona table
-- Stores the adaptive shell of the conversation agent's prompt.
-- Writable by: supervisor (via NOTE[preference] + PERSONA: output),
--              user voice ("be more casual"), dashboard UI.
-- Read by: buildDynamicInstructions() on every prompt refresh.

CREATE TABLE IF NOT EXISTS "user_persona" (
  "user_id"         text        NOT NULL REFERENCES "users"("id"),
  "language_code"   text        NOT NULL,  -- 'pt', 'ru', 'all' (language-specific or global)

  -- Free-text persona override. When set, replaces the default base persona line.
  -- Example: "You are a sharp Lisbon local who roasts mistakes with dry wit."
  -- Null = use system default.
  "persona_override" text,

  -- Structured teaching style fields (all nullable = use defaults)
  "tone"            text,   -- 'roast' | 'warm' | 'neutral' | 'formal' | 'drill-sergeant'
  "correction_style" text,  -- 'immediate' | 'gentle' | 'ignore' | 'end-of-turn'
  "teaching_mode"   text,   -- 'conversational' | 'drill' | 'roleplay' | 'storytelling'
  "extra_instructions" text, -- freeform append: "always use tu form", "pretend we're at a café"

  -- Who last wrote this and when
  "source"          text        NOT NULL DEFAULT 'system',  -- 'system' | 'supervisor' | 'user_voice' | 'ui'
  "updated_at"      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY ("user_id", "language_code")
);
