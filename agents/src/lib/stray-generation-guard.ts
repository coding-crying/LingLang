/**
 * Stray-generation guard for realtime (S2S) sessions.
 *
 * gemini-3.1-flash-live-preview sometimes emits a SECOND model turn for one
 * input: generation A completes (`turnComplete`), then 0.5-6s later a brand
 * new generation starts with no learner speech in between. The learner hears
 * the tutor say two things back-to-back — on first load the greeting gets
 * split ("Hey, so," / "how's it going today?") or the model asks a second
 * unprompted question right after the first.
 *
 * Confirmed in the 2026-09-09 15:57 gritz session (new user onboarding):
 *   GR_1be8827c  "Hey, so,"                         turnComplete, 26 tokens
 *   +0.6s gap, no inputTranscription, no tool call
 *   GR_3add822f  "how's it going today? Is it *muy* cold *afuera*..."
 * and in the 16:49 will session: greeting, then 1.9s later a whole second
 * question ("E hoje? Como te sentes?") that the learner answered with
 * "You say two things at once."
 *
 * The server decides when to generate; we cannot stop it. What we can do is
 * refuse to play it: the SDK's `speech_created` event hands us the
 * SpeechHandle before it is authorized, and `handle.interrupt(true)` makes
 * the generation task return early — no audio, no transcript bubble.
 *
 * The discriminator is "did the learner actually speak since the last agent
 * turn?":
 *   - a normal reply always follows learner speech  → never cancelled
 *   - a tool-call follow-up never follows learner speech → tool grace window
 *   - a first generation is the opening greeting    → never cancelled
 *   - a prompt after a long silence (>8s) is legitimate tutor behaviour
 *     → outside the window, left alone
 */
export const STRAY_GENERATION_WINDOW_MS = 8_000;
export const TOOL_REPLY_GRACE_MS = 20_000;

export class StrayGenerationGuard {
  private generations = 0;
  private lastTurnEndMs = 0;
  private learnerSpoke = false;
  private toolReplyUntilMs = 0;

  /**
   * Debug/verification hook: cancel every realtime generation (including the
   * opening greeting) so the suppression path can be exercised on demand.
   * Wired to LINGLANG_STRAY_GUARD_FORCE=1; never set in production.
   */
  constructor(private readonly opts: { forceCancel?: boolean } = {}) {}

  /** Learner audio (tap energy) or transcription arrived — a real turn. */
  noteLearnerSpeech(): void {
    this.learnerSpoke = true;
  }

  /** A tool ran; the generation that reports its result must play. */
  noteToolExecuted(nowMs: number = Date.now()): void {
    this.toolReplyUntilMs = nowMs + TOOL_REPLY_GRACE_MS;
  }

  /** Agent stopped speaking (state left thinking/speaking). */
  noteAgentTurnEnded(nowMs: number = Date.now()): void {
    this.lastTurnEndMs = nowMs;
  }

  /**
   * Call once per non-user-initiated generation, BEFORE anything is played.
   * Returns true when the generation should be cancelled.
   */
  onGenerationStart(nowMs: number = Date.now()): boolean {
    this.generations += 1;
    if (this.opts.forceCancel) {
      this.learnerSpoke = false;
      return true;
    }
    const isFirstGeneration = this.generations === 1;
    const cancel =
      !isFirstGeneration &&
      nowMs >= this.toolReplyUntilMs &&
      !this.learnerSpoke &&
      this.lastTurnEndMs > 0 &&
      nowMs - this.lastTurnEndMs <= STRAY_GENERATION_WINDOW_MS;
    // Whatever happens, this generation consumes the learner's turn.
    this.learnerSpoke = false;
    return cancel;
  }

  get generationCount(): number {
    return this.generations;
  }
}
