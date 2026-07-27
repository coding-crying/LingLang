-- Realtime TTS voice, per user per language.
--
-- Until now the voice came from the target language's config, which meant
-- the demo (Charon) and the app (Leda for pt) greeted the same person in
-- two different voices either side of signing up. It reads as a different
-- product. Voice is connect-time config for Gemini Live and cannot change
-- mid-session, so a change here applies to the user's next session.
ALTER TABLE user_persona ADD COLUMN IF NOT EXISTS voice text;
