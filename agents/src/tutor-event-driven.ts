/**
 * Event-Driven Tutor Agent (Optimized)
 *
 * This version separates Processor and Supervisor with smart triggers:
 * - PROCESSOR: Analyzes utterance + updates SRS (runs every 5 turns to reduce latency)
 * - SUPERVISOR: Checks goal status (runs only when dirty flag is set)
 *
 * Architecture:
 *   User speaks → STT → UserInputTranscribed event
 *                              ↓
 *              ┌───────────────┴───────────────┐
 *              ↓                               ↓
 *        LLM responds                   Processor (every 5 turns)
 *        (immediate)                    └─> Analyze + Update SRS
 *              ↓                               ↓
 *        TTS speaks                     Supervisor (when dirty)
 *                                       └─> Check/Update Goals
 *                                              ↓
 *                                    [Inject praise/new goal if changed]
 *
 * Dirty Flag Triggers:
 * - Session start (get initial goal)
 * - After SRS updates (goal might be completed)
 * - After goal completion (get next goal)
 */

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

import { runSupervisor } from './tools/supervisor-functions.js';
import { ContextManager, PlaceholderGoals } from './lib/context.js';
import { getLanguageConfig } from './config/languages.js';
import { buildInstructions } from './config/prompts/base.js';
// import { CosyVoiceTTS } from './tts/cosyvoice.js';  // Switched to Chatterbox
import { ChatterboxTTS } from './tts/chatterbox.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';

// ============================================================================
// CONVERSATION HISTORY (for context)
// ============================================================================

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

class ConversationHistory {
  private turns: ConversationTurn[] = [];
  private maxTurns = 10;

  addUserTurn(content: string) {
    this.turns.push({ role: 'user', content, timestamp: Date.now() });
    this.trim();
  }

  addAssistantTurn(content: string) {
    this.turns.push({ role: 'assistant', content, timestamp: Date.now() });
    this.trim();
  }

  private trim() {
    if (this.turns.length > this.maxTurns) {
      this.turns = this.turns.slice(-this.maxTurns);
    }
  }

  getContext(): string {
    return this.turns
      .map(t => `${t.role === 'user' ? 'User' : 'Tutor'}: ${t.content}`)
      .join('\n');
  }

  getLastUserTurn(): string | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === 'user') {
        return this.turns[i].content;
      }
    }
    return null;
  }
}

// ============================================================================
// AGENT DEFINITION
// ============================================================================

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    console.log('[Tutor-ED] Prewarming VAD...');
    proc.userData.vad = await silero.VAD.load();
    console.log('[Tutor-ED] VAD prewarmed');
  },

  entry: async (ctx: JobContext) => {
    console.log('[Tutor-ED] Connecting to room...');
    await ctx.connect();
    console.log('[Tutor-ED] Connected to room');

    const participant = await ctx.waitForParticipant();
    const userId = participant.identity || 'test-user';
    console.log(`[Tutor-ED] Starting session for user: ${userId}`);

    // === USER SETUP ===
    let user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      console.log(`[Tutor-ED] Creating new user: ${userId}`);
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

    if (!user) throw new Error(`Failed to create user ${userId}`);

    // === LANGUAGE CONFIG ===
    const targetLang = user.targetLanguage;
    const langConfig = getLanguageConfig(targetLang);
    console.log(`[Tutor-ED] Language: ${langConfig.name}`);

    // === INITIAL CONTEXT ===
    let initialContext = '';
    try {
      initialContext = await ContextManager.getInitialContext(userId);

      // Also check for any pending goals
      const pendingGoal = await ContextManager.getDynamicGoal(userId);
      if (pendingGoal) {
        initialContext += '\n\n' + pendingGoal;
      }
    } catch (error) {
      console.error('[Tutor-ED] Failed to load context:', error);
      initialContext = `Learning: ${langConfig.name}\nProficiency: ${user.proficiencyLevel}`;
    }

    const instructions = buildInstructions(langConfig.prompts.instructionsTemplate, {
      targetLanguage: langConfig.name,
      nativeName: langConfig.nativeName,
      targetRatio: langConfig.pedagogy.targetLanguageRatio,
      userLevel: user.proficiencyLevel || 'beginner',
      initialContext,
    });

    // === CREATE AGENT (NO TOOLS - event-driven instead) ===
    const agent = new voice.Agent({
      instructions,
      // No tools needed - supervisor runs on events
    });

    // === CREATE SESSION ===
    const session = new voice.AgentSession({
      agent,
      vad: ctx.proc.userData.vad! as silero.VAD,

      stt: new openai.STT({
        baseURL: process.env.LOCAL_STT_URL || 'http://localhost:8000/v1',
        apiKey: 'dummy',
        language: langConfig.stt.language,
      }),

      llm: new openai.LLM({
        baseURL: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
        model: process.env.LOCAL_LLM_MODEL || 'gemma3:4b',
        apiKey: 'ollama',
      }),

      // Chatterbox with HTTP streaming - generates sentence-by-sentence
      tts: new ChatterboxTTS({
        baseURL: process.env.LOCAL_TTS_URL || 'http://localhost:8004',
        voice: langConfig.tts.voice,
        speed: langConfig.tts.speed || 1.0,
        chunkSize: 80,  // Smaller chunks for faster first audio
        language_id: langConfig.code,
      }),
    });

    // === CONVERSATION TRACKING ===
    const history = new ConversationHistory();
    let pendingGoalNote: string | null = null;

    // === EVENT HANDLERS ===

    // Track agent state to know when GPU is free
    let lastAgentState = 'initializing';
    let pendingAnalysis: { transcription: string; context: string } | null = null;

    // Optimization: Turn counter and dirty flag
    let turnCounter = 0;
    let goalNeedsCheck = true; // Start true to get initial goal
    const PROCESSOR_INTERVAL = 5; // Run processor every N turns

    // On user transcription: queue analysis (don't run yet - wait for agent to finish)
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, async (ev: any) => {
      if (!ev.isFinal) return;

      const transcription = ev.transcript || ev.text || '';
      console.log(`[User] ${transcription}`);
      history.addUserTurn(transcription);

      turnCounter++;

      // Only queue processor if we're at the interval
      const shouldRunProcessor = turnCounter % PROCESSOR_INTERVAL === 0;

      if (shouldRunProcessor || goalNeedsCheck) {
        // Queue the analysis - we'll run it after agent stops speaking
        // This avoids GPU competition between conversation LLM and supervisor LLM
        pendingAnalysis = {
          transcription,
          context: history.getContext(),
        };
        console.log(`[Supervisor] Analysis queued (turn ${turnCounter}, processor: ${shouldRunProcessor}, goal: ${goalNeedsCheck})`);
      } else {
        console.log(`[Supervisor] Skipping analysis (turn ${turnCounter}/${PROCESSOR_INTERVAL})`);
      }
    });

    // Watch agent state changes - run supervisor when agent finishes speaking
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, async (ev: any) => {
      const newState = ev.newState;
      console.log(`[Agent] State: ${lastAgentState} → ${newState}`);

      // When agent transitions FROM speaking to idle/listening, GPU is free
      if (lastAgentState === 'speaking' && (newState === 'idle' || newState === 'listening')) {
        console.log('[Agent] Finished speaking');

        // Run queued analysis now that GPU is free
        if (pendingAnalysis) {
          const { transcription, context } = pendingAnalysis;
          pendingAnalysis = null;

          const shouldRunProcessor = turnCounter % PROCESSOR_INTERVAL === 0;

          try {
            let srsUpdates: any[] = [];

            // PROCESSOR: Analyze + update SRS (only every N turns)
            if (shouldRunProcessor) {
              console.log('[Processor] Running analysis (GPU now free)...');

              const result = await runSupervisor(userId, transcription, context, {
                useGemini: false,  // Use local LLM only (no Gemini API needed)
                llmUrl: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
              });

              srsUpdates = result.srsUpdates;

              console.log(`[Processor] Analysis complete:`,
                `${result.srsUpdates.length} SRS updates,`,
                `${result.errors.length} errors`);

              if (result.errors.length > 0) {
                console.warn('[Processor] Errors:', result.errors);
              }

              // If we updated SRS, goal might have changed
              if (srsUpdates.length > 0) {
                goalNeedsCheck = true;
                console.log('[Processor] SRS updated - marking goal for recheck');
              }
            }

            // SUPERVISOR: Check goals (only when dirty flag is set)
            if (goalNeedsCheck) {
              console.log('[Supervisor] Checking goal status...');

              // TESTING: Use placeholder goals instead of database
              const USE_PLACEHOLDER_GOALS = process.env.USE_PLACEHOLDER_GOALS === 'true';

              let goalUpdate: string | null = null;

              if (USE_PLACEHOLDER_GOALS) {
                // Simple rotation every 5 turns
                if (turnCounter % 5 === 0) {
                  goalUpdate = PlaceholderGoals.getNextGoal();
                  console.log('[Supervisor] (PLACEHOLDER) New goal:', goalUpdate);
                }
              } else {
                // Use real database-backed goals
                goalUpdate = await ContextManager.getDynamicGoal(userId);
              }

              goalNeedsCheck = false; // Reset flag

              if (goalUpdate) {
                console.log(`[Supervisor] Goal update detected`);

                // Check what type of goal update
                if (goalUpdate.includes('COMPLETED')) {
                  // User completed a goal - praise them!
                  const match = goalUpdate.match(/successfully used "([^"]+)"/);
                  const word = match ? match[1] : '';

                  // Inject praise into conversation
                  setTimeout(() => {
                    if (word) {
                      session.say(`Отлично! Great job using "${word}"!`);
                    }
                  }, 500); // Small delay to feel natural

                  // Goal completed - need to check for new goal
                  goalNeedsCheck = true;

                } else if (goalUpdate.includes('NEW GOAL')) {
                  // New goal set - store for context (don't interrupt immediately)
                  pendingGoalNote = goalUpdate;
                  console.log('[Supervisor] New goal stored for next context refresh');
                }
              } else {
                console.log('[Supervisor] No goal changes');
              }
            }

          } catch (err) {
            console.error('[Supervisor] Failed:', err);
          }
        }
      }

      lastAgentState = newState;
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev: any) => {
      console.error('[Session] Error:', ev.error);
    });

    // === START SESSION ===
    await session.start({
      room: ctx.room,
      agent,
      inputOptions: {
        participantIdentity: participant.identity
      }
    });

    console.log('[Tutor-ED] Sending initial greeting...');
    session.say(langConfig.prompts.greeting);

    // Cleanup on disconnect
    ctx.room.on('disconnected', () => {
      console.log('[Tutor-ED] Session ended');
    });
  },
});

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
