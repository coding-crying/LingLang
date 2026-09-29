-- Opaque, revocable dashboard sessions. Bearer tokens stay in HttpOnly cookies;
-- only SHA-256 digests are persisted. No learning tables are altered.
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry_idx ON dashboard_sessions (expires_at);
CREATE INDEX IF NOT EXISTS dashboard_sessions_user_idx ON dashboard_sessions (user_id);
