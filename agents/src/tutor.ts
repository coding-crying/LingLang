import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { type JobContext, type JobProcess, WorkerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { analyzeConversationTurn } from './tools/supervisor.js';
import { ContextManager } from './lib/context.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';

// --- Custom Tutor Agent ---
class TutorAgent extends voice.Agent {
  private userId: string;

  constructor(options: voice.AgentOptions<any> & { userId: string }) {
    super(options);
    this.userId = options.userId;
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    // Explicitly connect to the room first
    console.log('[Tutor] Connecting to room...');
    await ctx.connect();
    console.log('[Tutor] Connected to room');

    console.log('[Tutor] Waiting up to 30s for a participant to join...');
    
    // Check if a participant is already there
    let participant: any = Array.from(ctx.room.remoteParticipants.values())[0] || ctx.room.localParticipant;

    if (Array.from(ctx.room.remoteParticipants.values()).length > 0) {
        console.log(`[Tutor] Found existing participant: ${participant.identity}`);
    } else {
        try {
            const p = await Promise.race([
                ctx.waitForParticipant(),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 30000))
            ]);
            if (p) participant = p;
        } catch (e) {
            console.warn('[Tutor] Failed to wait for participant:', e);
        }
    }

    const userId = participant?.identity || 'test-user';
    console.log(`[Tutor] Participant resolved: ${userId}`);
    
    console.log(`[Tutor] Initializing for user: ${userId}`);
    
    const existingUser = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    
    const initialContext = await ContextManager.getInitialContext(userId);
    
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({
      role: 'system',
      content: `You are a friendly and encouraging Russian language tutor.
      
      # Learner Context
      ${initialContext}
      
      # Strategy
      1. Start the conversation immediately by greeting the user.
      2. Keep it conversational.
      3. The system may inject "IMMEDIATE GOALS" occasionally. Follow them subtly.
      `
    });

    const vad = ctx.proc.userData.vad! as any;

    const agent = new TutorAgent({
      userId,
      chatCtx,
      vad,
      // 1. STT: Local Whisper (OpenAI-compatible)
      stt: new openai.STT({
        baseUrl: process.env.LOCAL_STT_URL || 'http://localhost:8000/v1',
        apiKey: 'dummy',
      }) as any,
      // 2. LLM: Local Ollama (OpenAI-compatible)
      llm: new openai.LLM({
        baseUrl: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
        model: process.env.LOCAL_LLM_MODEL || 'llama3',
        apiKey: 'ollama',
      }) as any,
      // 3. TTS: Local TTS (OpenAI-compatible)
      tts: new openai.TTS({
        baseUrl: process.env.LOCAL_TTS_URL || 'http://localhost:5000/v1',
        apiKey: 'dummy',
      }) as any,
      tools: {
        analyzeConversationTurn
      }
    });

    await agent.start(ctx.room);
    
    // Standard TTS greeting
    if (existingUser) {
      await agent.say(`Welcome back! I'm ready to continue our Russian lessons.`);
    } else {
      await agent.say('Привет! (Hello!) I am your Russian tutor. Is this your first time learning Russian?');
    }
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}