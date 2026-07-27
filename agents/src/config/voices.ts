/**
 * Realtime voice selection.
 *
 * One list, one default, shared by the anonymous demo and the signed-in
 * app. Before this, the demo used DEMO_GEMINI_VOICE (Charon) while the app
 * took whatever the target language's config specified (Leda for pt), so
 * the same person got two different voices either side of signing up. The
 * handoff read as a different product.
 *
 * Gemini Live fixes the voice in the setup message and the plugin's
 * updateVoice() calls markRestartNeeded(), so a change applies to the
 * user's NEXT session, never the one they're in. Anything user-facing has
 * to say so rather than appear broken.
 */

export interface VoiceOption {
  id: string;
  /** What it actually sounds like, for a settings UI. */
  label: string;
}

/** The voices Gemini Live accepts. A name outside this set is a hard
 *  connect failure (WS 1007), not a silent fallback, so user input is
 *  validated against it before it ever reaches the provider. */
export const REALTIME_VOICES: VoiceOption[] = [
  { id: 'Charon', label: 'Charon — deeper, dry, unhurried' },
  { id: 'Orus', label: 'Orus — firm and level' },
  { id: 'Puck', label: 'Puck — light and quick' },
  { id: 'Kore', label: 'Kore — firm, even' },
  { id: 'Aoede', label: 'Aoede — bright, breathy' },
  { id: 'Leda', label: 'Leda — younger, softer' },
  { id: 'Fenrir', label: 'Fenrir — energetic' },
  { id: 'Zephyr', label: 'Zephyr — bright, airy' },
];

/**
 * Default voice, demo and app alike.
 *
 * Charon because the prompt asks for dry and understated over enthusiastic
 * (see VOICE_RULES); the brighter voices actively fight that instruction,
 * which is what made the old default read as, in the user's words, an
 * annoying woman. Overridable per-deployment, then per-user.
 */
export const DEFAULT_REALTIME_VOICE =
  process.env.DEMO_GEMINI_VOICE?.trim() || process.env.GEMINI_VOICE?.trim() || 'Charon';

export function isValidVoice(v: string | null | undefined): boolean {
  return !!v && REALTIME_VOICES.some((o) => o.id === v);
}

/**
 * Pick the voice for a session: the user's setting when it's one we can
 * actually send, otherwise the default. An unknown stored value is ignored
 * rather than passed through, because the failure mode downstream is the
 * session refusing to open at all.
 */
export function resolveVoice(userVoice?: string | null): string {
  return isValidVoice(userVoice) ? userVoice! : DEFAULT_REALTIME_VOICE;
}
