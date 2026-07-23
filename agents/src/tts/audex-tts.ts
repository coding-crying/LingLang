/**
 * AudexTTS — speech-synthesis stage of the cascaded Audex-30B-A3B s2s
 * server (see ~/audex-quant/WIRING.md). Talks to `/ws/generate-audio`.
 *
 * Protocol (confirmed live 2026-07-16): send `{"text", "model_name"}`;
 * receive JSON status/segment/audio frames interleaved with raw binary
 * frames. Each `{"type":"audio","sample_rate","samples"}` JSON frame
 * announces the NEXT binary frame, which is `samples * 4` bytes of
 * little-endian float32 PCM (not int16 — has to be converted before
 * handing to LiveKit's AudioByteStream). Ends with `{"type":"complete"}`.
 */

import { type APIConnectOptions, AudioByteStream, log, shortuuid, tts } from '@livekit/agents';
import { type RawData, WebSocket } from 'ws';

const NUM_CHANNELS = 1;

export interface AudexTTSOptions {
  baseURL?: string;
  modelName?: string;
  sampleRate?: number;
}

const defaultOptions: Required<AudexTTSOptions> = {
  baseURL: 'http://127.0.0.1:7860',
  modelName: 'audex-30b-a3b',
  sampleRate: 16000,
};

function float32LEToInt16LE(data: Buffer): Buffer {
  const numSamples = data.length / 4;
  const out = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    let s = data.readFloatLE(i * 4);
    s = Math.max(-1, Math.min(1, s));
    out.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return out;
}

export class AudexTTS extends tts.TTS {
  #opts: Required<AudexTTSOptions>;
  label = 'audex.TTS';

  constructor(opts: AudexTTSOptions = {}) {
    const merged = { ...defaultOptions, ...opts };
    super(merged.sampleRate, NUM_CHANNELS, { streaming: true });
    this.#opts = merged;
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new AudexChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    return new AudexSynthesizeStream(this, this.#opts);
  }
}

function wsURL(baseURL: string): string {
  return baseURL.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/generate-audio';
}

function synthesizeOverWS(
  url: string,
  text: string,
  modelName: string,
  bstream: AudioByteStream,
  queuePut: (frame: any) => void,
  requestId: string,
  segmentId: string,
  logger: ReturnType<typeof log>,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let pendingSampleRate: number | null = null;
    let done = false;

    const cleanup = () => {
      if (!done) {
        done = true;
        try { ws.close(); } catch { /* already closed */ }
      }
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', cleanup);
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ text, model_name: modelName }));
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const pcm16 = float32LEToInt16LE(buf);
        for (const frame of bstream.write(pcm16)) {
          queuePut({ requestId, frame, final: false, segmentId });
        }
        pendingSampleRate = null;
        return;
      }
      let obj: any;
      try {
        obj = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (obj.type === 'audio') {
        pendingSampleRate = obj.sample_rate;
      } else if (obj.type === 'complete') {
        for (const frame of bstream.flush()) {
          queuePut({ requestId, frame, final: false, segmentId });
        }
        done = true;
        try { ws.close(); } catch { /* already closing */ }
        resolve();
      } else if (obj.type === 'error') {
        logger.error(`[AudexTTS] Server error: ${obj.status || JSON.stringify(obj)}`);
      }
    });

    ws.on('error', (err) => {
      if (abortSignal?.aborted) { resolve(); return; }
      logger.error({ err }, 'AudexTTS WebSocket error');
      reject(err);
    });

    ws.on('close', () => {
      if (!done) {
        // Closed before an explicit `complete` frame — flush what we have
        // rather than losing the tail of the utterance.
        for (const frame of bstream.flush()) {
          queuePut({ requestId, frame, final: false, segmentId });
        }
        resolve();
      }
    });
  });
}

class AudexChunkedStream extends tts.ChunkedStream {
  #logger = log();
  #opts: Required<AudexTTSOptions>;
  #text: string;
  label = 'audex.ChunkedStream';

  constructor(
    ttsInstance: AudexTTS,
    text: string,
    opts: Required<AudexTTSOptions>,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    try {
      this.#logger.info(`[AudexTTS] Synthesizing: "${this.#text.slice(0, 50)}..."`);
      await synthesizeOverWS(
        wsURL(this.#opts.baseURL),
        this.#text,
        this.#opts.modelName,
        bstream,
        (f) => this.queue.put(f),
        requestId,
        requestId,
        this.#logger,
        this.abortSignal,
      );
    } catch (err) {
      if (!this.abortSignal?.aborted) {
        this.#logger.error({ err }, 'AudexTTS error');
      }
    } finally {
      this.queue.close();
    }
  }
}

class AudexSynthesizeStream extends tts.SynthesizeStream {
  #opts: Required<AudexTTSOptions>;
  #logger = log();
  label = 'audex.SynthesizeStream';

  constructor(ttsInstance: AudexTTS, opts: Required<AudexTTSOptions>) {
    super(ttsInstance);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const segmentId = shortuuid();

    try {
      let fullText = '';
      for await (const input of this.input) {
        if (this.abortController.signal.aborted) break;

        if (input === tts.SynthesizeStream.FLUSH_SENTINEL) {
          if (fullText.trim()) {
            await synthesizeOverWS(
              wsURL(this.#opts.baseURL),
              fullText,
              this.#opts.modelName,
              bstream,
              (f) => this.queue.put(f),
              shortuuid(),
              segmentId,
              this.#logger,
              this.abortController.signal,
            );
          }
          fullText = '';
        } else {
          fullText += input;
        }
      }

      if (fullText.trim()) {
        await synthesizeOverWS(
          wsURL(this.#opts.baseURL),
          fullText,
          this.#opts.modelName,
          bstream,
          (f) => this.queue.put(f),
          shortuuid(),
          segmentId,
          this.#logger,
          this.abortController.signal,
        );
      }
    } catch (err) {
      this.#logger.error({ err }, 'AudexTTS SynthesizeStream error');
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}
