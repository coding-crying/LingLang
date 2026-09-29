/**
 * User audio tap for realtime (S2S) sessions.
 *
 * The cascaded pipeline gets its PCM from the STT node: GemmaAudioSTT owns the
 * input frames, slices them at VAD boundaries, encodes a WAV and registers it
 * in `audioPayloadRegistry` under a short key. The transcript then carries
 * `[audio key=<id> dur=<n>s]`, and everything downstream (chat playback,
 * processor pronunciation context, the duration-based hallucination guard)
 * hangs off that key.
 *
 * A realtime session (Gemini Live) has no STT node, so none of that exists:
 * the learner's turn arrives as text and the audio is gone. This tap reads the
 * same remote mic track in parallel with the model, keeps a rolling buffer,
 * and hands back the frames that cover a given utterance span.
 *
 * Read-only and side-effect free — it never touches the frames the model
 * receives. Multiple AudioStream consumers per remote track are supported.
 */
import {
  AudioStream,
  Room,
  RoomEvent,
  TrackKind,
  type AudioFrame,
} from '@livekit/rtc-node';

export type AudioSlice = {
  frames: AudioFrame[];
  durationSec: number;
  /** Normalised RMS of the whole slice (0-1). Silence ⇒ 0. */
  rms: number;
  /** Normalised peak sample (0-1). Digital silence ⇒ 0 exactly. */
  peak: number;
};

/** Exact digital silence only; low amplitude is not proof of absent speech. */
export const SILENCE_PEAK = 0;

export class UserAudioTap {
  private buf: { frame: AudioFrame; t: number }[] = [];
  private attached = new Set<string>();
  private stopped = false;

  /**
   * Fired for frames whose energy clears `SPEECH_RMS_FLOOR`. This is the
   * earliest possible "the learner is actually speaking" signal — it beats
   * Gemini's own transcription by hundreds of ms, which is what the
   * stray-generation guard needs to tell a real reply from a phantom turn.
   */
  onSpeechEnergy: ((rms: number) => void) | null = null;

  private static readonly SPEECH_RMS_FLOOR = 0.02;

  private speechFrames = 0;

  /**
   * True once any frame has cleared the speech floor. Used as a safety valve:
   * a silent span only proves a hallucinated turn if the tap has proven it can
   * hear this session's mic at all. If the tap never sees energy (track not
   * subscribed, permissions, a future bot loopback), callers must fall back to
   * accepting transcripts rather than dropping every turn.
   */
  get hasSeenSpeech(): boolean {
    return this.speechFrames > 0;
  }

  constructor(
    private readonly room: Room,
    private readonly sampleRate = 16000,
    private readonly windowMs = 45_000,
  ) {}

  /** Attach to every remote audio publication, now and in the future. */
  start(): void {
    for (const participant of this.room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) this.attachPub(pub);
    }
    this.room.on(RoomEvent.TrackSubscribed, (_track: unknown, pub: unknown) => this.attachPub(pub));
  }

  stop(): void {
    this.stopped = true;
    this.buf = [];
  }

  private attachPub(pub: any): void {
    if (this.stopped) return;
    if (pub?.kind !== TrackKind.KIND_AUDIO) return;
    const track = pub?.track;
    if (!track) return;
    const sid = String(pub?.sid ?? pub?.name ?? 'unknown');
    if (this.attached.has(sid)) return;
    this.attached.add(sid);

    const stream = new AudioStream(track, this.sampleRate, 1);
    void (async () => {
      try {
        for await (const frame of stream) {
          if (this.stopped) break;
          this.push(frame);
        }
      } catch (err) {
        console.warn(`[AudioTap] stream ended (${sid}): ${String(err).slice(0, 120)}`);
      }
    })();
  }

  private pushed = 0;

  private push(frame: AudioFrame): void {
    const t = Date.now();
    this.buf.push({ frame, t });
    const cutoff = t - this.windowMs;
    while (this.buf.length > 0 && (this.buf[0]?.t ?? t) < cutoff) this.buf.shift();
    this.pushed++;
    // Energy is measured unconditionally: `hasSeenSpeech` is a safety valve for
    // the transcript guard, so it must not depend on a callback being wired.
    {
      const d = frame.data;
      let sum = 0;
      for (let i = 0; i < d.length; i++) {
        const v = d[i] as number;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / Math.max(1, d.length)) / 32768;
      if (rms >= UserAudioTap.SPEECH_RMS_FLOOR) {
        this.speechFrames++;
        this.onSpeechEnergy?.(rms);
      }
    }
    if (process.env.LINGLANG_AUDIO_TAP_DEBUG === '1' && (this.pushed === 1 || this.pushed % 100 === 0)) {
      console.log(`[AudioTap] frames=${this.pushed} buffered=${this.buf.length}`);
    }
  }

  /**
   * PCM captured between two wall-clock timestamps. A little padding on both
   * ends covers VAD onset/release and frame jitter so we never clip the first
   * or last syllable. Returns null when the span predates the buffer or is too
   * short to be speech.
   */
  slice(startMs: number, endMs: number, padMs = 200): AudioSlice | null {
    if (this.buf.length === 0) return null;
    const from = startMs - padMs;
    const to = endMs + padMs;
    const frames = this.buf.filter((b) => b.t >= from && b.t <= to).map((b) => b.frame);
    if (frames.length === 0) return null;
    const samples = frames.reduce((n, f) => n + f.samplesPerChannel, 0);
    const durationSec = samples / this.sampleRate;
    if (durationSec < 0.2) return null;
    let sumSq = 0;
    let n = 0;
    for (const f of frames) {
      const d = f.data;
      for (let i = 0; i < d.length; i++) {
        const v = (d[i] as number) / 32768;
        sumSq += v * v;
        n++;
      }
    }
    return { frames, durationSec, rms: Math.sqrt(sumSq / Math.max(1, n)), peak: peakOf(frames) };
  }

  /**
   * Peak amplitude (0-1) of everything captured inside a wall-clock window.
   * Used to answer "was the learner speaking anywhere near this turn?" without
   * trusting the segmenter's span bounds — the text can land well after the
   * speech it describes, so a tight span can look silent on a real turn.
   * Returns null when the window has no frames at all (predates the buffer).
   */
  peakIn(startMs: number, endMs: number): number | null {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    const samples = this.buf.filter((b) => b.t >= startMs && b.t <= endMs);
    if (samples.length === 0) return null;
    const peak = peakOf(samples.map((b) => b.frame));
    if (peak > 0) return peak;
    // Only a continuously captured interval can prove silence. Do not mistake
    // an expired buffer, network gap, or stopped track for a silent learner.
    // 100ms accommodates frame scheduling jitter, not missing utterances.
    let previous = startMs;
    for (const b of samples) {
      if (b.t - previous > 100) return null;
      previous = b.t;
    }
    return endMs - previous <= 100 ? 0 : null;
  }
}

function peakOf(frames: AudioFrame[]): number {
  let peak = 0;
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i] as number) / 32768;
      if (v > peak) peak = v;
    }
  }
  return peak;
}
