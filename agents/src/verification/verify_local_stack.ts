
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_DIR = path.join(__dirname, '../../resources');

// Configuration - Defaults match agents/src/tutor.ts
const CONFIG = {
  llm: {
    baseURL: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
    apiKey: 'ollama',
    model: process.env.LOCAL_LLM_MODEL || 'gemma3:4b', // Switched to gemma3:4b for faster loading
  },
  stt: {
    baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8000/v1',
    apiKey: 'dummy',
    model: 'whisper-1', // Generic for OpenAI-compatible STT
  },
  tts: {
    baseURL: process.env.LOCAL_TTS_URL || 'http://localhost:5000/v1',
    apiKey: 'dummy',
    model: 'tts-1', // Generic for OpenAI-compatible TTS
  }
};

async function verifyLLM() {
  console.log('\n--- Verifying LLM (Ollama) ---');
  console.log(`Endpoint: ${CONFIG.llm.baseURL}`);
  console.log(`Model: ${CONFIG.llm.model}`);

  const openai = new OpenAI({
    baseURL: CONFIG.llm.baseURL,
    apiKey: CONFIG.llm.apiKey,
  });

  try {
    const start = Date.now();
    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      model: CONFIG.llm.model,
    });
    const duration = Date.now() - start;
    
    console.log(`✅ Success (${duration}ms)`);
    console.log(`Response: "${completion.choices[0]?.message.content || 'No response'}"`);
    return true;
  } catch (error: any) {
    console.error('❌ Failed');
    console.error(`Error: ${error.message}`);
    if (error.cause) console.error(`Cause: ${error.cause}`);
    return false;
  }
}

async function verifyTTS() {
  console.log('\n--- Verifying TTS (Fish Speech) ---');
  console.log(`Endpoint: ${CONFIG.tts.baseURL}`);
  
  const openai = new OpenAI({
    baseURL: CONFIG.tts.baseURL,
    apiKey: CONFIG.tts.apiKey,
  });

  try {
    const start = Date.now();
    const response = await openai.audio.speech.create({
      model: CONFIG.tts.model,
      voice: 'alloy', // specific voice might be needed depending on backend
      input: 'Testing the audio generation.',
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const duration = Date.now() - start;

    console.log(`✅ Success (${duration}ms)`);
    console.log(`Received ${buffer.length} bytes of audio`);
    
    // Optional: Save to temp file to verify
    const outputPath = path.join(__dirname, 'test_output_tts.mp3');
    fs.writeFileSync(outputPath, buffer);
    console.log(`Saved output to ${outputPath}`);
    
    return true;
  } catch (error: any) {
    console.error('❌ Failed');
    console.error(`Error: ${error.message}`);
    return false;
  }
}

async function verifySTT() {
  console.log('\n--- Verifying STT (Faster Whisper) ---');
  console.log(`Endpoint: ${CONFIG.stt.baseURL}`);

  const openai = new OpenAI({
    baseURL: CONFIG.stt.baseURL,
    apiKey: CONFIG.stt.apiKey,
  });

  const audioFilePath = path.join(RESOURCES_DIR, 'keyboard-typing.ogg');
  if (!fs.existsSync(audioFilePath)) {
    console.error(`❌ Skipped: Audio file not found at ${audioFilePath}`);
    return false;
  }

  try {
    const start = Date.now();
    // OpenAI SDK expects a ReadStream or File object
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: CONFIG.stt.model,
    });
    const duration = Date.now() - start;

    console.log(`✅ Success (${duration}ms)`);
    console.log(`Transcription: "${transcription.text}"`);
    return true;
  } catch (error: any) {
    console.error('❌ Failed');
    console.error(`Error: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('Starting Local Stack Verification...');
  
  const llmOk = await verifyLLM();
  const ttsOk = await verifyTTS();
  const sttOk = await verifySTT();

  console.log('\n--- Summary ---');
  console.log(`LLM: ${llmOk ? '✅' : '❌'}`);
  console.log(`TTS: ${ttsOk ? '✅' : '❌'}`);
  console.log(`STT: ${sttOk ? '✅' : '❌'}`);

  if (llmOk && ttsOk && sttOk) {
    console.log('\nAll systems operational. Ready for LiveKit integration.');
    process.exit(0);
  } else {
    console.error('\nSome systems failed. Please check your local servers.');
    process.exit(1);
  }
}

main();
