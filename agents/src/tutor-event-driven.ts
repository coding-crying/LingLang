/**
 * Event-Driven Tutor Agent (Optimized)
 *
 * This version separates Processor and Planner with smart triggers:
 * - PROCESSOR: Analyzes utterance + updates SRS (runs every turn by default)
 * - PLANNER: Produces teaching nudges (runs on timer + signal accumulation)
 *
 * Architecture:
 *   User speaks → STT → UserInputTranscribed event
 *                              ↓
 *              ┌───────────────┴───────────────┐
 *              ↓                               ↓
 *        LLM responds                   Processor (every turn)
 *        (immediate)                    └─> Analyze + Update SRS
 *              ↓                               ↓
 *        TTS speaks                     signals accumulate
 *                                       └─> Planner (timer)
 *                                              ↓
 *                                    [nudge injected into instructions]
 *
 * Planner Triggers:
 * - Session start (skip if no vocab)
 * - Timer tick (30s) when signals pending
 * - After processor SRS updates
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
import { dbTools } from './tools/db-tools.js';
import { ContextManager } from './lib/context.js';
import { getLanguageConfig, nativeLanguageName } from './config/languages.js';
import { buildInstructions } from './config/prompts/base.js';
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from './config/prompts/supervisor.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { emitEvent, setSessionId } from './lib/trace.js';

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
  private maxTurns = 5; // Planner maintains a running summary for older context

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

  // Build the set of health checks based on the active mode.
  // In local-gemma-audio and gemini modes the vLLM/STT backend on 8093 is still required.
  const ttsMode = process.env.TTS_MODE || 'local';
  const checks: Array<{ name: string; url: string }> = [];

  if (ttsMode === 'local') {
    checks.push({ name: 'TTS', url: 'http://localhost:8882/v1/audio/speech' });
  }

  if (mode === 'local' || mode === 'local-gemma-audio') {
    checks.push({ name: 'LLM', url: 'http://localhost:8093/v1/models' });
  }

  if (checks.length === 0) {
    return; // nothing local to check (e.g. gemini / cloud-only)
  }

  const t0 = Date.now();
  const results = await Promise.all(
    checks.map(async (c) => {
      const tStart = Date.now();
      const ok = await httpGet(c.url);
      return { ...c, ok, latencyMs: Date.now() - tStart };
    }),
  );
  const down = results.filter((r) => !r.ok);

  // Emit per-service health event so a dead backend is visible at session start
  // (not buried in agent_output.log).
  for (const r of results) {
    try {
      emitEvent('services.health', {
        name: r.name,
        url: r.url,
        healthy: r.ok,
        latencyMs: r.latencyMs,
      });
    } catch { /* trace not initialized in prewarm — harmless */ }
  }

  if (down.length === 0) {
    console.log(`[LocalServices] All ${results.length} services healthy (${Date.now() - t0}ms)`);
    return;
  }

  console.warn(
    `[LocalServices] Down: ${down.map((d) => `${d.name}@${d.url}`).join(', ')} — agent will rely on fallbacks or fail. Start with systemd or check service health.`,
  );
}

// ============================================================================
// AGENT DEFINITION
// ============================================================================
// SESSION SUMMARY — persisted from planner's running summary, no extra LLM call
// ============================================================================

function persistSessionSummary(
  userId: string,
  startedAt: Date,
  runningSummary: string,
  stats: { totalSrsUpdates: number; allErrors: Array<{ lemma: string; rule?: string }>; allHints: string[] },
): void {
  const endedAt = new Date();
  const durationMinutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000);

  if (durationMinutes < 1) return; // too short to summarize

  // De-duplicate errors by lemma, keep last rule seen
  const errorMap = new Map<string, string>();
  for (const e of stats.allErrors) {
    errorMap.set(e.lemma, e.rule || 'error');
  }
  const errorsPattern = [...errorMap.entries()].map(([lemma, rule]) => `${lemma}: ${rule}`).join('; ') || null;
  const nextHint = stats.allHints.length > 0 ? [...new Set(stats.allHints)].slice(-3).join('; ') : null;

  // The planner has been maintaining a running summary all session — use it directly.
  const summary = runningSummary || `Session lasted ${durationMinutes}min with ${stats.totalSrsUpdates} word reviews.`;

  ContextManager.writeSessionSummary(userId, {
    startedAt,
    endedAt,
    durationMinutes,
    topicsCovered: null, // planner's summary already captures this
    wordsWorked: null,
    errorsPattern,
    summary,
    nextSessionHint: nextHint,
  }).then(() => {
    console.log(`[Tutor-ED] Session summary written (${durationMinutes}min)`);
  }).catch((err) => {
    console.warn('[Tutor-ED] Failed to write session summary:', String(err).substring(0, 100));
  });
}

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
    setSessionId(`room-${ctx.room.name}-${userId}`);

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
    emitEvent('session.start', { userId, language: langConfig.name, mode: process.env.SERVICE_MODE || 'local' });

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

    const usersNativeLanguage = nativeLanguageName(user.nativeLanguage || 'en');

    const instructions = buildInstructions({
      targetLanguage: langConfig.name,
      nativeName: langConfig.nativeName,
      nativeLanguage: usersNativeLanguage,
      targetRatio: langConfig.pedagogy.targetLanguageRatio,
      userLevel: user.proficiencyLevel || 'beginner',
      persona: langConfig.persona,
      initialContext,
      mode: 'voice',
      recentErrors: 'None',
      grammarHints: 'None',
      goalUpdate: '',
    });

    // === DYNAMIC INSTRUCTIONS (Supervisor-driven teaching plan) ===
    const baseInstructions = instructions;

    let supervisorNudge = '';
    let runningSummary = '';
    let lastPlanAt = 0;
    const sessionStartedAt = new Date();

    // Cumulative session data for summary on disconnect
    const sessionStats = {
      totalSrsUpdates: 0,
      allErrors: [] as Array<{ lemma: string; rule?: string }>,
      allHints: [] as string[],
    };

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
      writeRuntimeStateSoon();
      // emitEvent handles both console.log and JSONL write
      emitEvent(event as any, { detail: detail || '' });
    };

    const MAX_SUBAGENT_PREVIEW = 500;
    const addSubagentChat = (role: string, prompt: string, response: string) => {
      subagentChats.push({
        role,
        timestamp: Date.now(),
        prompt: prompt.substring(0, MAX_SUBAGENT_PREVIEW),
        response: response.substring(0, MAX_SUBAGENT_PREVIEW),
      });
      if (subagentChats.length > 20) subagentChats.shift();
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
            pendingSignals,
            supervisorNudge,
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
      const errorContext = lastProcessorRun?.structuredErrors
        ?.map((e: any) => `${e.lemma}: ${e.grammarRule?.rule || 'error'}`)
        .join('; ') || 'None';

      const hintContext = lastProcessorRun?.grammarHints?.join(' ') || 'None';

      // Rebuild base instructions with current errors/hints (fills placeholders)
      const updatedBase = buildInstructions({
        targetLanguage: langConfig.name,
        nativeName: langConfig.nativeName,
        nativeLanguage: usersNativeLanguage,
        targetRatio: langConfig.pedagogy.targetLanguageRatio,
        userLevel: user.proficiencyLevel || 'beginner',
        persona: langConfig.persona,
        initialContext,
        mode: 'voice',
        recentErrors: errorContext,
        grammarHints: hintContext,
        goalUpdate: supervisorNudge || 'Get them talking. Find out what they know, then build from there.',
      });

      return `${updatedBase}

You have tools to look up words and check the learner's progress. Use them when you need to — not every turn.
Correct the underlying pattern, not just the individual word.`;
    };

    // === CREATE AGENT ===
    const agent = new voice.Agent({
      instructions: buildDynamicInstructions(),
      tools: dbTools as any,
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

    // === WARM UP LOCAL LLM ===
    // llama-swap unloads models after idle TTL; first request after load takes 30s+.
    // Fire a tiny request to wake the model and populate the KV cache before the user speaks.
    if (!isGemini && (llmService as any).model) {
      const warmUrl = process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1';
      const warmModel = (llmService as any).model;
      console.log(`[Warmup] Warming local LLM: ${warmModel}`);
      fetch(`${warmUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: warmModel,
          messages: [{ role: 'user', content: 'ready' }],
          max_tokens: 1,
        }),
      }).then(() => console.log(`[Warmup] Local LLM ready`))
        .catch((e: any) => console.log(`[Warmup] Failed (non-fatal): ${e.message}`));
    }
    // Also warm the supervisor/processor model (think variant) in parallel
    {
      const supModel = process.env.SUPERVISOR_LLM_MODEL || process.env.LOCAL_LLM_MODEL;
      const supUrl = process.env.SUPERVISOR_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1';
      if (supModel && supModel !== ((llmService as any).model)) {
        fetch(`${supUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: supModel,
            messages: [{ role: 'user', content: 'ready' }],
            max_tokens: 1,
          }),
        }).then(() => console.log(`[Warmup] Supervisor model ready`))
          .catch(() => {});
      }
    }
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
      userData: { userId },
      userAwayTimeout: 120, // 2 min — default 15s is too aggressive for language tutoring
    };

    // Only add VAD/STT/TTS for non-RealtimeModel modes
    if (!isGemini) {
      sessionConfig.vad = ctx.proc.userData.vad as silero.VAD;
      sessionConfig.stt = sttService;
      sessionConfig.tts = ttsService;
    }

    const session = new voice.AgentSession(sessionConfig);

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

    // Cache DB context between planner cycles — SRS state doesn't shift much in 30s.
    // Refresh on session start and after processor runs (when SRS actually updates).
    let cachedDbContext = '';
    let cachedNotes = '';
    let cachedSessions = '';
    let dbContextAt = 0;

    const refreshDbContext = async () => {
      const [dbContext, notes, sessions] = await Promise.all([
        ContextManager.getInitialContext(userId),
        ContextManager.getNotesContext(userId),
        ContextManager.getSummariesContext(userId),
      ]);
      cachedDbContext = dbContext;
      cachedNotes = notes;
      cachedSessions = sessions;
      dbContextAt = Date.now();
    };

    // Warm the cache at session start
    refreshDbContext().catch(() => {});

    const updatePlanNow = async (reason: string) => {
      try {
      const now = Date.now();
      trace('planner.update.start', `reason=${reason}`);
      const cooldownMs = Number(process.env.PLAN_COOLDOWN_MS || 30_000);
      if (lastPlanAt && now - lastPlanAt < cooldownMs && reason !== 'user_request') {
        trace('planner.update.skipped', `reason=${reason} cooldownMs=${cooldownMs}`);
        return;
      }

      // Refresh DB cache if stale (older than 60s) or on session start
      if (!cachedDbContext || reason === 'session_start' || now - dbContextAt > 60_000) {
        await refreshDbContext();
      }

      const recentHistory = history.getContext();
      const dbContext = cachedDbContext;

      // Skip LLM call on session_start if there's no vocab to plan from.
      if (reason === 'session_start' && !dbContext.trim()) {
        supervisorNudge = 'Start simple. Find out what they know, then build from there.';
        lastPlanAt = now;
        trace('planner.update.skipped', 'reason=no_vocab');
        await refreshInstructions();
        return;
      }

      const goalNote = await ContextManager.updateGoals(userId,
        lastProcessorRun?.structuredErrors
          ? { errors: lastProcessorRun.structuredErrors, grammarHints: lastProcessorRun.grammarHints || [] }
          : undefined
      );

      const notes = cachedNotes;
      const recentSessions = cachedSessions;

      // Use Step 3.5 Flash (via OpenRouter) by default for deeper planning.
      const plannerUrl = process.env.SUPERVISOR_PLANNER_LLM_URL || process.env.SUPERVISOR_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1';
      const plannerModel = process.env.SUPERVISOR_PLANNER_LLM_MODEL || process.env.SUPERVISOR_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-26b';
      const plannerKey = process.env.SUPERVISOR_PLANNER_LLM_KEY || process.env.SUPERVISOR_LLM_KEY || process.env.LOCAL_LLM_KEY || '';

      const systemPrompt = PLANNER_SYSTEM_PROMPT;

      const userPrompt = buildPlannerPrompt({
        dbContext,
        goalNote,
        recentHistory,
        previousNudge: supervisorNudge || null,
        runningSummary,
        reason,
        signals: pendingSignals,
        notes,
        recentSessions,
      });

      const resp = await fetch(`${plannerUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(plannerKey ? { Authorization: `Bearer ${plannerKey}` } : {}),
        },
        body: JSON.stringify({
          model: plannerModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 4096,
        }),
      });

      const data = (await resp.json()) as any;
      const msg = data.choices?.[0]?.message;
      // Think models: content may be empty if reasoning consumed the budget.
      // Fall back to reasoning_content, or extract JSON from it.
      let content = msg?.content || '';

      if (!content && msg?.reasoning_content) {
        content = String(msg.reasoning_content).trim();
      }

      if (!content) {
        console.warn('[Planner] Empty response — skipping');
        return;
      }

      // Parse structured output from the planner — strict line-by-line:
      // NUDGE: <text>        — the teaching nudge (required)
      // SUMMARY: <text>      — updated running summary (required)
      // NOTE[category]: <text> — optional durable learner insight
      //
      // Multi-line values: if NUDGE or SUMMARY needs to span multiple lines,
      // subsequent lines must be indented. Blank lines reset to new field.
      // Only parse NOTE from the actual content, not reasoning_content.
      const noteContent = msg?.content || '';
      let parsedNudge = '';
      let parsedSummary = '';
      const noteRegex = /^NOTE\[([a-z]+)\]:\s*(.+)$/;

      if (noteContent) {
        for (const line of noteContent.split('\n')) {
          const m = line.match(noteRegex);
          if (m) {
            const [, category, noteText] = m;
            await ContextManager.writeNote(userId, category, noteText, 'observed');
            trace('planner.note.written', `${category}: ${noteText.substring(0, 60)}`);
          }
        }
      }

      // Extract NUDGE and SUMMARY — collect lines until next structured header or blank line
      const lines = content.split('\n');
      let currentField: 'nudge' | 'summary' | 'other' | null = null;
      const nudgeLines: string[] = [];
      const summaryLines: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('NUDGE:')) {
          currentField = 'nudge';
          nudgeLines.push(trimmed.slice(6).trim());
          continue;
        }
        if (trimmed.startsWith('SUMMARY:')) {
          currentField = 'summary';
          summaryLines.push(trimmed.slice(8).trim());
          continue;
        }
        if (noteRegex.test(trimmed)) {
          currentField = 'other'; // NOTE lines are parsed above
          continue;
        }
        // Continuation line (indented or mid-paragraph under current field)
        if (currentField === 'nudge' && trimmed) {
          nudgeLines.push(trimmed);
        } else if (currentField === 'summary' && trimmed) {
          summaryLines.push(trimmed);
        } else if (!trimmed) {
          currentField = null; // blank line resets
        }
      }

      parsedNudge = nudgeLines.join(' ').trim();
      parsedSummary = summaryLines.join(' ').trim();

      supervisorNudge = parsedNudge || supervisorNudge || 'Continue the conversation naturally.';
      runningSummary = parsedSummary || runningSummary;

      lastPlannerRun = {
        at: now,
        reason,
        rawPrompt: systemPrompt + '\n\n' + userPrompt,
        rawResponse: content
      };
      addSubagentChat('Planner (Supervisor)', systemPrompt + '\n\n' + userPrompt, content);

      lastPlanAt = now;
      pendingSignals.length = 0;
      writeRuntimeStateSoon();

      // Emit structured planner events for dashboard
      emitEvent('planner.nudge', { reason, nudge: supervisorNudge });
      emitEvent('planner.raw', {
        prompt: (systemPrompt + '\n\n' + userPrompt).substring(0, 4000),
        response: content.substring(0, 4000),
      });

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
      emitEvent('user.transcript', { text: transcription, isFinal: true });

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

        // Accumulate for session summary
        sessionStats.totalSrsUpdates += result.srsUpdates?.length || 0;
        if (result.structuredErrors) {
          for (const e of result.structuredErrors) {
            sessionStats.allErrors.push({ lemma: e.lemma, rule: e.grammarRule?.rule });
          }
        }
        if (result.grammarHints) {
          sessionStats.allHints.push(...result.grammarHints);
        }
        addSubagentChat('Processor', result.rawPrompt || 'No prompt', result.rawResponse || 'No response');
        writeRuntimeStateSoon();

        // Emit structured processor events for dashboard
        emitEvent('processor.analysis', {
          utterance: batchUtterance,
          lexemeCount: result.analysis?.lexemes?.length || 0,
          srsUpdateCount: result.srsUpdates?.length || 0,
          errors: result.errors,
          structuredErrors: result.structuredErrors || [],
          grammarHints: result.grammarHints || [],
        });
        emitEvent('processor.raw', {
          prompt: (result.rawPrompt || '').substring(0, 4000),
          response: (result.rawResponse || '').substring(0, 4000),
        });

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

        // Mark so supervisor considers a refresh on the next timer tick.
        // Also refresh DB cache since SRS state has changed.
        if ((result.srsUpdates?.length || 0) > 0) {
          refreshDbContext();
        }
        writeRuntimeStateSoon();
        refreshInstructions().catch(() => {});
      }).catch((err) => {
        console.error('[Processor] Failed:', err);
        trace('processor.error', String(err));
      });
    });

    // Cleanup timer on disconnect
    ctx.room.once('disconnected', () => {
      clearInterval(planTimer);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev: any) => {
      console.error('[Session] Error:', ev.error || ev);
      trace('session.error', String(ev.error || ev));
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev: any) => {
      trace('session.speech_created', `source=${ev.source}`);
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev: any) => {
      trace('session.agent_state_changed', String(ev.newState));
      emitEvent('agent.state_change', { from: ev.oldState || 'unknown', to: String(ev.newState) });
    });

    // Capture agent replies (LLM responses) for live chat view
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev: any) => {
      const item = ev.item;
      if (item?.role === 'assistant' && item?.textContent) {
        emitEvent('agent.reply', { text: item.textContent, source: item.source || 'unknown' });
        history.addAssistantTurn(item.textContent);
      }
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: any) => {
      trace('session.metrics_collected', JSON.stringify(ev.metrics || ev).substring(0, 200));
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev: any) => {
      trace('session.function_tools_executed');
    });

    // Additional debug events for RealtimeModel
    if (isGemini) {
      session.on('UserStateChanged' as any, (ev: any) => {
        trace('session.user_state_changed', String(ev.newState));
      });
    }

    trace('session.start.begin', `roomConnected=${ctx.room.isConnected}`);

    // === START SESSION ===
    await session.start({
      room: ctx.room,
      agent,
      inputOptions: {
        participantIdentity: participant.identity
      }
    });

    trace('session.start.done');
    const activity = (session as any).activity;
    if (activity) {
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

    // Persist session summary on disconnect — uses planner's running summary, no extra LLM call
    ctx.room.on('disconnected', () => {
      console.log('[Tutor-ED] Session ended');
      clearInterval(planTimer);
      persistSessionSummary(userId, sessionStartedAt, runningSummary, sessionStats);
    });
  },
});

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
