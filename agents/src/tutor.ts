import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { type JobContext, type JobProcess, WorkerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { analyzeConversationTurn } from './tools/supervisor.js';
import { ContextManager } from './lib/context.js';
import { getLanguageConfig } from './config/languages.js';
import { buildInstructions } from './config/prompts/base.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
// import { CosyVoiceTTS } from './tts/cosyvoice.js';
import { ChatterboxTTS } from './tts/chatterbox.js';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    console.log('[Tutor] Prewarming VAD...');
    proc.userData.vad = await silero.VAD.load();
    console.log('[Tutor] VAD prewarmed');
  },
  entry: async (ctx: JobContext) => {
    console.log('[Tutor] Connecting to room...');
    await ctx.connect();
    console.log('[Tutor] Connected to room');

    const participant = await ctx.waitForParticipant();
    const userId = participant.identity || 'test-user';
    console.log(`[Tutor] Starting session for user: ${userId}`);

    // === LANGUAGE DETECTION ===

    // Get or create user
    let user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      console.log(`[Tutor] Creating new user: ${userId}`);
      await db.insert(users).values({
        id: userId,
        createdAt: Date.now(),
        targetLanguage: process.env.DEFAULT_TARGET_LANGUAGE || 'ru',
        nativeLanguage: process.env.DEFAULT_NATIVE_LANGUAGE || 'en',
        proficiencyLevel: 'beginner',
      });

      user = await db.query.users.findFirst({
        where: eq(users.id, userId)
      });
    }

    if (!user) {
      throw new Error(`Failed to create user ${userId}`);
    }

    // Get language configuration
    const targetLang = user.targetLanguage;
    const langConfig = getLanguageConfig(targetLang);

    console.log(`[Tutor] Language: ${langConfig.name} (${langConfig.nativeName})`);
    console.log(`[Tutor] Native Language: ${user.nativeLanguage}`);
    console.log(`[Tutor] Proficiency: ${user.proficiencyLevel}`);

    // === LOAD CONTEXT ===

    let initialContext = '';
    try {
        initialContext = await ContextManager.getInitialContext(userId);
    } catch (error) {
        console.error('[Tutor] Failed to load context from DB:', error);
        initialContext = `Learning: ${langConfig.name}\nProficiency: ${user.proficiencyLevel}`;
    }

    // === BUILD INSTRUCTIONS ===

    const instructions = buildInstructions(langConfig.prompts.instructionsTemplate, {
      targetLanguage: langConfig.name,
      nativeName: langConfig.nativeName,
      targetRatio: langConfig.pedagogy.targetLanguageRatio,
      userLevel: user.proficiencyLevel || 'beginner',
      initialContext,
    });

    // === CREATE AGENT ===

    const agent = new voice.Agent({
      instructions,
      // tools: {
      //   analyzeConversationTurn
      // }
    });

    // === CONFIGURE SESSION WITH LANGUAGE-SPECIFIC SETTINGS ===

    const session = new voice.AgentSession({
      agent,
      vad: ctx.proc.userData.vad! as silero.VAD,

      // STT: Language-specific
      stt: new openai.STT({
        baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8000/v1',
        apiKey: 'dummy',
        language: langConfig.stt.language,
      }),

      // LLM: Same for all languages
      llm: new openai.LLM({
        baseURL: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
        model: process.env.LOCAL_LLM_MODEL || 'ministral-3:14b',
        apiKey: 'ollama',
      }),

      // TTS: Chatterbox (Fatterbox)
      tts: new ChatterboxTTS({
        baseURL: process.env.LOCAL_TTS_URL || 'http://localhost:8005',
        voice: 'Russian', // Fatterbox uses simple names
        speed: 1.0,
        language_id: langConfig.code, // This is 'ru' for Russian
      }),
    });

    // --- Event Logging ---
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev: any) => {
        if (ev.isFinal) console.log(`[User] Transcription:`, ev.text);
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev: any) => console.error('[Session] Error:', ev.error));

    // Correct way to link participant in 1.0
    await session.start({
        room: ctx.room,
        agent,
        inputOptions: {
            participantIdentity: participant.identity
        }
    });
    
    console.log('[Tutor] Sending initial greeting...');
    // Language-specific greeting
    session.say(langConfig.prompts.greeting);
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
