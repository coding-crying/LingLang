-- 2026-07-10: lexemes.frequency_rank was smallint (max 32767) in the actual
-- DB despite schema.ts declaring integer — a pre-existing drift. The
-- learner-field frequency backfill (spec §9) needs ranks up to 50000
-- (hermitdave/FrequencyWords 50k lists), which overflows smallint.
ALTER TABLE lexemes ALTER COLUMN frequency_rank TYPE INTEGER;
