import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

// Import Duolingo tools
import {
  authenticateDuolingo,
  syncDuolingoData,
  getDuolingoWeakWords
} from './tools/duolingo.js';
import { ContextManager } from './lib/context.js';
import { getLanguageConfig } from './config/languages.js';
import { CosyVoiceTTS } from './tts/cosyvoice.js';
import { db } from './db/index.js';
import { users, duolingoMetadata } from './db/schema.js';
import { eq } from 'drizzle-orm';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    console.log('[Duolingo Tutor] Prewarming VAD...');
    proc.userData.vad = await silero.VAD.load();
    console.log('[Duolingo Tutor] VAD prewarmed successfully');
  },

  entry: async (ctx: JobContext) => {
    console.log('[Duolingo Tutor] Connecting to room...');
    await ctx.connect();

    const participant = await ctx.waitForParticipant();
    const userId = participant.identity || 'test-user';
    console.log(`[Duolingo Tutor] Starting session for user: ${userId}`);

    // === GET OR CREATE USER ===
    let user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      console.log(`[Duolingo Tutor] Creating new user: ${userId}`);
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

    // Check if user has Duolingo metadata - use that language if available
    const metadata = await db.query.duolingoMetadata.findFirst({
      where: eq(duolingoMetadata.userId, userId)
    });

    const targetLang = metadata?.learningLanguage || user.targetLanguage;
    const langConfig = getLanguageConfig(targetLang);

    console.log(`[Duolingo Tutor] Language: ${langConfig.name} (${langConfig.nativeName})`);

    // Load Duolingo-specific context
    let initialContext = '';
    try {
      initialContext = await ContextManager.getInitialContextForDuolingo(userId);
      console.log('[Duolingo Tutor] Context loaded successfully');
    } catch (error) {
      console.error('[Duolingo Tutor] Failed to load context:', error);
      initialContext = 'Starting from scratch with Duolingo data.';
    }

    // Create the agent
    const agent = new voice.Agent({
      instructions: `You are a friendly and encouraging language tutor powered by Duolingo progress data.

# Your Role
- Help users practice vocabulary they're learning on Duolingo
- Focus on words with low strength (words that need more practice)
- Use the student's actual Duolingo curriculum and progress
- Create natural, conversational practice scenarios

# Available Tools
You have three tools to help with Duolingo integration:

1. **authenticateDuolingo**: Login to Duolingo account
   - Call this when user provides their Duolingo credentials
   - Required before syncing data

2. **syncDuolingoData**: Fetch latest vocabulary and progress from Duolingo
   - Call this after authentication or when user asks to update their data
   - Imports all vocabulary, skills, and strength levels into the learning system

3. **getDuolingoWeakWords**: Find words that need practice (low strength)
   - Call this to identify which words to focus on during the lesson
   - Returns words with low Duolingo strength scores

# Workflow

**First-time users (no Duolingo connected):**
1. Greet warmly and explain you can use their Duolingo progress
2. Ask for their Duolingo username and password
3. Call authenticateDuolingo tool
4. Call syncDuolingoData tool to import their vocabulary
5. Begin practice with their vocabulary

**Returning users (Duolingo already connected):**
1. Greet and acknowledge their Duolingo connection
2. Optionally check if they want to sync new progress
3. Call getDuolingoWeakWords to identify practice targets
4. Focus practice on weak vocabulary items

# Teaching Strategy
- Use weak words in natural conversation contexts
- Mix target language and English for explanations (bilingual approach)
- Create scenarios where the weak words naturally appear
- Encourage usage through questions and prompts
- Praise correct usage enthusiastically

# Learner Context
${initialContext}

# Response Style
- VERY SHORT bursts (5-10 words maximum per utterance)
- Wait for user replies before continuing
- Natural, encouraging, patient tone
- Use simple, clear language
- Focus on one concept at a time
- Mix target language practice with English explanations

# Important Notes
- If authentication fails, politely ask user to verify credentials
- If sync fails, explain the issue and offer to retry
- If no vocabulary available, guide user through connection process
- Always maintain an encouraging, supportive tone
`,
      tools: {
        authenticateDuolingo,
        syncDuolingoData,
        getDuolingoWeakWords,
      },
    });

    // Create the agent session with local AI stack
    const session = new voice.AgentSession({
      agent,
      vad: ctx.proc.userData.vad! as silero.VAD,

      // Local STT (Faster Whisper) - Language-specific
      stt: new openai.STT({
        baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8000/v1',
        apiKey: 'dummy',
        language: langConfig.stt.language,
      }),

      // Local LLM (Ollama)
      llm: new openai.LLM({
        baseURL: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
        model: process.env.LOCAL_LLM_MODEL || 'ministral-3:14b',
        apiKey: 'ollama',
      }),

      // Local TTS (CosyVoice streaming WebSocket) - Language-specific
      tts: new CosyVoiceTTS({
        url: 'http://localhost:50000',
        voice: langConfig.tts.voice,
        speed: 1.0,
      }),
    });

    // Event logging for debugging
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev: any) => {
      if (ev.isFinal) {
        console.log(`[User] Transcription:`, ev.text);
      }
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev: any) => {
      console.error('[Session] Error:', ev.error);
    });

    // Start the session
    await session.start({
      room: ctx.room,
      agent,
      inputOptions: {
        participantIdentity: participant.identity
      }
    });

    console.log('[Duolingo Tutor] Session started, sending greeting...');

    // Send initial greeting (language-aware)
    const greeting = metadata
      ? `${langConfig.prompts.greeting} Let's practice your Duolingo vocabulary!`
      : `Hi! I'm your Duolingo-powered ${langConfig.name} tutor. Ready to connect your Duolingo account?`;
    session.say(greeting);
  },
});

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
