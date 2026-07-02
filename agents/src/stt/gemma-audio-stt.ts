import { stt, asLanguageCode } from '@livekit/agents';
import { type AudioFrame, combineAudioFrames } from '@livekit/rtc-node';
import type { APIConnectOptions } from '@livekit/agents';

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
 * when it sees a matching placeholder in the chat context. The LLM deletes
 * the entry once it has forwarded the audio to vLLM.
 */
export const audioPayloadRegistry = new Map<
  string,
  { uri: string; durationSec: number; sampleRate: number; samples: number; createdAt: number }
>();

let audioCounter = 0;

/** Generate a short opaque id. */
function newAudioId(): string {
  return `a${Date.now().toString(36)}${(++audioCounter).toString(36)}`;
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

  console.log(
    `[GemmaAudioSTT] Combined ${frames.length} frames: ${samples.length} samples ` +
    `(${(samples.length / combined.sampleRate).toFixed(2)}s @ ${combined.sampleRate}Hz, ` +
    `${combined.channels}ch) → ${(wavBuffer.length / 1024).toFixed(1)} KB WAV ` +
    `(key=${audioId})`,
  );

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

export class GemmaAudioSTT extends stt.STT {
  label = 'gemma-audio-stt';

  constructor() {
    // streaming: false → LiveKit's StreamAdapter will wrap us with the VAD
    // and call our _recognize(frames) on VAD end-of-speech, so we can emit
    // a FINAL_TRANSCRIPT with the raw audio payload embedded.
    super({ streaming: false, interimResults: false });
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
