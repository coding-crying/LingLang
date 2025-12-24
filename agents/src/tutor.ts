import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { type JobContext, type JobProcess, WorkerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { analyzeConversationTurn } from './src/tools/supervisor.js';
import { ContextManager } from './src/lib/context.js';

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
    
    let initialContext = '';
    try {
        initialContext = await ContextManager.getInitialContext(userId);
    } catch (error) {
        console.error('[Tutor] Failed to load context from DB:', error);
        initialContext = "Beginner level.";
    }
    
    const agent = new voice.Agent({
      instructions: `You are a friendly and encouraging Russian language tutor.

      # Personality & Style
      - Speak in a mix of Russian and English.
      - Use English for complex explanations, feedback, and translations.
      - Use Russian for greetings, examples, and practice.
      - NEVER use emojis in your responses

      # Learner Context
      ${initialContext}

      # Response Style (CRITICAL for low latency)
      - Speak in VERY SHORT bursts (5-10 words maximum)
      - One simple thought per response
      - Natural back-and-forth like texting
      - Wait for user's reply before continuing
      `,
      // tools: {
      //   analyzeConversationTurn
      // }
    });

    const session = new voice.AgentSession({
      agent,
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new openai.STT({
        baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8000/v1',
        apiKey: 'dummy',
        language: 'ru', // Force Russian language detection
      }),
      // 2. LLM: Local Ollama
      llm: new openai.LLM({
        baseURL: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
        model: process.env.LOCAL_LLM_MODEL || 'ministral-3:14b',
        apiKey: 'ollama',
      }),
      tts: new openai.TTS({
        baseURL: 'http://localhost:8004/v1',
        apiKey: 'dummy',
        voice: 'Russian.wav',
      }),
    });

    // --- Exhaustive Logging ---
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => console.log(`[Session] AgentState: ${ev.oldState} -> ${ev.state}`));
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => console.log(`[Session] UserState: ${ev.oldState} -> ${ev.state}`));
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
        if (ev.isFinal) console.log(`[User] Transcription Event:`, JSON.stringify(ev));
    });
    session.on(voice.AgentSessionEventTypes.AgentStartedSpeaking, () => console.log('🔊 Agent speaking started'));
    session.on(voice.AgentSessionEventTypes.AgentStoppedSpeaking, () => console.log('🔈 Agent speaking stopped'));
    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => console.log(`[Session] Speech Created Event:`, JSON.stringify(ev)));
    session.on(voice.AgentSessionEventTypes.Error, (ev) => console.error('[Session] Error:', ev.error));
    session.on(voice.AgentSessionEventTypes.Close, (ev) => console.log(`[Session] Closed: ${ev.reason}`));

    // Correct way to link participant in 1.0
    await session.start({
        room: ctx.room,
        agent,
        inputOptions: {
            participantIdentity: participant.identity
        }
    });
    
    console.log('[Tutor] Sending initial greeting...');
    // Short greeting for fast TTS (1.5s vs 3s)
    session.say('Привет! Ready to learn?');
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
