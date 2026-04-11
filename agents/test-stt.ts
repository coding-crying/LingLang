import { ElevenLabsRealtimeSTT } from './src/stt/elevenlabs-realtime.js';
import * as pino from 'pino';
(globalThis as any).lkLogger = pino.pino();

const stt = new ElevenLabsRealtimeSTT({ apiKey: 'dummy' });
console.log('stt.capabilities:', stt.capabilities);
