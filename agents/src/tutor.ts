import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { type JobContext, type JobProcess, WorkerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { analyzeTurn } from './tools/supervisor.js';
import { ContextManager } from './lib/context.js';
import { getLanguageConfig } from './config/languages.js';
import { buildInstructions } from './config/prompts/base.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { createTTS } from './tts/fallback.js';
import { createSTT } from './stt/fallback.js';

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
      mode: 'voice',
    });

    // === CREATE AGENT ===

    const agent = new voice.Agent({
      instructions,
    });

    // === CONFIGURE SESSION WITH LANGUAGE-SPECIFIC SETTINGS ===

    const [ttsInstance, sttInstance] = await Promise.all([
      createTTS(langConfig),
      createSTT(langConfig),
    ]);

    const session = new voice.AgentSession({
      agent,
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: sttInstance,

      // LLM: Cloud (OLMo 3.1 via NanoGPT) or Local (Ollama)
      llm: new openai.LLM({
        baseURL: process.env.CONVERSATION_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
        model: process.env.CONVERSATION_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma3:4b',
        apiKey: process.env.CONVERSATION_LLM_KEY || 'ollama',
      }),

      // TTS: MossTTS with ElevenLabs fallback
      tts: ttsInstance,
    });

    // --- Event Logging + Background Supervisor ---
    let recentContext = '';
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev: any) => {
        if (!ev.isFinal) return;
        const transcript = ev.transcript || '';
        console.log(`[User] Transcription (${ev.language || 'auto'}):`, transcript);
        recentContext += `User: ${transcript}\n`;

        // Fire-and-forget background analysis
        analyzeTurn({
          userId,
          userUtterance: transcript,
          context: recentContext.slice(-500),
        }).then((result) => {
          console.log(`[Supervisor] Done:`, result?.analysis?.feedback || 'ok');
        }).catch((err: any) => {
          console.error('[Supervisor] Error:', err.message || err);
        });
    });

    // Track agent responses for context
    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev: any) => {
        // speech content gets added to context when playout completes
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev: any) => console.error('[Session] Error:', ev.error));

    await session.start({
        room: ctx.room,
        agent,
        inputOptions: {
            participantIdentity: participant.identity
        }
    });

    console.log('[Tutor] Sending initial greeting...');
    session.say(langConfig.prompts.greeting);
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
