-- 2026-07-06: curriculum ingestion + discourse memory layer.
-- See docs/superpowers/specs/2026-07-06-curriculum-design.md.
-- Record-only additions — no existing table is altered, no read path
-- changes yet. chunk_lexemes/error_observations join to the EXISTING
-- lexemes/grammar_rules tables so FSRS, the dictionary gate, and the
-- frontier see this data for free once wired.

CREATE TABLE content_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id),
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  original_ref TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded',
  ingest_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE content_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES content_sources(id),
  ord INTEGER NOT NULL,
  parent_title TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary TEXT NOT NULL,
  card TEXT NOT NULL,
  grammar_points TEXT,
  difficulty TEXT,
  embedding vector(1024)
);

CREATE INDEX content_chunks_source_ord_idx ON content_chunks (source_id, ord);
CREATE INDEX content_chunks_embedding_idx ON content_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE chunk_lexemes (
  chunk_id TEXT NOT NULL REFERENCES content_chunks(id),
  lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
  salience REAL NOT NULL DEFAULT 0.5,
  PRIMARY KEY (chunk_id, lexeme_id)
);

CREATE TABLE user_content_progress (
  user_id TEXT NOT NULL REFERENCES users(id),
  chunk_id TEXT NOT NULL REFERENCES content_chunks(id),
  status TEXT NOT NULL DEFAULT 'queued',
  coverage REAL NOT NULL DEFAULT 0,
  card_override TEXT,
  activated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, chunk_id)
);

CREATE INDEX user_content_progress_active_idx ON user_content_progress (user_id, status);

CREATE TABLE utterances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  language TEXT NOT NULL,
  transcript TEXT NOT NULL,
  analysis TEXT,
  embedding vector(1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX utterances_user_idx ON utterances (user_id, created_at);
CREATE INDEX utterances_embedding_idx ON utterances USING hnsw (embedding vector_cosine_ops);

CREATE TABLE error_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id),
  language TEXT NOT NULL,
  rule_id TEXT REFERENCES grammar_rules(id),
  rule_text TEXT NOT NULL,
  lexeme_id TEXT REFERENCES lexemes(id),
  snippet TEXT,
  utterance_id UUID REFERENCES utterances(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX error_observations_user_rule_idx ON error_observations (user_id, rule_id);
