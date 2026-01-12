import { type APIConnectOptions, AudioByteStream, log, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

const NUM_CHANNELS = 1;

export interface CosyVoiceTTSOptions {
  url?: string;
  voice?: string;
  speed?: number;
  sampleRate?: number;
  bufferMs?: number;  // Initial buffer before playback (helps with slow generation)
}

const defaultOptions: CosyVoiceTTSOptions = {
  url: 'http://localhost:50000',
  voice: 'Russian.wav',
  speed: 1.0,
  sampleRate: 24000,
  bufferMs: 2000,  // 2 second buffer to handle RTF > 1
};

export class CosyVoiceTTS extends tts.TTS {
  #opts: CosyVoiceTTSOptions;
  label = 'cosyvoice.TTS';

  constructor(opts: Partial<CosyVoiceTTSOptions> = {}) {
    const mergedOpts = { ...defaultOptions, ...opts };
    super(mergedOpts.sampleRate!, NUM_CHANNELS, { streaming: true });
    this.#opts = mergedOpts;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new CosyVoiceChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    return new CosyVoiceSynthesizeStream(this, this.#opts);
  }
}

class CosyVoiceChunkedStream extends tts.ChunkedStream {
  #logger = log();
  #opts: CosyVoiceTTSOptions;
  #text: string;
  label = 'cosyvoice.ChunkedStream';

  constructor(
    tts: CosyVoiceTTS,
    text: string,
    opts: CosyVoiceTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate!, NUM_CHANNELS);

    // Convert http to ws
    const wsUrl = this.#opts.url!.replace('http://', 'ws://').replace('https://', 'wss://');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}/v1/audio/speech/stream`);

      ws.on('open', () => {
        try {
          // Send config
          const configMsg = JSON.stringify({ voice: this.#opts.voice, speed: this.#opts.speed });
          this.#logger.info(`[CosyVoice] Sending config: ${configMsg}`);
          ws.send(configMsg);

          // Give server time to setup text queue and start receive loop
          setTimeout(() => {
            const textMsg = JSON.stringify({ text: this.#text });
            this.#logger.info(`[CosyVoice] Sending text: ${textMsg}`);
            ws.send(textMsg);

            // Give a moment before signaling end
            setTimeout(() => {
              const endMsg = JSON.stringify({ event: 'end' });
              this.#logger.info(`[CosyVoice] Sending end: ${endMsg}`);
              ws.send(endMsg);
            }, 100);
          }, 100);
        } catch (err) {
          this.#logger.error({ err }, 'CosyVoice send error');
          reject(err);
        }
      });

      // Buffer frames until we have enough audio to start smooth playback
      const bufferMs = this.#opts.bufferMs || 2000;
      const bufferBytes = Math.floor(bufferMs / 1000 * this.#opts.sampleRate! * 2); // 2 bytes per sample (int16)
      let bufferedBytes = 0;
      let buffering = true;
      const pendingFrames: Array<{ requestId: string; frame: AudioFrame; final: boolean; segmentId: string }> = [];

      ws.on('message', (data: RawData) => {
        if (data instanceof Buffer) {
          // Receive PCM audio data (int16)
          this.#logger.debug(`[CosyVoice] Received audio chunk: ${data.length} bytes`);

          // Count bytes once per message, not per frame
          if (buffering) {
            bufferedBytes += data.length;
          }

          for (const frame of bstream.write(data)) {
            if (buffering) {
              // Accumulate in buffer
              pendingFrames.push({
                requestId,
                frame,
                final: false,
                segmentId: requestId,
              });

              // Once we have enough buffer, flush all pending frames
              if (bufferedBytes >= bufferBytes) {
                this.#logger.info(`[CosyVoice] Buffer full (${bufferedBytes} bytes), starting playback`);
                buffering = false;
                for (const pf of pendingFrames) {
                  this.queue.put(pf);
                }
                pendingFrames.length = 0;
              }
            } else {
              // Send directly after buffering phase
              this.queue.put({
                requestId,
                frame,
                final: false,
                segmentId: requestId,
              });
            }
          }
        } else {
          this.#logger.warn(`[CosyVoice] Received non-buffer message: ${data}`);
        }
      });

      ws.on('error', (error) => {
        if (this.abortSignal?.aborted) return;
        this.#logger.error({ error }, 'CosyVoice WebSocket error');
        reject(error);
      });

      ws.on('close', () => {
        this.#logger.info('[CosyVoice] WebSocket closed');

        // If still buffering, flush pending frames (short audio)
        if (buffering && pendingFrames.length > 0) {
          this.#logger.info(`[CosyVoice] Flushing ${pendingFrames.length} buffered frames on close`);
          for (const pf of pendingFrames) {
            this.queue.put(pf);
          }
        }

        // Flush any remaining audio from bstream
        for (const frame of bstream.flush()) {
          this.queue.put({
            requestId,
            frame,
            final: false,
            segmentId: requestId,
          });
        }
        this.queue.close();
        resolve();
      });

      // Handle abort signal
      if (this.abortSignal) {
        this.abortSignal.addEventListener('abort', () => {
          ws.close();
        });
      }
    });
  }
}

class CosyVoiceSynthesizeStream extends tts.SynthesizeStream {
  #opts: CosyVoiceTTSOptions;
  #logger = log();
  label = 'cosyvoice.SynthesizeStream';

  constructor(tts: CosyVoiceTTS, opts: CosyVoiceTTSOptions) {
    super(tts);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const wsUrl = this.#opts.url!.replace('http://', 'ws://').replace('https://', 'wss://');
    const bstream = new AudioByteStream(this.#opts.sampleRate!, NUM_CHANNELS);
    const segmentId = shortuuid();

    // Create WebSocket connection
    const ws = new WebSocket(`${wsUrl}/v1/audio/speech/stream`);

    // Wait for connection to open
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.removeListener('open', onOpen);
        reject(err);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    // Send config
    ws.send(JSON.stringify({ voice: this.#opts.voice, speed: this.#opts.speed }));

    // Buffer configuration for smoother playback
    const bufferMs = this.#opts.bufferMs || 2000;
    const bufferBytes = Math.floor(bufferMs / 1000 * this.#opts.sampleRate! * 2);
    let bufferedBytes = 0;
    let buffering = true;
    const pendingFrames: Array<{ requestId: string; frame: AudioFrame; final: boolean; segmentId: string }> = [];

    // Set up audio reception - this runs concurrently with text forwarding
    const audioComplete = new Promise<void>((resolve, reject) => {
      ws.on('message', (data: RawData) => {
        if (data instanceof Buffer) {
          // Count bytes once per message, not per frame
          if (buffering) {
            bufferedBytes += data.length;
          }

          for (const frame of bstream.write(data)) {
            if (buffering) {
              pendingFrames.push({
                requestId: shortuuid(),
                frame,
                final: false,
                segmentId,
              });

              if (bufferedBytes >= bufferBytes) {
                this.#logger.info(`[CosyVoice] Buffer full (${bufferedBytes} bytes), starting playback`);
                buffering = false;
                for (const pf of pendingFrames) {
                  this.queue.put(pf);
                }
                pendingFrames.length = 0;
              }
            } else {
              this.queue.put({
                requestId: shortuuid(),
                frame,
                final: false,
                segmentId,
              });
            }
          }
        }
      });

      ws.on('close', () => {
        // Flush any buffered frames on close
        if (buffering && pendingFrames.length > 0) {
          this.#logger.info(`[CosyVoice] Flushing ${pendingFrames.length} buffered frames on close`);
          for (const pf of pendingFrames) {
            this.queue.put(pf);
          }
        }
        // Flush any remaining audio in the buffer
        for (const frame of bstream.flush()) {
          this.queue.put({
            requestId: shortuuid(),
            frame,
            final: false,
            segmentId,
          });
        }
        resolve();
      });

      ws.on('error', (err) => {
        this.#logger.error({ err }, 'CosyVoice WebSocket error');
        reject(err);
      });
    });

    // Forward text from input queue to WebSocket
    // The base class's pushText() puts text into this.input
    // The base class's flush() puts FLUSH_SENTINEL into this.input
    // The base class's endInput() closes this.input after flush()
    try {
      for await (const input of this.input) {
        if (this.abortController.signal.aborted) {
          break;
        }

        // Check if WebSocket is still open before sending
        if (ws.readyState !== WebSocket.OPEN) {
          this.#logger.warn('WebSocket closed unexpectedly during text forwarding');
          break;
        }

        if (input === tts.SynthesizeStream.FLUSH_SENTINEL) {
          // End of text segment - signal CosyVoice to finish generation
          ws.send(JSON.stringify({ event: 'end' }));
        } else {
          // Forward text chunk to CosyVoice
          ws.send(JSON.stringify({ text: input }));
        }
      }
    } catch (err) {
      this.#logger.error({ err }, 'Error in text forwarding loop');
    }

    // Wait for all audio to be received from CosyVoice
    // This is critical - we must wait for the WebSocket to close before returning
    // Otherwise LiveKit will complete playout before audio arrives
    await audioComplete;

    // Signal end of stream
    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}
