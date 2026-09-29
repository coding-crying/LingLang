/**
 * Realtime (S2S) utterance segmentation.
 *
 * Why this exists
 * ---------------
 * The cascaded pipeline gets turn boundaries for free: VAD end-of-utterance →
 * STT FINAL_TRANSCRIPT → one LLM reply. The transcript UI and the processor
 * are built on that 1:1 turn model (monotonic `turnSeq`, bubble ids
 * `user-<turnSeq>` / `agent-<turnSeq>`).
 *
 * A realtime model has no STT node and no VAD EOU. The Google plugin streams
 * the *cumulative* input transcription for a whole generation, and one
 * generation can span several user utterances — the learner speaks, the model
 * starts answering, the learner barges in and speaks again. Treating that blob
 * as one turn is what produced 200-word "user" bubbles that merged unrelated
 * utterances (and, before that, made every agent reply collide on turnSeq 0).
 *
 * What we do instead
 * ------------------
 * Rebuild utterance spans from the session's own state transitions
 * (`UserStateChanged`: speaking → listening) and flush the accumulated text
 * once per span. The span also carries:
 *   - durationSec — VAD span length, feeds the processor's hallucination guard
 *   - latencySec  — how long the learner took to start after the tutor stopped
 *   - audio       — the PCM for exactly that span, from UserAudioTap
 *
 * Deltas (isFinal=false) never reach the cascaded handler; the flushed span
 * re-enters it as a synthetic final transcript, so downstream behavior
 * (history, dedupe, processor batching, PTT) is unchanged.
 */
import type { AudioSlice } from './user-audio-tap.js';
import type { UserAudioTap } from './user-audio-tap.js';
import type { AudioFrame } from '@livekit/rtc-node';

export type RealtimeUtterance = {
  text: string;
  itemId: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  latencySec: number | null;
  audio: { audioId: string; durationSec: number; rms?: number; peak?: number } | null;
  reason: string;
};

type RegisterFn = (frames: AudioFrame[]) => { audioId: string; durationSec: number } | null;

export class RealtimeUtteranceTracker {
  private cumulative = '';
  private itemId = '';
  private utteranceCount = 0;
  private pending = '';
  private spanStart = 0;
  private spanEnd = 0;
  private lastAgentSpeechEnd = 0;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly graceMs: number;

  constructor(
    private readonly opts: {
      onUtterance: (u: RealtimeUtterance) => void;
      audioTap?: UserAudioTap | null;
      registerAudio?: RegisterFn | null;
      flushGraceMs?: number;
    },
  ) {
    this.graceMs = opts.flushGraceMs ?? 700;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.opts.audioTap?.start();
  }

  stop(): void {
    this.cancelTimer();
    this.opts.audioTap?.stop();
  }

  /**
   * Feed every UserInputTranscribed event. `cumulative` is the plugin's
   * running accumulation for the current generation; we diff it ourselves.
   */
  onTranscription(itemId: string | undefined, cumulative: string, isFinal: boolean): void {
    if (itemId && itemId !== this.itemId) {
      // New generation. Any text still unflushed belongs to the previous one.
      if (this.pending.length > 0) this.flush('generation-rollover');
      this.itemId = itemId;
      this.cumulative = '';
      this.utteranceCount = 0;
    }

    const delta = cumulative.startsWith(this.cumulative)
      ? cumulative.slice(this.cumulative.length)
      : cumulative;
    this.cumulative = cumulative;

    if (delta) {
      if (this.pending.length === 0 && this.spanStart === 0) this.spanStart = Date.now();
      this.pending += delta;
      this.spanEnd = Date.now();
    }

    if (isFinal) {
      this.cancelTimer();
      this.flush('final');
    } else if (this.pending.length > 0) {
      // Transcription can trail the VAD release by a few hundred ms; wait a
      // beat so the tail of the utterance is included before we emit.
      this.scheduleFlush();
    }
  }

  /** Key shared by provisional UI text and its eventual final/rejection. */
  get currentItemId(): string {
    return this.utteranceCount === 0 ? this.itemId : `${this.itemId}#${this.utteranceCount}`;
  }

  /** In-progress (unflushed) text for the current span — for live UI. */
  get currentText(): string {
    return this.pending.trim();
  }

  /** UserStateChanged: speaking | listening | away. */
  onUserState(newState: string): void {
    if (newState === 'speaking') {
      this.cancelTimer();
      if (this.pending.length > 0) {
        // Previous span never got its grace window — close it now.
        this.flush('speech-restart');
      }
      this.spanStart = Date.now();
      this.spanEnd = 0;
      return;
    }
    if (this.pending.length > 0) {
      this.spanEnd = Date.now();
      this.scheduleFlush();
    }
  }

  /** AgentStateChanged: speaking | listening | thinking | idle. */
  onAgentState(newState: string): void {
    if (newState !== 'speaking') this.lastAgentSpeechEnd = Date.now();
  }

  private scheduleFlush(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush('grace');
    }, this.graceMs);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flush(reason: string): void {
    this.cancelTimer();
    const text = this.pending.trim();
    this.pending = '';
    if (!text) {
      this.spanStart = 0;
      this.spanEnd = 0;
      return;
    }

    const endedAt = this.spanEnd || Date.now();
    const startedAt = this.spanStart || endedAt;
    const durationSec = Math.max(0.3, (endedAt - startedAt) / 1000);

    let latencySec: number | null = null;
    if (this.lastAgentSpeechEnd > 0) {
      const gap = (startedAt - this.lastAgentSpeechEnd) / 1000;
      // Negative = the learner talked over the tutor (barge-in); ignore
      // absurd gaps (session start, long silence) rather than report them.
      if (gap >= -1 && gap <= 30) latencySec = Math.max(0, Number(gap.toFixed(2)));
    }

    let audio: { audioId: string; durationSec: number; rms?: number; peak?: number } | null = null;
    const tap = this.opts.audioTap;
    const register = this.opts.registerAudio;
    if (tap && register) {
      const slice = tap.slice(startedAt, endedAt);
      if (slice) {
        const registered = register(slice.frames);
        // Energy of exactly the frames we handed over, so the transcript guard
        // can tell a real utterance from a phantom one (see the guard module).
        if (registered) audio = { ...registered, rms: slice.rms, peak: slice.peak };
      }
    }

    this.spanStart = 0;
    this.spanEnd = 0;
    // NOTE: `cumulative` is deliberately NOT reset here — it tracks the
    // plugin's accumulation for the whole generation, and the next delta is
    // diffed against it. Resetting it mid-generation makes every following
    // delta look new and re-emits the text already flushed.

    // One generation can hold several utterances (barge-in). The frontend
    // keys bubbles on itemId and ignores a duplicate id, so a second span in
    // the same generation would be silently dropped. Suffix everything after
    // the first; the first keeps the raw id so the live partial bubble (keyed
    // on the raw generation id) is replaced rather than duplicated.
    const utteranceId = this.currentItemId;
    this.utteranceCount += 1;

    this.opts.onUtterance({
      text,
      itemId: utteranceId,
      startedAt,
      endedAt,
      durationSec: Number(durationSec.toFixed(2)),
      latencySec,
      audio,
      reason,
    });
  }
}
