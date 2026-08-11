-- New accounts must choose a target language explicitly.
-- Existing values are intentionally preserved.
ALTER TABLE users
  ALTER COLUMN target_language DROP DEFAULT,
  ALTER COLUMN target_language DROP NOT NULL;

-- Migration bookkeeping is handled by the deployment script.
