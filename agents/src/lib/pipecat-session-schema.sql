-- Pipecat session authorization; apply to isolated/new installs first.
-- Worker credentials are stored as SHA-256 digests, never plaintext.
CREATE TABLE IF NOT EXISTS pipecat_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('smallwebrtc', 'livekit')),
  expires_at bigint NOT NULL,
  worker_hash text,
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS pipecat_sessions_owner ON pipecat_sessions(user_id);
CREATE INDEX IF NOT EXISTS pipecat_sessions_expiry ON pipecat_sessions(expires_at);

CREATE TABLE IF NOT EXISTS pipecat_events (
  session_id text NOT NULL REFERENCES pipecat_sessions(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  processing_status text NOT NULL DEFAULT 'pending',
  accepted_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY(session_id,event_id)
);
CREATE INDEX IF NOT EXISTS pipecat_events_pending ON pipecat_events(accepted_at) WHERE processing_status='pending';
