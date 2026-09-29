-- SPDX-License-Identifier: Apache-2.0
-- Already migrated deployments: don't re-import cleared legacy choices on rerun.
ALTER TABLE user_persona ADD COLUMN IF NOT EXISTS preferences_migrated boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS conversation_tombstones (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id text NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,session_id)
);
