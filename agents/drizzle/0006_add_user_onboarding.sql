CREATE TABLE user_onboarding (
  user_id           TEXT        NOT NULL REFERENCES users(id),
  language_code     TEXT        NOT NULL,
  -- completion flags (either path counts as done)
  ui_complete       BOOLEAN     NOT NULL DEFAULT FALSE,
  voice_complete    BOOLEAN     NOT NULL DEFAULT FALSE,
  -- background captured by processor / UI
  prior_study       TEXT,        -- 'none'|'self_taught'|'class'|'immersion'|'heritage'
  study_details     TEXT,        -- free text: "Duolingo 6 months", "Pimsleur level 2"
  goals             TEXT[],      -- ['travel','work','heritage','media','academic','other']
  goal_details      TEXT,        -- free text: "moving to Lisbon in 6 months"
  self_rated_level  TEXT,        -- user's own CEFR estimate
  -- anchored level (written by commitOnboardingLevel after enough signal)
  anchored_level    TEXT,
  anchor_confidence REAL,
  anchor_evidence   TEXT,
  -- timestamps
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  PRIMARY KEY (user_id, language_code)
);
