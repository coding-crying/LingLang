/**
 * Realtime transcript guard — rejects learner turns the model invented.
 *
 * Evidence (live session, beta user "gritz", 2026-09-09 15:58 local)
 * ------------------------------------------------------------------
 * The first user turn of the session was logged as:
 *
 *   (server) <- {"inputTranscription":{"text":"Hey, so, how's it going today?
 *                Is it muy cold? Afuera? Where are you? Very cold outside?"}}
 *   [Trace] rt.utterance reason=final dur=0.3s audio=amtup9ggl1
 *   [GemmaAudioSTT] ... 3200 samples (0.20s @ 16000Hz) rms=0.000, peak=0.000
 *
 * The "learner" text is the tutor's OWN greeting (both stray generations,
 * concatenated), the captured audio is 0.20s of digital silence, and the
 * learner had not spoken yet. Consequences, all confirmed live:
 *   - the dashboard showed the tutor's sentence in the learner's bubble;
 *   - the processor graded the tutor's words as learner speech;
 *   - the session summary concluded the learner "is repeating the tutor's
 *     input verbatim", which is a description of the bug, not of the learner.
 *
 * With the SRS loop repaired (2026-09-10), an invented turn is no longer just
 * cosmetic: it writes FSRS grades for words the learner never said. So the
 * turn is dropped before it reaches history, the processor, or the planner.
 *
 * Discriminators, cheapest and most physical first
 * ------------------------------------------------
 *  1. silent-span — the mic carried no audio for this turn, but the tap has
 *     proven it can hear this session's mic at all (it saw energy on other
 *     turns). Digital silence cannot contain speech: the text is fabricated.
 *     Evidence spans the pending input interval, not just text arrival. Missing
 *     or discontinuous silence capture is unknown, never affirmative evidence.
 *  2. tutor-echo — matching tutor text plus continuously captured EXACT digital
 *     silence. Unknown capture or quiet speech is accepted, even for repetition.
 *     This deliberately prefers avoiding false accusations over speculative filtering.
 *
 * Everything else is accepted: a beginner repeating the tutor's phrase is real
 * practice, so an echo is only rejected when the audio says nobody spoke.
 */
// Exact digital silence is the only rejecting amplitude; no loudness threshold.
/** Share of the turn's words that must already sit in the tutor's last lines. */
export const ECHO_OVERLAP_RATIO = 0.8;

/** Below this many words, an overlap is a normal one-word echo, not a copy. */
export const ECHO_MIN_TOKENS = 4;


export type RealtimeTranscriptSignals = {
  text: string;
  /** The tutor's last 1-2 spoken lines (history.getRecentTutorText()). */
  tutorText?: string | null;
  /**
   * Peak mic amplitude (0-1) anywhere near this turn — not just inside the
   * segmenter's span, which is derived from text arrival, not speech.
   * null/undefined = unknown (tap off, or window predates the buffer).
   */
  nearbyPeak?: number | null;
  /** The tap has heard this session's mic at least once. false ⇒ rule 1 is off. */
  tapHealthy?: boolean;
  /** Text-arrival span in seconds. Diagnostic only — not a speech duration. */
  spanSec?: number | null;
};

export type RealtimeTranscriptVerdict = {
  accept: boolean;
  reason: 'silent-span' | 'tutor-echo' | null;
  detail: string;
};

/** Lowercase, accent-folded word tokens of 2+ characters. */
export function tokenize(text: string): string[] {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Share of `candidate`'s distinct words that also appear in `source`. */
export function overlapRatio(candidate: string, source: string): number {
  const cand = new Set(tokenize(candidate));
  if (cand.size === 0) return 0;
  const src = new Set(tokenize(source));
  let hits = 0;
  for (const t of cand) if (src.has(t)) hits++;
  return hits / cand.size;
}

export function assessRealtimeTranscript(
  signals: RealtimeTranscriptSignals,
): RealtimeTranscriptVerdict {
  const text = (signals.text ?? '').trim();
  const tokens = tokenize(text);
  const peak = typeof signals.nearbyPeak === 'number' ? signals.nearbyPeak : null;
  const spanSec = typeof signals.spanSec === 'number' ? signals.spanSec : null;
  const rate = spanSec && spanSec > 0 ? Number((tokens.length / spanSec).toFixed(1)) : null;
  const echo = overlapRatio(text, signals.tutorText ?? '');

  // 1. Silent span, with a tap that is known to hear this mic.
  if (signals.tapHealthy === true && peak !== null && peak === 0 && text.length > 0) {
    return {
      accept: false,
      reason: 'silent-span',
      detail: `tap healthy; exact digital silence peak=${peak.toFixed(4)}; ${tokens.length} words in ${spanSec ?? '?'}s`,
    };
  }

  // 2. Near-verbatim copy of the tutor while the mic was not clearly audible.
  if (tokens.length >= ECHO_MIN_TOKENS && echo >= ECHO_OVERLAP_RATIO && peak === 0) {
    return {
      accept: false,
      reason: 'tutor-echo',
      detail: `overlap=${(echo * 100).toFixed(0)}% with tutor (${tokens.length} words), peak=${peak?.toFixed(4) ?? 'unknown'}`,
    };
  }
  // Unknown capture and textual overlap cannot distinguish practice from echo.
  // Only exact digital silence is affirmative evidence; quiet speech is speech.

  const notes: string[] = [];
  if (rate !== null && rate > 8) notes.push(`implausible-rate=${rate}wps`);
  if (echo >= ECHO_OVERLAP_RATIO && tokens.length >= ECHO_MIN_TOKENS) notes.push(`echo=${(echo * 100).toFixed(0)}%-${peak === null ? 'audio-unknown' : 'with-audio'}`);
  return {
    accept: true,
    reason: null,
    detail: notes.length > 0 ? notes.join(' ') : `peak=${peak?.toFixed(4) ?? 'unknown'}`,
  };
}
