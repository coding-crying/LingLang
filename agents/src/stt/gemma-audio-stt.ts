import { stt, asLanguageCode } from '@livekit/agents';
import { type AudioFrame, combineAudioFrames } from '@livekit/rtc-node';
import type { APIConnectOptions } from '@livekit/agents';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// This custom STT acts as a buffer. It doesn't transcribe text itself.
// It chunks audio and emits a SHORT placeholder transcript — the actual audio
// is stashed in `audioPayloadRegistry` keyed by an opaque id, and
// `GemmaAudioLLM.buildMessages()` looks it up by the placeholder id.
//
// We CANNOT put the full base64 audio URI in the transcript text because
// LiveKit's RoomIO.forwardUserTranscript forwards the transcript via a
// data channel (`streamText`). Sending 100+KB base64 through that channel
// times out and wedges the entire agent pipeline (text forwarding, audio
// forwarding, planner retries — all blocked behind the await on captureText).

/**
 * Module-level registry of in-flight audio payloads.
 * Key: short opaque id (millisecond timestamp + counter)
 * Value: { uri: data:audio/wav;base64,.., durationSec, sampleRate, samples }
 *
 * Audio is added by `framesToAudioPayload()` and looked up by `GemmaAudioLLM`
 * when it sees a matching placeholder in the chat context. Entries are NOT
 * deleted after being forwarded (a prior version of this comment claimed
 * they were — false, checked 2026-07-10) — they live until the 5-min GC or
 * the 64-entry cap, which is what makes `transcript` below possible: the
 * processor's transcription (computed asynchronously, after the audio was
 * already sent once as real audio) can still be attached to the SAME entry
 * for GemmaAudioLLM to use next time this turn gets collapsed out of the
 * real-audio window. See setAudioTranscript / MAX_AUDIO_TURNS.
 */
export const audioPayloadRegistry = new Map<
  string,
  { uri: string; durationSec: number; sampleRate: number; samples: number; createdAt: number; transcript?: string }
>();

let audioCounter = 0;

/** Generate a short opaque id. */
function newAudioId(): string {
  return `a${Date.now().toString(36)}${(++audioCounter).toString(36)}`;
}

/**
 * Attach the processor's real transcription to an audio entry, once known.
 * 2026-07-10: closes the gap where GemmaAudioLLM's buildMessages() had
 * nothing but a generic "[user spoke earlier]" placeholder for collapsed
 * (non-current) audio turns — we already compute a real transcript via the
 * processor's transcription cascade (transcribeAudioWithLocalLLM), it just
 * never reached the conversation model. No-op if the entry already aged
 * out of the registry (rare — GC is 5min, processor results land in
 * seconds).
 */
export function setAudioTranscript(audioId: string, transcript: string): void {
  const entry = audioPayloadRegistry.get(audioId);
  if (entry) entry.transcript = transcript;
}

/** Cleanup entries older than `maxAgeMs` (default 5 min). */
export function gcAudioRegistry(maxAgeMs = 5 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [k, v] of audioPayloadRegistry) {
    if (v.createdAt < cutoff) audioPayloadRegistry.delete(k);
  }
}

/**
 * Encode an Int16Array of mono PCM samples as a 16kHz 16-bit mono WAV file.
 */
function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);                    // PCM
  buffer.writeUInt16LE(1, 22);                    // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);       // byte rate (16-bit mono)
  buffer.writeUInt16LE(2, 32);                    // block align
  buffer.writeUInt16LE(16, 34);                   // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i] || 0, 44 + i * 2);
  }
  return buffer;
}

// Debug: dump every captured turn's WAV to disk for by-ear inspection.
// Enable with LINGLANG_DUMP_AUDIO=1 (or a directory path). Added 2026-07-10
// while chasing live mis-hearings ("холодец" → "послушал", a whole turn
// heard as German): every controlled variable (prompt size, message format,
// history, temperature) tested clean with a known-good clip, so the last
// suspect is the actual mic capture quality — which we can't judge without
// hearing it. Also logs RMS/peak per turn so gain problems show in the log
// even without listening.
const DUMP_AUDIO = process.env.LINGLANG_DUMP_AUDIO;
const DUMP_DIR = DUMP_AUDIO && DUMP_AUDIO !== '1' ? DUMP_AUDIO : '/tmp/linglang-audio-dumps';

function audioStats(samples: Int16Array): { rms: number; peak: number } {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] || 0;
    sumSq += v * v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  return { rms: Math.sqrt(sumSq / samples.length) / 32768, peak: peak / 32768 };
}

function framesToAudioPayload(frames: AudioFrame[]): { event: stt.SpeechEvent; wavBytes: number } | null {
  if (!frames || frames.length === 0) return null;

  // Use the official combineAudioFrames — handles sampleRate/channels math correctly
  // and avoids the "offset is out of bounds" error from manually slicing Int16Array pools.
  const combined = combineAudioFrames(frames);
  const samples = combined.data;
  if (samples.length === 0) return null;

  const wavBuffer = encodeWav(samples, combined.sampleRate);
  const base64Audio = wavBuffer.toString('base64');
  const audioUri = `data:audio/wav;base64,${base64Audio}`;
  const durationSec = samples.length / combined.sampleRate;
  const audioId = newAudioId();

  // Stash the full URI in the process-local registry so the LLM can look it
  // up. The transcript itself only carries the short placeholder.
  audioPayloadRegistry.set(audioId, {
    uri: audioUri,
    durationSec,
    sampleRate: combined.sampleRate,
    samples: samples.length,
    createdAt: Date.now(),
  });
  // Opportunistic GC: keep the map from growing unbounded
  if (audioPayloadRegistry.size > 64) gcAudioRegistry();

  const { rms, peak } = audioStats(samples);
  console.log(
    `[GemmaAudioSTT] Combined ${frames.length} frames: ${samples.length} samples ` +
    `(${(samples.length / combined.sampleRate).toFixed(2)}s @ ${combined.sampleRate}Hz, ` +
    `${combined.channels}ch) → ${(wavBuffer.length / 1024).toFixed(1)} KB WAV ` +
    `(key=${audioId}, rms=${rms.toFixed(3)}, peak=${peak.toFixed(3)})`,
  );

  if (DUMP_AUDIO) {
    const file = join(DUMP_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}_${audioId}.wav`);
    mkdir(DUMP_DIR, { recursive: true })
      .then(() => writeFile(file, wavBuffer))
      .then(() => console.log(`[GemmaAudioSTT] Dumped ${file}`))
      .catch((err) => console.warn(`[GemmaAudioSTT] Dump failed: ${String(err).slice(0, 80)}`));
  }

  return {
    wavBytes: wavBuffer.length,
    event: {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{
        // Short placeholder — small enough to flow through LiveKit's data
        // channel without timing out. GemmaAudioLLM matches `key=<id>` and
        // pulls the actual audio from audioPayloadRegistry.
        text: `[audio key=${audioId} dur=${durationSec.toFixed(2)}s]`,
        language: asLanguageCode('en'),
        startTime: Date.now(),
        endTime: Date.now(),
        confidence: 1.0,
      }],
    },
  };
}

/** Empty transcript event — used to short-circuit micro-segments / mic taps. */
function emptyTranscriptEvent(): stt.SpeechEvent {
  return {
    type: stt.SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [{
      text: '',
      language: asLanguageCode('en'),
      startTime: Date.now(),
      endTime: Date.now(),
      confidence: 0,
    }],
  };
}

/**
 * Injected transcription hook — set via configureTranscription() from
 * tutor-event-driven.ts (which owns the language config and LLM env).
 * Kept as an injected closure so this module stays decoupled from
 * supervisor-functions' heavy import graph.
 */
export type TranscribeFn = (audioUri: string, durationSec: number) => Promise<string | null>;

export class GemmaAudioSTT extends stt.STT {
  label = 'gemma-audio-stt';
  private transcribeFn: TranscribeFn | null = null;

  constructor() {
    // streaming: false → LiveKit's StreamAdapter will wrap us with the VAD
    // and call our _recognize(frames) on VAD end-of-speech, so we can emit
    // a FINAL_TRANSCRIPT with the raw audio payload embedded.
    super({ streaming: false, interimResults: false });
  }

  /**
   * 2026-07-10: real transcription moved INTO the STT node. Three live
   * incidents (холодец→"послушал", a turn heard as German, another as
   * Turkish + inverted speaker attribution) showed the conversation model
   * mis-hearing raw audio under the full prompt while the processor's
   * minimal-prompt transcription pass was right every time. The STT now
   * emits `[audio key=X dur=Ys] <transcript>` — the transcript anchors the
   * conversation model (which still gets the audio attached for tone/
   * pronunciation), gives the EOU turn detector real text instead of the
   * literal placeholder string, and lets the planner/frontend see actual
   * words. Costs ~1s serial latency per voice turn — accepted trade
   * (Will's call) after the third comprehension failure. Transcription
   * failure → placeholder-only, exactly the old behavior.
   */
  configureTranscription(fn: TranscribeFn): void {
    this.transcribeFn = fn;
  }

  get capabilities(): stt.STTCapabilities {
    return { streaming: false, interimResults: false };
  }

  // LiveKit's StreamAdapterWrapper calls stt.recognize(frames) when the VAD
  // detects end-of-speech. We do the same audio-buffering work here that
  // GemmaAudioBufferStream.flush() does, and return a FINAL_TRANSCRIPT event
  // whose text is the [AUDIO_PAYLOAD:...] placeholder that GemmaAudioLLM
  // intercepts to forward raw audio to vLLM.
  protected async _recognize(frame: AudioFrame | AudioFrame[], abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frames = Array.isArray(frame) ? frame : [frame];
    const result = framesToAudioPayload(frames);
    if (!result) {
      // Empty input — return a degenerate event with empty text so the
      // StreamAdapterWrapper treats it as a no-op and continues.
      return emptyTranscriptEvent();
    }
    const { event, wavBytes } = result;

    // Reject micro-segments (mic taps, breathing, background noise).
    // Real Russian speech is ≥ 100KB at 24kHz/16-bit; anything < 30KB is
    // likely a false-positive VAD trigger. Without this filter, vLLM responds
    // with a degenerate "thought thought thought" loop.
    //
    // IMPORTANT: check the WAV byte count, NOT the placeholder text length —
    // the transcript is now a 30-char placeholder, not the full base64.
    const MIN_WAV_BYTES = 30 * 1024; // ~30KB wav → ~0.5s of actual audio
    if (wavBytes < MIN_WAV_BYTES) {
      console.log(
        `[GemmaAudioSTT] Skipping tiny audio segment: ${(wavBytes / 1024).toFixed(1)} KB ` +
        `(< ${MIN_WAV_BYTES / 1024} KB threshold) — likely mic tap or breath`,
      );
      return emptyTranscriptEvent();
    }

    // Real transcription (see configureTranscription). Serial by design —
    // the pipeline's LLM trigger waits on this FINAL_TRANSCRIPT, which is
    // exactly what makes the transcript available as an anchor.
    if (this.transcribeFn) {
      const placeholder = event.alternatives![0]!.text;
      const keyMatch = placeholder.match(/key=([A-Za-z0-9]+)/);
      const entry = keyMatch ? audioPayloadRegistry.get(keyMatch[1]!) : undefined;
      if (entry) {
        try {
          const t0 = Date.now();
          const transcript = await this.transcribeFn(entry.uri, entry.durationSec);
          if (transcript && transcript.trim()) {
            entry.transcript = transcript.trim();
            event.alternatives![0]!.text = `${placeholder} ${transcript.trim()}`;
            console.log(`[GemmaAudioSTT] Transcribed in ${Date.now() - t0}ms: "${transcript.trim().slice(0, 80)}"`);
          } else {
            console.log(`[GemmaAudioSTT] Transcription empty (${Date.now() - t0}ms) — placeholder-only fallback`);
          }
        } catch (err) {
          console.warn(`[GemmaAudioSTT] Transcription failed — placeholder-only fallback: ${String(err).slice(0, 100)}`);
        }
      }
    }

    return event;
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    // Unreachable: with streaming:false, LiveKit wraps us in STTStreamAdapter and
    // calls its own stream() — never ours. If this ever fires, our capabilities
    // flag regressed.
    throw new Error(
      'GemmaAudioSTT.stream() called directly — this STT is non-streaming and ' +
      'should be wrapped by LiveKit StreamAdapter. Check capabilities.streaming=false.',
    );
  }
}
