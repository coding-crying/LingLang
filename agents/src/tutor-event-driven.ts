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
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { writeFile, rename } from 'node:fs/promises';
import http from 'node:http';

import { runProcessor } from './tools/supervisor-functions.js';
import { ContextManager } from './lib/context.js';
import { getLanguageConfig } from './config/languages.js';
import { buildInstructions } from './config/prompts/base.js';
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from './config/prompts/supervisor.js';
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
// LOCAL SERVICE AUTO-START
// ============================================================================

function httpGet(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    http.get(url, (res) => {
      clearTimeout(timer);
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    }).on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function ensureLocalServices(): Promise<void> {
  const mode = process.env.SERVICE_MODE || 'local';
  if (mode !== 'local') return;

  const ttsMode = process.env.TTS_MODE || mode;
  const checks = [
    { name: 'STT',  url: 'http://localhost:8000/docs' },
    ...(ttsMode === 'local' ? [{ name: 'TTS',  url: 'http://localhost:50000/docs' }] : []),
    { name: 'LLM',  url: 'http://localhost:11434' },
  ];

  const results = await Promise.all(checks.map(async (c) => ({ ...c, ok: await httpGet(c.url) })));
  const down = results.filter(r => !r.ok);

  if (down.length === 0) {
    console.log('[LocalServices] All services healthy');
    return;
  }

  console.log(`[LocalServices] Down: ${down.map(d => d.name).join(', ')} — launching start_local_services.py`);

  // Resolve path relative to project root (one dir up from agents/src/)
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const script = resolve(projectRoot, 'start_local_services.py');

  const child = spawn('python3', ['-u', script], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[LocalServices] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[LocalServices] ${d}`));
  child.unref(); // Don't keep the agent alive just for this

  // Poll until all needed services are up (max 120s)
  const needed = down.map(d => d.url);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const still = await Promise.all(needed.map(url => httpGet(url).then(ok => ok ? null : url)));
    const remaining = still.filter(Boolean);
    if (remaining.length === 0) {
      console.log('[LocalServices] All services ready');
      return;
    }
  }
  console.warn('[LocalServices] Timed out waiting for services — continuing anyway');
}

// ============================================================================
// AGENT DEFINITION
// ============================================================================

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Ensure local STT/TTS/LLM are running before we need them
    await ensureLocalServices();

    // Only prewarm VAD if NOT using gemini mode (RealtimeModel handles VAD internally)
    const mode = process.env.SERVICE_MODE || 'local';
    if (mode !== 'gemini') {
      console.log('[Tutor-ED] Prewarming VAD...');
      proc.userData.vad = await silero.VAD.load();
      console.log('[Tutor-ED] VAD prewarmed');
    } else {
      console.log('[Tutor-ED] Skipping VAD prewarm (RealtimeModel handles VAD internally)');
    }
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
      // Goal selection + teaching plan is handled by the Supervisor tool (on-demand + timer),
      // not baked into initialContext here.
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
      mode: 'voice',
    });

    // === DYNAMIC INSTRUCTIONS (Supervisor-driven teaching plan) ===
    const baseInstructions = instructions;

    let supervisorPlanText = 'None yet.';
    let supervisorPlanJson: any = null;
    let planStale = true;
    let lastPlanAt = 0;

    // Signals accumulate between supervisor refreshes.
    const pendingSignals: string[] = [];

    // Minimal runtime introspection for the dashboard.
    let lastProcessorRun: any = null;
    let lastPlannerRun: any = null;
    const subagentChats: any[] = [];
    const sessionTrace: Array<{ at: number; event: string; detail?: string }> = [];

    const trace = (event: string, detail?: string) => {
      const entry = { at: Date.now(), event, detail };
      sessionTrace.push(entry);
      if (sessionTrace.length > 200) sessionTrace.shift();
      const suffix = detail ? ` ${detail}` : '';
      console.log(`[Trace] ${event}${suffix}`);
      writeRuntimeStateSoon();
    };

    const addSubagentChat = (role: string, prompt: string, response: string) => {
      subagentChats.push({ role, timestamp: Date.now(), prompt, response });
      if (subagentChats.length > 50) subagentChats.shift();
    };

    const runtimeStatePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runtime_state.json');
    let runtimeStateWritePending: NodeJS.Timeout | null = null;
    const writeRuntimeStateSoon = () => {
      if (runtimeStateWritePending) return;
      runtimeStateWritePending = setTimeout(() => {
        runtimeStateWritePending = null;
        try {
          const state = {
            userId,
            targetLang,
            lastPlanAt,
            planStale,
            pendingSignals,
            supervisorPlan: supervisorPlanJson,
            lastProcessorRun,
            lastPlannerRun,
            subagentChats,
            sessionTrace,
            updatedAt: new Date(),
          };
          // Write atomically
          const tmp = runtimeStatePath + '.tmp';
          writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
            .then(() => rename(tmp, runtimeStatePath))
            .catch(() => {});
        } catch {}
      }, 250);
    };

    const buildDynamicInstructions = () => {
      const last = lastPlanAt ? new Date(lastPlanAt).toISOString() : 'never';
      const errorContext = lastProcessorRun?.structuredErrors
        ?.map((e: any) => `${e.lemma}: ${e.grammarRule?.rule || 'error'}`)
        .join('; ') || 'None';

      const hintContext = lastProcessorRun?.grammarHints?.join(' ') || 'None';

      return `${baseInstructions}

# Supervisor (DO NOT ROLEPLAY THIS SECTION)
PLAN_STALE: ${planStale}
LAST_PLAN_AT: ${last}

CURRENT_TEACHING_PLAN:
${supervisorPlanText}

RECENT_ERRORS: ${errorContext}
GRAMMAR_HINTS: ${hintContext}

Rules:
- You are the conversation tutor (you speak to the user).
- The Supervisor updates CURRENT_TEACHING_PLAN automatically (timer + signals). You do not need to call tools.
- Follow CURRENT_TEACHING_PLAN closely, but keep the conversation natural.
- Use GRAMMAR_HINTS to correct the underlying pattern, not just the individual word.
- If the user explicitly requests a different learning style, adapt immediately and the Supervisor will update the plan.
`;
    };

    // === CREATE AGENT ===
    const agent = new voice.Agent({
      instructions: buildDynamicInstructions(),
    });

    // === CREATE SERVICES (LOCAL, CLOUD, OR GEMINI) ===
    const { ServiceFactory } = await import('./services/factory.js');
    const serviceFactory = new ServiceFactory({
      mode: (process.env.SERVICE_MODE as 'local' | 'cloud' | 'local-gemma-audio' | 'gemini') || 'local',
      targetLanguage: targetLang,
      userId,
    });

    const mode = serviceFactory.getMode();
    const isGemini = mode === 'gemini';

    const sttService = isGemini ? undefined : serviceFactory.createSTT();
    const llmService = await serviceFactory.createLLM();
    const ttsService = isGemini ? undefined : await serviceFactory.createTTS();

    console.log(`[Tutor-ED] Service mode: ${mode}`);
    trace(
      'services.created',
      `mode=${mode} stt=${sttService?.constructor?.name || 'none'} llm=${llmService?.constructor?.name || 'none'} tts=${ttsService?.constructor?.name || 'none'}`,
    );
    if (sttService) {
      trace('services.stt.capabilities', JSON.stringify((sttService as any).capabilities));
    }
    if (ttsService) {
      trace('services.tts.capabilities', JSON.stringify((ttsService as any).capabilities));
    }
    if (llmService) {
      trace('services.llm.capabilities', JSON.stringify((llmService as any).capabilities || {}));
    }

    // === CREATE SESSION ===
    // RealtimeModel handles its own VAD, STT, and TTS internally
    const sessionConfig: any = {
      agent,
      llm: llmService,
    };

    // Only add VAD/STT/TTS for non-RealtimeModel modes
    if (!isGemini) {
      sessionConfig.vad = ctx.proc.userData.vad as silero.VAD;
      sessionConfig.stt = sttService;
      sessionConfig.tts = ttsService;
    }

    const session = new voice.AgentSession(sessionConfig);

    // === DIAGNOSTIC: Check RealtimeModel state ===
    console.log(`[DIAG] session.llm type: ${sessionConfig.llm?.constructor?.name}`);
    console.log(`[DIAG] session.llm capabilities: ${JSON.stringify((sessionConfig.llm as any)?.capabilities)}`);
    console.log(`[DIAG] isGemini=${isGemini}, llmService type=${llmService?.constructor?.name}`);

    // === CONVERSATION TRACKING ===
    const history = new ConversationHistory();

    const origGenerateReply = session.generateReply.bind(session);
    session.generateReply = ((...args: any[]) => {
      trace('session.generateReply', `args=${JSON.stringify(args)}`);
      return origGenerateReply(...args);
    }) as typeof session.generateReply;

    const origLlmNode = agent.llmNode.bind(agent);
    agent.llmNode = (async (...args: any[]) => {
      const chatCtx = args[0];
      const itemCount = chatCtx?.items?.length ?? 'unknown';
      trace('agent.llmNode.start', `items=${itemCount}`);
      try {
        const stream = await origLlmNode(...args);
        trace('agent.llmNode.ready', `hasStream=${stream !== null}`);
        return stream;
      } catch (error) {
        trace('agent.llmNode.error', String(error));
        throw error;
      }
    }) as typeof agent.llmNode;

    const origTtsNode = agent.ttsNode.bind(agent);
    agent.ttsNode = (async (...args: any[]) => {
      trace('agent.ttsNode.start');
      try {
        const stream = await origTtsNode(...args);
        trace('agent.ttsNode.ready', `hasStream=${stream !== null}`);
        return stream;
      } catch (error) {
        trace('agent.ttsNode.error', String(error));
        throw error;
      }
    }) as typeof agent.ttsNode;

    const origSttNode = agent.sttNode.bind(agent);
    agent.sttNode = (async (...args: any[]) => {
      try {
        const activity = (agent as any)._agentActivity;
        const activityStt = activity?.stt as any;
        trace(
          'agent.sttNode.start',
          `activityStt=${activityStt?.constructor?.name || 'none'} capabilities=${JSON.stringify(activityStt?.capabilities)}`,
        );
        const stream = await origSttNode(...args);
        trace('agent.sttNode.ready', `hasStream=${stream !== null}`);
        return stream;
      } catch (error) {
        trace('agent.sttNode.error', String(error));
        throw error;
      }
    }) as typeof agent.sttNode;

    // === HELPERS: instruction refresh ===
    const refreshInstructions = async () => {
      trace('instructions.refresh');
      (agent as any)._instructions = buildDynamicInstructions();
      await agent.updateChatCtx((agent as any)._chatCtx);
    };

    // === SUPERVISOR (background planner) ===

    const updatePlanNow = async (reason: string) => {
      try {
      const now = Date.now();
      trace('planner.update.start', `reason=${reason}`);
      const cooldownMs = Number(process.env.PLAN_COOLDOWN_MS || 30_000);
      if (lastPlanAt && now - lastPlanAt < cooldownMs && reason !== 'user_request') {
        trace('planner.update.skipped', `reason=${reason} cooldownMs=${cooldownMs}`);
        return;
      }

      const recentHistory = history.getContext();
      const dbContext = await ContextManager.getInitialContext(userId);
      const goalNote = await ContextManager.updateGoals(userId,
        lastProcessorRun?.structuredErrors
          ? { errors: lastProcessorRun.structuredErrors, grammarHints: lastProcessorRun.grammarHints || [] }
          : undefined
      );

      // Use Step 3.5 Flash (via OpenRouter) by default for deeper planning.
      const plannerUrl = process.env.SUPERVISOR_PLANNER_LLM_URL || process.env.SUPERVISOR_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1';
      const plannerModel = process.env.SUPERVISOR_PLANNER_LLM_MODEL || process.env.SUPERVISOR_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-26b';
      const plannerKey = process.env.SUPERVISOR_PLANNER_LLM_KEY || process.env.SUPERVISOR_LLM_KEY || process.env.LOCAL_LLM_KEY || '';

      const systemPrompt = PLANNER_SYSTEM_PROMPT;

      const userPrompt = buildPlannerPrompt({
        dbContext,
        goalNote,
        recentHistory,
        previousPlan: supervisorPlanJson ? { ...supervisorPlanJson, _updatedAt: lastPlanAt } : null,
        reason,
        signals: pendingSignals,
      });

      const resp = await fetch(`${plannerUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${plannerKey}`,
        },
        body: JSON.stringify({
          model: plannerModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 2048,
        }),
      });

      const data = (await resp.json()) as any;
      const msg = data.choices?.[0]?.message;
      const content = msg?.content || msg?.reasoning_content || '';
      let jsonText = String(content).trim();
      const block = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (block?.[1]) jsonText = block[1].trim();

      let parsed: any;
      try {
        // Clean common LLM JSON issues before parsing
        const cleaned = jsonText
          .replace(/,(\s*[}\]])/g, '$1')         // Trailing commas
          .replace(/([{,]\s*)(\w+):/g, '$1"$2":') // Unquoted keys
          .replace(/\\\n/g, '\\n');               // Escaped newlines
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn(`[Planner] JSON parse failed: ${String(parseErr).substring(0, 80)}`);
        console.warn(`[Planner] Raw: ${jsonText.substring(0, 200)}`);
        return;
      }

      supervisorPlanJson = parsed;
      supervisorPlanText = JSON.stringify(parsed, null, 2);

      lastPlannerRun = {
        at: now,
        reason,
        rawPrompt: systemPrompt + '\n\n' + userPrompt,
        rawResponse: content
      };
      addSubagentChat('Planner (Supervisor)', systemPrompt + '\n\n' + userPrompt, content);

      lastPlanAt = now;
      planStale = false;
      pendingSignals.length = 0;
      writeRuntimeStateSoon();

      await refreshInstructions();
      trace('planner.update.done', `reason=${reason}`);
      } catch (planErr) {
        console.warn(`[Planner] updatePlanNow failed: ${String(planErr).substring(0, 120)}`);
        trace('planner.update.error', String(planErr));
      }
    };

    // Timer: replan at regular intervals or when signals accumulate
    const PLAN_TICK_MS = Number(process.env.PLAN_TICK_MS || 30_000);
    const planTimer = setInterval(() => {
      if (pendingSignals.length > 0 || !lastPlanAt) {
        updatePlanNow('timer').catch(() => {});
      }
    }, PLAN_TICK_MS);

    // Generate an initial plan quickly once we have session context.
    updatePlanNow('session_start').catch(() => {});

    await refreshInstructions();

    // === PROCESSOR (DB population) ===
    // Batch ingestion: run the processor every N user turns and feed it the last N turns.
    const PROCESSOR_TURN_INTERVAL = Number(process.env.PROCESSOR_TURN_INTERVAL || 1);
    const pendingUserTurns: string[] = [];
    let totalUserTurns = 0;
    let lastProcessedTranscript = '';  // Deduplicate: STT may emit FINAL_TRANSCRIPT after VAD EOU

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, async (ev: any) => {
      trace(
        'session.user_input_transcribed',
        `final=${!!ev.isFinal} transcript=${JSON.stringify((ev.transcript || ev.text || '').slice(0, 160))}`,
      );
      if (!ev.isFinal) return;

      const transcription = ev.transcript || ev.text || '';
      if (!transcription) return;

      // Deduplicate: the VAD EOU and STT FINAL_TRANSCRIPT can both trigger this
      // with the same text within ~500ms. Skip if we already processed this exact text.
      if (transcription === lastProcessedTranscript) {
        console.log(`[User] Duplicate transcript skipped: "${transcription.substring(0, 50)}"`);
        trace('session.user_input_duplicate', transcription.substring(0, 80));
        return;
      }
      lastProcessedTranscript = transcription;

      console.log(`[User] ${transcription}`);
      history.addUserTurn(transcription);

      totalUserTurns++;
      pendingUserTurns.push(transcription);
      if (pendingUserTurns.length > PROCESSOR_TURN_INTERVAL) {
        pendingUserTurns.shift();
      }

      // Only run the processor every N turns
      if (totalUserTurns % PROCESSOR_TURN_INTERVAL !== 0) return;

      const batchUtterance = pendingUserTurns.join('\n');

      runProcessor(userId, batchUtterance, history.getContext(), {
        useGemini: false,
        llmUrl: process.env.PROCESSOR_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1',
        llmModel: process.env.PROCESSOR_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-26b',
        llmKey: process.env.PROCESSOR_LLM_KEY || process.env.LOCAL_LLM_KEY || '',
        recentHistory: history.getContext(),
      }).then((result) => {
        lastProcessorRun = {
          at: Date.now(),
          batch: pendingUserTurns.slice(),
          analysisLexemeCount: result.analysis?.lexemes?.length || 0,
          srsUpdateCount: result.srsUpdates?.length || 0,
          errors: result.errors,
          rawPrompt: result.rawPrompt,
          rawResponse: result.rawResponse,
        };
        addSubagentChat('Processor', result.rawPrompt || 'No prompt', result.rawResponse || 'No response');
        writeRuntimeStateSoon();
        if (result.errors.length) {
          console.warn('[Processor] Errors:', result.errors);
        }

        // Any processor run is a potential supervisor trigger (signals accumulate for timer-based replanning).
        if ((result.analysis?.lexemes?.length || 0) > 0) {
          pendingSignals.push('processor_analysis');
        }
        if ((result.srsUpdates?.length || 0) > 0) {
          pendingSignals.push('srs_updated');
        }

        // Mark stale so supervisor considers a refresh on the next timer tick.
        planStale = true;
        writeRuntimeStateSoon();
        refreshInstructions().catch(() => {});
      }).catch((err) => {
        console.error('[Processor] Failed:', err);
        trace('processor.error', String(err));
      });
    });

    // Cleanup timer
    ctx.room.on('disconnected', () => {
      clearInterval(planTimer);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev: any) => {
      console.error('[Session] Error:', ev.error || ev);
      trace('session.error', String(ev.error || ev));
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev: any) => {
      console.log(`[Session] SpeechCreated (source: ${ev.source})`);
      trace('session.speech_created', `source=${ev.source}`);
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev: any) => {
      console.log(`[Session] AgentStateChanged: ${ev.newState}`);
      trace('session.agent_state_changed', String(ev.newState));
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: any) => {
      console.log(`[Session] MetricsCollected:`, JSON.stringify(ev.metrics || ev).substring(0, 300));
      trace('session.metrics_collected');
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev: any) => {
      console.log(`[Session] FunctionToolsExecuted:`, ev);
      trace('session.function_tools_executed');
    });

    // Additional debug events for RealtimeModel
    session.on('UserInputTranscribed' as any, (ev: any) => {
      console.log(`[Session] UserInputTranscribed:`, ev.transcript, `final=${ev.isFinal}`);
    });

    if (isGemini) {
      console.log('[Tutor-ED] Gemini mode: enabling additional event logging');
      session.on('UserStateChanged' as any, (ev: any) => {
        console.log(`[Session] UserStateChanged: ${ev.newState}`);
      });
    }

    // === DIAGNOSTIC: Deep trace of _startImpl ===
    const sessProto = Object.getPrototypeOf(session);
    const origStartImpl = sessProto._startImpl;
    console.log(`[DIAG] sessProto constructor: ${sessProto.constructor.name}`);
    console.log(`[DIAG] sessProto._startImpl source: ${origStartImpl.toString().slice(0, 120)}...`);
    sessProto._startImpl = async function(this: any, opts: any) {
      console.log(`[DIAG] _startImpl called, this===session: ${this === session}, room=${!!opts.room}`);
      console.log(`[DIAG] Pre-startImpl props: roomIO=${!!this.roomIO} _roomIO=${!!this._roomIO} sessionHost=${!!this.sessionHost}`);
      try {
        await origStartImpl.call(this, opts);
      } catch (e) {
        console.error(`[DIAG] _startImpl threw:`, e);
        throw e;
      }
      console.log(`[DIAG] _startImpl completed, roomIO=${!!this.roomIO} _roomIO=${!!this._roomIO} sessionHost=${!!this.sessionHost}`);
    };

    // Also patch registerByteStreamHandler
    const origRegister = ctx.room.registerByteStreamHandler.bind(ctx.room);
    (ctx.room as any).registerByteStreamHandler = (topic: string, cb: any) => {
      console.log(`[DIAG] registerByteStreamHandler called for topic: ${topic}`);
      origRegister(topic, cb);
      console.log(`[DIAG] registerByteStreamHandler done for topic: ${topic}`);
    };

    console.log(`[DIAG] About to call session.start(), room connected: ${ctx.room.isConnected}`);
    trace('session.start.begin', `roomConnected=${ctx.room.isConnected}`);

    // === START SESSION ===
    await session.start({
      room: ctx.room,
      agent,
      inputOptions: {
        participantIdentity: participant.identity
      }
    });

    console.log(`[DIAG] session.start() completed, _roomIO=${!!(session as any)._roomIO}, sessionHost=${!!(session as any).sessionHost}`);
    trace(
      'session.start.done',
      `_roomIO=${!!(session as any)._roomIO} sessionHost=${!!(session as any).sessionHost}`,
    );
    console.log(`[DIAG] session.activity: ${!!(session as any).activity}, type=${(session as any).activity?.constructor?.name}`);
    const activity = (session as any).activity;
    if (activity) {
      console.log(`[DIAG] activity.llm type: ${activity.llm?.constructor?.name}, llm=${activity.llm?.constructor?.name}`);
      console.log(`[DIAG] activity.realtimeSession: ${!!activity.realtimeSession}`);
      console.log(`[DIAG] activity.llm instanceof RealtimeModel: ${activity.llm?.constructor?.name === 'RealtimeModel'}`);
      // Check if the RealtimeModel is from the same module
      const modelPkg = activity.llm?.constructor?.__module || 'unknown';
      console.log(`[DIAG] activity.llm module: ${modelPkg}`);
      trace(
        'session.activity.ready',
        `stt=${activity.stt?.constructor?.name || 'none'} tts=${activity.tts?.constructor?.name || 'none'} llm=${activity.llm?.constructor?.name || 'none'}`,
      );

      if (typeof activity.scheduleSpeech === 'function') {
        const origScheduleSpeech = activity.scheduleSpeech.bind(activity);
        activity.scheduleSpeech = ((speechHandle: any, priority: any) => {
          trace(
            'activity.scheduleSpeech',
            `speechId=${speechHandle?.id || 'unknown'} priority=${String(priority)} interrupted=${!!speechHandle?.interrupted}`,
          );
          return origScheduleSpeech(speechHandle, priority);
        }) as typeof activity.scheduleSpeech;
      }

      if (typeof activity.pipelineReplyTask === 'function') {
        const origPipelineReplyTask = activity.pipelineReplyTask.bind(activity);
        activity.pipelineReplyTask = (async (...args: any[]) => {
          const speechHandle = args[0];
          trace(
            'activity.pipelineReplyTask.start',
            `speechId=${speechHandle?.id || 'unknown'} interrupted=${!!speechHandle?.interrupted} scheduled=${!!speechHandle?.scheduled}`,
          );
          try {
            const result = await origPipelineReplyTask(...args);
            trace(
              'activity.pipelineReplyTask.done',
              `speechId=${speechHandle?.id || 'unknown'} scheduled=${!!speechHandle?.scheduled} interrupted=${!!speechHandle?.interrupted}`,
            );
            return result;
          } catch (error) {
            trace('activity.pipelineReplyTask.error', String(error));
            throw error;
          }
        }) as typeof activity.pipelineReplyTask;
      }

      if (typeof activity._pipelineReplyTaskImpl === 'function') {
        const origPipelineReplyTaskImpl = activity._pipelineReplyTaskImpl.bind(activity);
        activity._pipelineReplyTaskImpl = (async (opts: any) => {
          trace(
            'activity._pipelineReplyTaskImpl.start',
            `speechId=${opts?.speechHandle?.id || 'unknown'} newMessage=${JSON.stringify(opts?.newMessage?.textContent || '')}`,
          );
          try {
            const result = await origPipelineReplyTaskImpl(opts);
            trace(
              'activity._pipelineReplyTaskImpl.done',
              `speechId=${opts?.speechHandle?.id || 'unknown'} scheduled=${!!opts?.speechHandle?.scheduled} interrupted=${!!opts?.speechHandle?.interrupted}`,
            );
            return result;
          } catch (error) {
            trace('activity._pipelineReplyTaskImpl.error', String(error));
            throw error;
          }
        }) as typeof activity._pipelineReplyTaskImpl;
      }

      const speechHandleProto = activity._currentSpeech
        ? Object.getPrototypeOf(activity._currentSpeech)
        : null;
      if (speechHandleProto) {
        if (typeof speechHandleProto._waitForScheduled === 'function' && !speechHandleProto.__traceWaitForScheduledPatched) {
          const origWaitForScheduled = speechHandleProto._waitForScheduled;
          speechHandleProto._waitForScheduled = function(this: any, ...args: any[]) {
            trace('speechHandle._waitForScheduled', `speechId=${this?.id || 'unknown'} scheduled=${!!this?.scheduled}`);
            return origWaitForScheduled.apply(this, args);
          };
          speechHandleProto.__traceWaitForScheduledPatched = true;
        }
        if (typeof speechHandleProto._waitForAuthorization === 'function' && !speechHandleProto.__traceWaitForAuthorizationPatched) {
          const origWaitForAuthorization = speechHandleProto._waitForAuthorization;
          speechHandleProto._waitForAuthorization = function(this: any, ...args: any[]) {
            trace(
              'speechHandle._waitForAuthorization',
              `speechId=${this?.id || 'unknown'} interrupted=${!!this?.interrupted} authorized=${!!this?._authorized}`,
            );
            return origWaitForAuthorization.apply(this, args);
          };
          speechHandleProto.__traceWaitForAuthorizationPatched = true;
        }
        if (typeof speechHandleProto._authorizeGeneration === 'function' && !speechHandleProto.__traceAuthorizeGenerationPatched) {
          const origAuthorizeGeneration = speechHandleProto._authorizeGeneration;
          speechHandleProto._authorizeGeneration = function(this: any, ...args: any[]) {
            trace(
              'speechHandle._authorizeGeneration',
              `speechId=${this?.id || 'unknown'} interrupted=${!!this?.interrupted} scheduled=${!!this?.scheduled}`,
            );
            return origAuthorizeGeneration.apply(this, args);
          };
          speechHandleProto.__traceAuthorizeGenerationPatched = true;
        }
      }
    } else {
      console.log(`[DIAG] NO activity on session`);
      trace('session.activity.missing');
    }

    console.log('[Tutor-ED] Sending initial greeting...');
    // RealtimeModel doesn't support say() - AgentSession handles it internally
    // The agent instructions already contain the greeting context
    if (!isGemini) {
      trace('session.say.initial_greeting');
      session.say(langConfig.prompts.greeting);
    }
    // For gemini, let AgentSession handle the initial response naturally

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
