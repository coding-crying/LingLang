-- 2026-07-02: session_summaries had no language scoping, so a user who
-- tested/studied multiple target languages got summaries from ALL of them
-- mixed into the planner's context for whichever language they're
-- currently in — confirmed live (Russian vocabulary hints bleeding into a
-- Portuguese session). Nullable: existing rows predate this column and
-- can't be retroactively attributed to a language, so they're excluded
-- from per-language queries going forward rather than guessed at.
ALTER TABLE session_summaries ADD COLUMN language_code TEXT;
CREATE INDEX session_summaries_user_lang_idx ON session_summaries (user_id, language_code);
