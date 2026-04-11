import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import { cli } from '@livekit/agents';
import { log } from '@livekit/agents';
import 'dotenv/config';

// The livekit logger must be initialized before using plugins
// Since cli.runApp is not used here, we manually initialize it.
// LiveKit Agents TS SDK uses pino internally.
import * as pino from 'pino';
(globalThis as any).lkLogger = pino.pino(); // basic fallback if initializeLogger isn't exported

async function testLLM() {
  const url = process.env.CONVERSATION_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1';
  const model = process.env.CONVERSATION_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma3:4b';
  const key = process.env.CONVERSATION_LLM_KEY || 'ollama';
  
  console.log(`Testing LLM: ${model} at ${url}`);
  const llm = new openai.LLM({ baseURL: url, model, apiKey: key });
  
  try {
    const stream = await llm.chat({
      chatCtx: {
        messages: [{ role: 'user', content: 'Say exactly: "Hello, this is a test."' }]
      } as any,
      connOptions: {} as any
    });
    
    let text = '';
    for await (const chunk of stream) {
      if (chunk?.choices?.[0]?.delta?.content) {
        text += chunk.choices[0].delta.content;
        process.stdout.write(chunk.choices[0].delta.content);
      }
    }
    console.log('\nLLM Success:', text);
  } catch (e) {
    console.error('\nLLM Failed:', e);
  }
}

async function testTTS() {
  console.log(`\nTesting ElevenLabs TTS...`);
  try {
    const tts = new elevenlabs.TTS({
      apiKey: process.env.ELEVENLABS_API_KEY || '',
      voice: { id: 'pNInz6obpgDQGcFmaJgB', name: 'multilingual', category: 'premade' },
      modelID: 'eleven_turbo_v2_5',
      language: 'en',
      enableSsmlParsing: false,
    });
    
    const stream = tts.stream();
    
    // Simulate text stream
    const textStream = new ReadableStream({
      start(controller) {
        controller.enqueue("Hello, this is a test.");
        controller.close();
      }
    });
    
    stream.updateInputStream(textStream);
    
    let totalBytes = 0;
    for await (const chunk of stream) {
      // It's SynthesizeStream.END_OF_STREAM or AudioFrame
      if (chunk && chunk !== Symbol.for('END_OF_STREAM') && chunk.data) {
        totalBytes += chunk.data.byteLength;
      }
    }
    console.log('TTS Success, total bytes:', totalBytes);
  } catch (e) {
    console.error('TTS Failed:', e);
  }
}

async function main() {
  await testLLM();
  await testTTS();
}

main();