import { AudioFrame } from '@livekit/rtc-node';
import {
  SynthesizeStream as BaseSynthesizeStream,
  TTS as BaseTTS,
  SynthesizedAudio,
  type APIConnectOptions,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  ChunkedStream
} from '@livekit/agents';
import { WebSocket } from 'ws';

export interface TTSOptions {
  baseURL?: string;
  voice?: string;
  speed?: number;
  sampleRate?: number;
}

const defaultTTSOptions: TTSOptions = {
  baseURL: 'ws://localhost:8004',
  voice: 'russian',
  speed: 1.0,
  sampleRate: 24000,
};

export class TTS extends BaseTTS {
  #opts: TTSOptions;
  label = 'chatterbox.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const fullOpts = { ...defaultTTSOptions, ...opts };
    super(fullOpts.sampleRate!, 1, { streaming: true });
    this.#opts = fullOpts;
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(text: string): ChunkedStream {
    throw new Error('ChunkedStream is not implemented, use stream()');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const { connOptions = DEFAULT_API_CONNECT_OPTIONS } = options || {};
    return new SynthesizeStream(this, this.#opts, connOptions);
  }
}

export class SynthesizeStream extends BaseSynthesizeStream {
  #opts: TTSOptions;
  #ws?: WebSocket;
  label = 'chatterbox.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const wsUrl = `${this.#opts.baseURL}/v1/audio/speech/stream`;
    this.#ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      this.#ws!.on('open', resolve);
      this.#ws!.on('error', reject);
    });

    // 1. Send config
    this.#ws.send(JSON.stringify({
      voice: this.#opts.voice,
      speed: this.#opts.speed
    }));

    const requestId = shortuuid();

    // 2. Handle incoming audio
    this.#ws.on('message', (data: Buffer) => {
      const frame = new AudioFrame(
        data,
        this.#opts.sampleRate!,
        1,
        data.length / 2
      );
      this.queue.put({
        requestId,
        segmentId: requestId,
        frame,
        final: false
      });
    });

    this.#ws.on('close', () => {
      this.queue.put(BaseSynthesizeStream.END_OF_STREAM);
    });

    // 3. Stream text in
    for await (const text of this.input) {
      if (text === BaseSynthesizeStream.FLUSH_SENTINEL) {
        this.#ws.send(JSON.stringify({ event: 'flush' }));
        continue;
      }
      this.#ws.send(JSON.stringify({ text }));
    }

    this.#ws.send(JSON.stringify({ event: 'end' }));
  }

  async close() {
    this.#ws?.close();
    super.close();
  }
}
