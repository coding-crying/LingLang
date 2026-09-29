-- SPDX-FileCopyrightText: 2025 LiveKit, Inc.
-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE user_persona ADD COLUMN IF NOT EXISTS explicit_preferences jsonb NOT NULL DEFAULT '{}';
ALTER TABLE user_persona ADD COLUMN IF NOT EXISTS inferred_preferences jsonb NOT NULL DEFAULT '{}';
ALTER TABLE user_persona ADD COLUMN IF NOT EXISTS preferences_migrated boolean NOT NULL DEFAULT false;
-- Existing values have ambiguous field-level authorship: protect them conservatively.
-- Missing keys only; this migration can be re-run without overwriting a user's edits.
UPDATE user_persona SET explicit_preferences = jsonb_strip_nulls(jsonb_build_object(
  'tone', tone, 'correctionStyle', correction_style, 'teachingMode', teaching_mode,
  'personaOverride', persona_override, 'extraInstructions', extra_instructions, 'voice', voice
)) || explicit_preferences, preferences_migrated=true WHERE NOT preferences_migrated;
ALTER TABLE user_persona ALTER COLUMN preferences_migrated SET DEFAULT true;
CREATE TABLE IF NOT EXISTS conversation_events (
  seq bigserial UNIQUE NOT NULL,
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  turn_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('learner', 'tutor')),
  language text NOT NULL,
  occurred_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('final', 'corrected', 'rejected')),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_events_owner_session ON conversation_events(user_id, session_id, seq);
CREATE INDEX IF NOT EXISTS conversation_events_owner_time ON conversation_events(user_id, occurred_at DESC);
