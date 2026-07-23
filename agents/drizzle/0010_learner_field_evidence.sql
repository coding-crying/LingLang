-- 2026-07-10: learner-field spec v1, step 1 (docs/plans/2026-07-09-learner-field-design.md §3).
-- Schema-only groundwork for the echo gate + provenance-tagged evidence.
-- No read path changes yet — these columns are additive and default-safe.

ALTER TABLE user_vocabulary ADD COLUMN receptive_exposures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_vocabulary ADD COLUMN last_exposure TIMESTAMPTZ;
ALTER TABLE user_vocabulary ADD COLUMN comprehension_signal REAL NOT NULL DEFAULT 0;

-- provenance: 'probe' (selector-directed, highest trust) | 'conversation'
-- (passive inference, default) | 'echo' (should not normally reach this
-- table — the echo gate intercepts before grading; value kept for
-- completeness/debugging). Existing rows backfill to 'conversation' since
-- they predate provenance tracking and were all passive-inference evidence.
ALTER TABLE review_logs ADD COLUMN provenance TEXT NOT NULL DEFAULT 'conversation';
