import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { type JobContext, type JobProcess, WorkerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { analyzeConversationTurn } from './tools/supervisor.js';
import { ContextManager } from './lib/context.js';
import { ReadableStream } from 'node:stream/web';
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

  // Not strictly needed for standard pipeline unless we want to intercept, 
  // but kept for future extensibility.
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    // Explicitly connect to the room first
    console.log('[Tutor] Connecting to room...');
    try {
        await Promise.race([
            ctx.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 10000))
        ]);
        console.log('[Tutor] Connected to room');
    } catch (error) {
        console.error('[Tutor] Failed to connect to room:', error);
        return; // Exit if connection fails
    }

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

    const vad = ctx.proc.userData.vad! as any;
    
    console.log(`[Tutor] Initializing for user: ${userId}`);
    
    const existingUser = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    
    const initialContext = await ContextManager.getInitialContext(userId);
    
    const initialMessageContent = existingUser ? 
      `Welcome back! I'm ready to continue our Russian lessons.` :
      'Привет! (Hello!) I am your Russian tutor. Is this your first time learning Russian?';

    const agent = new TutorAgent({
      userId,
      instructions: 'You are a friendly and encouraging Russian language tutor.',
      chatCtx: new llm.ChatContext(), // Empty context, let Realtime handle history
      tools: {
        analyzeConversationTurn
      },
      vad,
    });

    // Gemini Realtime Session
    const session = new voice.AgentSession({
      vad: vad as any, // Re-enable Silero VAD for robust turn detection
      llm: new google.beta.realtime.RealtimeModel({
        model: 'gemini-2.0-flash-exp',
        voice: 'Puck',
        instructions: `You are a friendly and encouraging Russian language tutor.
      
        # Learner Context
        ${initialContext}
        
        # Strategy
        1. Start the conversation immediately by greeting the user.
        2. Keep it conversational.
        3. The system may inject "IMMEDIATE GOALS" occasionally. Follow them subtly.
        `
      }) as any,
    });

    // Explicitly connect to the room first
    console.log('[Tutor] Connecting to room...');
    await ctx.connect();
    console.log('[Tutor] Connected to room');

    await session.start({
        agent,
        room: ctx.room,
    });
    
    console.log('[Tutor] Session started. Triggering greeting...');
    // Trigger the initial greeting by "poking" the model with an empty turn
    session.generateReply();
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}