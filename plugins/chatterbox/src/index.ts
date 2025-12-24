import { Plugin } from '@livekit/agents';
export { TTS, SynthesizeStream, type TTSOptions } from './tts';

class ChatterboxPlugin extends Plugin {
  constructor() {
    super({
      title: 'chatterbox',
      version: '0.1.0',
      package: '@livekit/agents-plugin-chatterbox',
    });
  }
}

Plugin.registerPlugin(new ChatterboxPlugin());
