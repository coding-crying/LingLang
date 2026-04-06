import { stt } from '@livekit/agents';
import { type AudioFrame } from '@livekit/rtc-node';
import type { APIConnectOptions } from '@livekit/agents';

// This custom STT acts as a buffer. It doesn't transcribe text itself.
// It chunks audio and emits a placeholder transcript with the raw Base64 audio embedded.

export class GemmaAudioSTT extends stt.STT {
  label = 'gemma-audio-stt';

  constructor() {
    super({ streaming: false, interimResults: false });
  }

  get capabilities(): stt.STTCapabilities {
    return { streaming: false, interimResults: false };
  }

  protected async _recognize(frame: any, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    throw new Error('Direct recognize not supported. Use stream()');
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    return new GemmaAudioBufferStream(this);
  }
}

class GemmaAudioBufferStream extends stt.SpeechStream {
  label = 'gemma-audio-buffer-stream';
  private audioBuffer: Int16Array[] = [];
  private totalSamples = 0;

  constructor(stt: GemmaAudioSTT) {
    super(stt, 16000);
  }

  pushFrame(frame: AudioFrame) {
    super.pushFrame(frame);
    const pcm = new Int16Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength / 2);
    this.audioBuffer.push(pcm);
    this.totalSamples += pcm.length;
  }

  async run() {
    // VAD chunking logic is handled automatically by LiveKit before it reaches here
  }

  flush() {
    super.flush();
    if (this.totalSamples === 0) return;

    const merged = new Int16Array(this.totalSamples);
    let offset = 0;
    for (const buf of this.audioBuffer) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    this.audioBuffer = [];
    this.totalSamples = 0;

    const wavBuffer = this.encodeToWav(merged, 16000);
    const base64Audio = wavBuffer.toString('base64');
    
    // We emit a placeholder transcript that contains the data URI in the text itself.
    // The GemmaAudioLLM will intercept this exact string format.
    const audioUri = `data:audio/wav;base64,${base64Audio}`;

    this.output.put({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ 
        text: `[AUDIO_PAYLOAD:${audioUri}]`, 
        language: 'auto', 
        startTime: Date.now(), 
        endTime: Date.now(), 
        confidence: 1.0 
      }]
    });
  }

  private encodeToWav(samples: Int16Array, sampleRate: number): Buffer {
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
}
