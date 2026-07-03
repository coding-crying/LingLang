-- 2026-07-02: scope active_goals by language. Goals were unscoped, so a
-- Portuguese remediation goal surfaced in a Russian session's planner
-- prompt (confirmed live). Backfill from the target lexeme's language;
-- rows whose target_id no longer resolves stay NULL and are excluded
-- from per-language queries.
ALTER TABLE active_goals ADD COLUMN language_code TEXT;

UPDATE active_goals
SET language_code = l.language
FROM lexemes l
WHERE active_goals.target_id = l.id;

CREATE INDEX active_goals_user_lang_idx ON active_goals (user_id, language_code);
