-- 2026-08-08: content provenance — see docs/superpowers/specs/2026-08-08-content-provenance-design.md.
--
-- The ingestion pipeline (0009/0014/0015) already turns a source into
-- chunks + lexemes, and placeUserInSource already does a coverage-based
-- "knowledge diff" to decide where a learner starts. That diff reads
-- user_vocabulary — so for a learner whose knowledge came from OUTSIDE
-- this app (25 Pimsleur lessons, half a textbook), it computes 0% coverage
-- and drops them at lesson 1. The pipeline isn't wrong; it has no way to
-- be told what the learner already knows.
--
-- This table is that channel. It is per (user, source) rather than a set
-- of columns on content_sources because the same shared/global source is
-- at a different point for every learner, and because a learner re-profiles
-- ("I came back after 3 months") without touching anyone else's state.

CREATE TABLE user_source_profiles (
  user_id TEXT NOT NULL REFERENCES users(id),
  source_id TEXT NOT NULL REFERENCES content_sources(id),

  -- What this source IS to this learner. Drives whether reconciliation
  -- seeds prior knowledge at all:
  --   'study'  — working through it; seed what's behind them, queue the rest
  --   'known'  — already finished it; seed all of it, nothing queued
  --   'aspire' — want to get here but haven't; seed NOTHING, it's a target
  intent TEXT NOT NULL DEFAULT 'study',

  -- 'needed'   — greyed out in the library; nothing reconciled yet
  -- 'complete' — every required question answered
  -- 'skipped'  — learner declined to answer; treated as a cold start
  status TEXT NOT NULL DEFAULT 'needed',

  -- Free-form answers keyed by question id (lib/content-profile.ts owns the
  -- question specs). Everything the reconciler actually reads is promoted
  -- to a real column below; this keeps the rest (exercise preferences, goal
  -- text, notes gathered mid-conversation) without a migration per question.
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ── Promoted answers: the reconciler's inputs ──
  -- Chunks with ord <= this are treated as already-studied. Null when the
  -- learner hasn't told us (or said "just starting").
  known_through_ord INTEGER,
  -- When they last actually worked on it. THE critical field for a course
  -- with a time delay: it backdates the seeded FSRS cards so material from
  -- 25 days ago surfaces as overdue while last week's does not.
  last_studied_at TIMESTAMPTZ,
  -- How hard they worked it, which sets seed stability.
  -- 'drilled' | 'studied' | 'skimmed'
  intensity TEXT,

  profiled_at TIMESTAMPTZ,
  -- Set by reconcileSourceProgress once seeding has run. Cleared whenever
  -- the profile changes so a re-answer re-reconciles.
  reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, source_id)
);

CREATE INDEX user_source_profiles_pending_idx
  ON user_source_profiles (user_id, status)
  WHERE status = 'needed';

-- Provenance on the seeded rows themselves. Without this, a card seeded
-- from "I did Pimsleur 1-25" is indistinguishable from one the learner
-- actually earned in conversation here — which matters because seeded
-- knowledge is a CLAIM, not an observation, and the frontier/level
-- inference should be able to discount it.
ALTER TABLE user_vocabulary
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'conversation';

COMMENT ON COLUMN user_vocabulary.origin IS
  '''conversation'' = earned in a live session; ''seeded'' = asserted via a content profile and never yet confirmed in speech.';
