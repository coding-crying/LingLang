-- SPDX-FileCopyrightText: 2025 LiveKit, Inc.
-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS model_prompt_versions (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_key text NOT NULL, revision integer NOT NULL, guidance text,
 evaluation_id text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,profile_key,revision), CHECK (length(guidance)<=2000)
);
CREATE TABLE IF NOT EXISTS model_alignment_jobs (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_key text NOT NULL, status text NOT NULL,
 report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS model_alignment_one_active ON model_alignment_jobs(user_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS model_alignment_owner ON model_alignment_jobs(user_id,created_at DESC);
