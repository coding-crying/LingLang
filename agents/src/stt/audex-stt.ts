/**
 * AudexSTT — non-streaming STT against the cascaded Audex-30B-A3B s2s
 * server (see ~/audex-quant/WIRING.md). Unlike GemmaAudioSTT, this is real
 * ASR: `/api/transcribe` returns actual text, so no placeholder/registry
 * dance is needed — the FINAL_TRANSCRIPT text IS the transcript.
 *
 * Protocol (confirmed live 2026-07-16): POST multipart `audio` field to
 * `/api/transcribe`, response is NDJSON with the transcript growing
 * cumulatively on each `{"type":"transcript","text":...}` line; the final
 * `{"type":"complete","text":...}` line has the full transcript.
 */

import { stt, asLanguageCode } from '@livekit/agents';
import { type AudioFrame, combineAudioFrames } from '@livekit/rtc-node';
import type { APIConnectOptions } from '@livekit/agents';

function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i] || 0, 44 + i * 2);
  }
  return buffer;
}

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

export interface AudexSTTOptions {
  baseURL?: string;
}

const MIN_WAV_BYTES = 30 * 1024; // ~0.5s of real audio at 16kHz/16-bit mono

export class AudexSTT extends stt.STT {
  label = 'audex-stt';
  #baseURL: string;

  constructor(opts: AudexSTTOptions = {}) {
    super({ streaming: false, interimResults: false });
    this.#baseURL = (opts.baseURL || 'http://127.0.0.1:7860').replace(/\/$/, '');
  }

  get capabilities(): stt.STTCapabilities {
    return { streaming: false, interimResults: false };
  }

  protected async _recognize(frame: AudioFrame | AudioFrame[], abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frames = Array.isArray(frame) ? frame : [frame];
    if (frames.length === 0) return emptyTranscriptEvent();

    const combined = combineAudioFrames(frames);
    const samples = combined.data;
    if (samples.length === 0) return emptyTranscriptEvent();

    const wavBuffer = encodeWav(samples, combined.sampleRate);
    if (wavBuffer.length < MIN_WAV_BYTES) {
      console.log(`[AudexSTT] Skipping tiny audio segment: ${(wavBuffer.length / 1024).toFixed(1)} KB — likely mic tap or breath`);
      return emptyTranscriptEvent();
    }

    try {
      const t0 = Date.now();
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');

      const response = await fetch(`${this.#baseURL}/api/transcribe`, {
        method: 'POST',
        body: form,
        signal: abortSignal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Audex transcribe ${response.status}: ${errBody.slice(0, 300)}`);
      }
      if (!response.body) throw new Error('Audex transcribe: no response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nlIdx: number;
        while ((nlIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'complete' && typeof obj.text === 'string') {
              finalText = obj.text;
            } else if (obj.type === 'transcript' && typeof obj.text === 'string') {
              finalText = obj.text;
            }
          } catch {
            // skip malformed line
          }
        }
      }

      console.log(
        `[AudexSTT] Transcribed in ${Date.now() - t0}ms (${(wavBuffer.length / 1024).toFixed(1)} KB wav): "${finalText.slice(0, 80)}"`,
      );

      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [{
          text: finalText,
          language: asLanguageCode('en'),
          startTime: Date.now(),
          endTime: Date.now(),
          confidence: finalText ? 1.0 : 0,
        }],
      };
    } catch (err) {
      console.warn(`[AudexSTT] Transcription failed: ${String((err as Error).message || err).slice(0, 200)}`);
      return emptyTranscriptEvent();
    }
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    throw new Error('AudexSTT.stream() called directly — non-streaming, should be wrapped by LiveKit StreamAdapter.');
  }
}
