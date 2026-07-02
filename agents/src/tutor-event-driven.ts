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
// override:true ensures .env.local always wins over inherited shell env —
// otherwise a stray SERVICE_MODE=cloud from a parent shell silently pins us
// to the cloud stack and the local gemma-audio path never runs.
const _dotenvResult = dotenv.config({ path: '.env.local', override: true });
const _envMode = process.env.SERVICE_MODE || 'local';
const _envTts = process.env.TTS_MODE || 'local';
const _envLlm = process.env.LOCAL_LLM_URL || 'unset';
const _envLlmModel = process.env.LOCAL_LLM_MODEL || 'unset';
console.log(`[ENV] SERVICE_MODE=${_envMode} TTS_MODE=${_envTts} LLM_URL=${_envLlm} LLM_MODEL=${_envLlmModel} (dotenv loaded ${_dotenvResult.parsed ? Object.keys(_dotenvResult.parsed).length : 0} vars${_dotenvResult.error ? `, error: ${_dotenvResult.error.message}` : ''})`);

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
import { audioPayloadRegistry } from './stt/gemma-audio-stt.js';
import { getLanguageConfig, nativeLanguageName, LANGUAGES } from './config/languages.js';
import { buildInstructions, buildOnboardingInstructions } from './config/prompts/base.js';
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from './config/prompts/supervisor.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { emitEvent, setSessionId } from './lib/trace.js';
import { llmEvents } from './lib/llm-events.js';
import { getOnboardingState, saveOnboardingData, commitOnboardingLevel, buildOnboardingContext } from './lib/onboarding.js';

// ============================================================================
// CONVERSATION HISTORY (for context)
// ============================================================================

/**
 * Audio-aware turn: a user turn may carry a `data:audio/wav;base64,...` URI
 * captured by GemmaAudioSTT (the STT pass-through). The Tutor's main LLM
 * resolves placeholders into audio_url content; the Processor and Planner do
 * the same so they can critique pronunciation, not just lexemes/grammar.
 */
interface AudioAttachment {
  audioId: string;
  audioUri: string;       // data:audio/wav;base64,...
  durationSec: number;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  audio?: AudioAttachment;  // present on user turns that came in as native audio
}

class ConversationHistory {
  private turns: ConversationTurn[] = [];
  private maxTurns = 5; // Planner maintains a running summary for older context

  addUserTurn(content: string, audio?: AudioAttachment) {
    this.turns.push({ role: 'user', content, timestamp: Date.now(), audio });
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

  /**
   * Audio-aware context for Processor/Planner.
   * Returns an array of OpenAI-style chat messages where audio turns become
   * `audio_url` content (mirrors GemmaAudioLLM.buildMessages) so the LLM
   * can analyze pronunciation, not just the placeholder text.
   *
   * Older audio turns are collapsed to a short marker to bound the prompt
   * size — the LLM only needs the *recent* audio for pronunciation feedback.
   */
  getContextAsMessages(opts: { keepRecentAudioTurns?: number } = {}): any[] {
    const MAX_AUDIO_TURNS = opts.keepRecentAudioTurns ?? 3;

    // First pass: find audio turns from the END backwards.
    const audioIndices: number[] = [];
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === 'user' && this.turns[i].audio) {
        audioIndices.push(i);
        if (audioIndices.length >= MAX_AUDIO_TURNS) break;
      }
    }
    const audioKeep = new Set(audioIndices);
    let collapsedOldAudio = false;

    const out: any[] = [];
    for (let i = 0; i < this.turns.length; i++) {
      const t = this.turns[i];
      if (t.role === 'user' && t.audio) {
        if (audioKeep.has(i)) {
          // Recent audio — keep as audio_url content for pronunciation analysis.
          out.push({
            role: 'user',
            content: [
              { type: 'text', text: '[User spoke — analyze their pronunciation and what they said.]' },
              { type: 'audio_url', audio_url: { url: t.audio.audioUri } },
            ],
          });
        } else if (!collapsedOldAudio) {
          collapsedOldAudio = true;
          out.push({
            role: 'user',
            content: '[The user spoke several sentences in Russian earlier in this conversation.]',
          });
        }
        // else: skip — already collapsed
      } else {
        // Plain text turn (assistant replies, or text-only user turns)
        out.push({ role: t.role, content: t.content });
      }
    }
    return out;
  }

  getLastUserTurn(): string | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === 'user') {
        return this.turns[i].content;
      }
    }
    return null;
  }

  /**
   * Read-only view of recent user audio turns. Used by the Planner to hear
   * pronunciation when audio is present. Returns up to `limit` turns, in
   * chronological order (oldest first).
   */
  getRecentAudioTurns(limit: number = 3): AudioAttachment[] {
    const out: AudioAttachment[] = [];
    for (let i = this.turns.length - 1; i >= 0 && out.length < limit; i--) {
      const t = this.turns[i];
      if (t.role === 'user' && t.audio) {
        out.unshift(t.audio);
      }
    }
    return out;
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
    // Mutable: the processor can detect a language change request and
    // update this mid-session, then refresh instructions.
    let targetLang = user.targetLanguage;
    let langConfig = getLanguageConfig(targetLang);
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

    let usersNativeLanguage = nativeLanguageName(user.nativeLanguage || 'en');

    // 2026-06-25: per-language level inference. Reads all DB signals
    // (vocab state distribution, grammar coverage, sessions, lapse rate)
    // and produces a CEFR level. Manual override (dashboard) and onboarding
    // results are respected. Replaces user.proficiencyLevel (global).
    const { inferLevel } = await import('./lib/level-inference.js');
    const levelEstimate = await inferLevel(userId, targetLang);
    const userLevel = levelEstimate.level;
    console.log(`[Tutor-ED] Level: ${userLevel} (${levelEstimate.source}, score=${levelEstimate.score.toFixed(1)}, conf=${levelEstimate.confidence.toFixed(2)})`);

    // === ONBOARDING STATE ===
    // Check if this user has completed onboarding for this language.
    // If not, the agent runs the onboarding conversation first, then
    // switches to normal tutoring once the verdict JSON is emitted.
    const onboardingState = await getOnboardingState(userId, targetLang);
    let inOnboarding = !onboardingState?.isComplete;
    if (inOnboarding) {
      console.log(`[Tutor-ED] Onboarding incomplete for ${userId}/${targetLang} — running intake flow`);
      // Ensure the onboarding row exists (upsert with startedAt)
      await saveOnboardingData(userId, targetLang, {});
    } else {
      console.log(`[Tutor-ED] Onboarding complete for ${userId}/${targetLang}`);
    }

    // Load the user's detected communication style. The processor EMA's the
    // LLM's per-turn styleSignals into user_style; we read the current profile
    // and tell the conversation LLM to mirror it.
    const { readPersona, buildPersonaBlockSync, writePersona, parsePersonaRequest } = await import('./lib/persona.js');
    const initialPersona = await readPersona(userId, targetLang);

    // Mutable persona cache — updated when supervisor writes PERSONA: or user says "be more X"
    let cachedPersona = {
      personaOverride: initialPersona.personaOverride,
      tone: initialPersona.tone,
      correctionStyle: initialPersona.correctionStyle,
      teachingMode: initialPersona.teachingMode,
      extraInstructions: initialPersona.extraInstructions,
    };

    // Mutable cache of the user's style signals, refreshed by the processor
    // when styleSignals arrive. Used by buildDynamicInstructions to compose
    // adaptive length/register/roast lines. Initialized from defaults.
    let currentStyleCache: Record<string, string> = {
      humor: 'warm', pacing: 'medium', register: 'casual',
      preamble: 'low', bsCallouts: 'neutral',
    };

    // 2026-06-25: parse wordsDue/wordsNew out of the initialContext string
    // so the conversation prompt can foreground them as natural conversation
    // seeds, not bury them in a multi-line context dump.
    const wordsDue = extractWordsLine(initialContext, 'Vocabulary to Review');
    const wordsNew = extractWordsLine(initialContext, 'New Vocabulary to Introduce');
    const instructions = buildInstructions({
      targetLanguage: langConfig.name,
      nativeName: langConfig.nativeName,
      nativeLanguage: usersNativeLanguage,
      targetRatio: langConfig.pedagogy.targetLanguageRatio,
      userLevel,
      persona: buildPersonaBlockSync(
        cachedPersona.personaOverride, cachedPersona.tone,
        cachedPersona.correctionStyle, cachedPersona.teachingMode,
        cachedPersona.extraInstructions, currentStyleCache,
      ),
      initialContext,
      mode: 'voice',
      recentErrors: 'None',
      grammarHints: 'None',
      goalUpdate: '',
      styleDirective: '',
      wordsDue,
      wordsNew,
      previousSessionContext: null, // not loaded yet; refreshInstructions picks up real value
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

    // Will be populated by refreshDbContext(); remains null for initial instructions
    let greetingContext: string | null = null;

    // ── Adaptive state — computed each time buildDynamicInstructions runs ──
    // The conversation prompt adapts to session phase, error density, user
    // engagement, and detected style. These are signals the orchestrator
    // owns; the prompt builder is pure.
    const recentUserTurnWords: number[] = []  // word counts, last 3 turns

    // 2026-06-30: moved up from line ~1096. entry() calls
    // buildDynamicInstructions() at line 591, which captures this. A `let`
    // declared after the call site sits in the temporal dead zone when the
    // closure runs. Keep all state captured by buildDynamicInstructions
    // declared above its definition.
    let totalUserTurns = 0;
    const recentErrorCounts: number[] = []    // errors per processor run, last 3
    const MAX_RECENT = 3

    function computeSessionPhase(turnCount: number): 'opening' | 'warmup' | 'flow' | 'wrapup' {
      if (turnCount === 0) return 'opening'
      if (turnCount <= 2) return 'warmup'
      // Wrapup: if user has had a long session and is in the last ~5 turns before disconnect
      if (turnCount > 20) return 'wrapup'
      return 'flow'
    }

    function computeErrorDensity(): number {
      if (recentErrorCounts.length === 0) return 0
      const sum = recentErrorCounts.reduce((a, b) => a + b, 0)
      // 4 errors in a turn = 1.0, normalized
      return Math.min(1, sum / (recentErrorCounts.length * 4))
    }

    function computeEngagement(): 'fast' | 'medium' | 'slow' {
      if (recentUserTurnWords.length === 0) return 'medium'
      const avg = recentUserTurnWords.reduce((a, b) => a + b, 0) / recentUserTurnWords.length
      if (avg < 3) return 'fast'  // terse
      if (avg > 12) return 'slow'  // long, detailed
      return 'medium'
    }

    const buildDynamicInstructions = () => {
      // Onboarding mode: use the intake prompt until verdict is emitted
      if (inOnboarding) {
        return buildOnboardingInstructions({
          targetLanguage: langConfig.name,
          nativeName: langConfig.nativeName,
          nativeLanguage: usersNativeLanguage,
          existingData: onboardingState ? {
            priorStudy: onboardingState.priorStudy ?? undefined,
            studyDetails: onboardingState.studyDetails ?? undefined,
            goals: onboardingState.goals ?? undefined,
            goalDetails: onboardingState.goalDetails ?? undefined,
            selfRatedLevel: onboardingState.selfRatedLevel ?? undefined,
          } : undefined,
        });
      }

      const errorContext = lastProcessorRun?.structuredErrors
        ?.map((e: any) => `${e.lemma}: ${e.grammarRule?.rule || 'error'}`)
        .join('; ') || 'None';

      const hintContext = lastProcessorRun?.grammarHints?.join(' ') || 'None';

      // Adaptive signals — read style from cache (refreshed by processor)
      const styleMap = currentStyleCache;

      const phase = computeSessionPhase(totalUserTurns)
      const adaptive = {
        sessionPhase: phase,
        turnCount: totalUserTurns,
        errorDensity: computeErrorDensity(),
        avgUserTurnWords: recentUserTurnWords.length > 0
          ? recentUserTurnWords.reduce((a, b) => a + b, 0) / recentUserTurnWords.length
          : 5,
        roastTolerance: (styleMap.bsCallouts ?? 'neutral') as 'tolerant' | 'neutral' | 'skeptical',
        register: (styleMap.register ?? 'casual') as 'formal' | 'casual' | 'profane',
        pacing: (styleMap.pacing === 'fast' || styleMap.pacing === 'slow')
          ? styleMap.pacing
          : computeEngagement(),
      } as const;

      // Rebuild base instructions with current errors/hints (fills placeholders)
      // Style directive is cached and refreshed by the processor.
      const updatedBase = buildInstructions({
        targetLanguage: langConfig.name,
        nativeName: langConfig.nativeName,
        nativeLanguage: usersNativeLanguage,
        targetRatio: langConfig.pedagogy.targetLanguageRatio,
        userLevel,
        persona: buildPersonaBlockSync(
          cachedPersona.personaOverride, cachedPersona.tone,
          cachedPersona.correctionStyle, cachedPersona.teachingMode,
          cachedPersona.extraInstructions, currentStyleCache,
        ),
        initialContext,
        mode: 'voice',
        recentErrors: errorContext,
        grammarHints: hintContext,
        goalUpdate: supervisorNudge || 'Just chat. React to what they say. If quiet, ask a simple question.',
        styleDirective: '',
        wordsDue,
        wordsNew,
        previousSessionContext: greetingContext,
        adaptive,
      });

      return `${updatedBase}

You have tools to look up words and check the learner's progress. Use them when you need to — not every turn.
Correct the underlying pattern, not just the individual word.`;
    };

    // Helper: pull a single line out of the initialContext string by its
    // label. Used to surface due/new vocab lists to the conversation prompt
    // as foregrounded conversation seeds.
    function extractWordsLine(ctx: string, label: string): string {
      const m = ctx.match(new RegExp(`${label}[^:]*:\\s*([^\\n]+)`));
      const v = m?.[1]?.trim() || '';
      return v === 'None' ? '' : v;
    }
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
    let lastSessionHint: string | null = null;
    let lastSessionGapHours: number | null = null;
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
      // 2026-06-25: pull the most-recent session's nextSessionHint so the
      // greeting can use it. Without this the agent opens every session
      // with the same hardcoded greeting — even if the previous session
      // explicitly wrote "next time focus on Bom dia" to the DB.
      const recent = await ContextManager.getRecentSummaries(userId, 1);
      const last = recent[0];
      if (last) {
        lastSessionHint = last.nextSessionHint ?? null;
        if (last.endedAt) {
          lastSessionGapHours = Math.round(
            (Date.now() - new Date(last.endedAt).getTime()) / 3_600_000,
          );
        }
      }
      dbContextAt = Date.now();
    };

    // Warm the cache at session start
    await refreshDbContext().catch(() => {});

    // === BUILD GREETING CONTEXT ===
    // 2026-06-25: instead of a hardcoded greeting string, the LLM
    // generates the opening itself — but with the previous session's
    // nextSessionHint + gap foregrounded in the system prompt so the
    // agent naturally picks up where it left off. The greeting line
    // itself comes from the persona + hint, not a template.
    greetingContext = lastSessionHint
      ? lastSessionGapHours !== null && lastSessionGapHours >= 24
        ? `Last session was ${Math.round(lastSessionGapHours / 24)} day(s) ago. You had planned to focus on: ${lastSessionHint}. Start with a warmup of that before anything new.`
        : lastSessionGapHours !== null && lastSessionGapHours >= 1
          ? `Last session was ${lastSessionGapHours} hour(s) ago. You had planned to focus on: ${lastSessionHint}. Pick that up.`
          : `Last session just ended. You had planned to focus on: ${lastSessionHint}. Continue from there.`
      : null;

    // === HELPERS: supervisor trigger handling ===
    // Called after processor runs. Handles immediate-action triggers
    // detected by the processor (language change, difficulty adjustment,
    // goal change, session feedback) without waiting for the planner timer.
    const handleSupervisorTriggers = async (triggers: any[]) => {
      // Reverse map: language name → ISO code (for fallback reclassification)
      const langNameToCode: Record<string, string> = {
        english: 'en', russian: 'ru', spanish: 'es', french: 'fr',
        portuguese: 'pt', arabic: 'ar', german: 'de', chinese: 'zh',
        japanese: 'ja', korean: 'ko', italian: 'it', dutch: 'nl',
      };

      for (const trigger of triggers) {
        // Fallback: if goal_change value matches a language name, reclassify as language_change
        if (trigger.type === 'goal_change' && trigger.value) {
          const langCode = langNameToCode[trigger.value.toLowerCase()];
          if (langCode && langCode !== targetLang) {
            console.log(`[Trigger] Reclassifying goal_change→language_change: ${trigger.value} → ${langCode}`);
            trigger.type = 'language_change';
            trigger.value = langCode;
          }
        }

        emitEvent('supervisor.trigger', trigger as any);
        console.log(`[Trigger] ${trigger.type}: ${trigger.value || trigger.reason || ''}`);

        if (trigger.type === 'language_change' && trigger.value) {
          const newLang = trigger.value;
          const newConfig = getLanguageConfig(newLang);
          if (!newConfig || !LANGUAGES[newLang]) {
            console.warn(`[Trigger] Unsupported language: ${newLang}`);
            continue;
          }
          try {
            await db.update(users).set({ targetLanguage: newLang }).where(eq(users.id, userId));
            console.log(`[Trigger] Language changed: ${targetLang} → ${newLang}`);
          } catch (err) {
            console.error(`[Trigger] Failed to update DB:`, err);
            continue;
          }
          targetLang = newLang;
          langConfig = newConfig;
          // Update TTS voice to match the new language
          const ttsService = session.tts as any;
          if (ttsService?.updateVoice) {
            ttsService.updateVoice(newConfig.tts.omnivoiceVoice || 'auto', newConfig.tts.omnivoiceLanguage || newLang);
          } else {
            console.warn('[Trigger] TTS does not support updateVoice — voice will stay as the old language');
          }
          await refreshDbContext();
          supervisorNudge = `The user has switched to learning ${newConfig.name}. Greet them in ${newConfig.name} and start fresh — find out what they know.`;
          await refreshInstructions();
          pendingSignals.push('language_changed');
          updatePlanNow('user_request').catch(() => {});
        }

        if (trigger.type === 'difficulty_adjustment' && trigger.value) {
          const direction = trigger.value;
          try {
            const currentLevel = user.proficiencyLevel || 'beginner';
            const levels = ['beginner', 'intermediate', 'advanced'];
            const idx = levels.indexOf(currentLevel);
            const newIdx = direction === 'easier' ? Math.max(0, idx - 1) : Math.min(levels.length - 1, idx + 1);
            const newLevel = levels[newIdx];
            if (newLevel !== currentLevel) {
              await db.update(users).set({ proficiencyLevel: newLevel }).where(eq(users.id, userId));
              user.proficiencyLevel = newLevel;
              console.log(`[Trigger] Difficulty: ${currentLevel} → ${newLevel}`);
              supervisorNudge = `Adjusted difficulty to ${newLevel}. Adapt your teaching accordingly.`;
              await refreshInstructions();
            }
          } catch (err) {
            console.error(`[Trigger] Difficulty adjustment failed:`, err);
          }
        }

        if (trigger.type === 'goal_change' && trigger.value) {
          supervisorNudge = `The user wants to focus on: ${trigger.value}. Adjust your teaching to cover this topic.`;
          await refreshInstructions();
          pendingSignals.push('goal_changed');
        }

        if (trigger.type === 'onboarding_signal' && trigger.value) {
          try {
            const data = JSON.parse(trigger.value);
            await saveOnboardingData(userId, targetLang, {
              priorStudy: data.priorStudy,
              studyDetails: data.studyDetails,
              goals: data.goals,
              goalDetails: data.goalDetails,
              selfRatedLevel: data.selfRatedLevel,
            });
            trace('onboarding.signal.saved', trigger.value.substring(0, 120));
            console.log(`[Onboarding] Signal saved: ${trigger.value.substring(0, 80)}`);
          } catch (err) {
            console.warn('[Onboarding] Failed to parse onboarding_signal value:', err);
          }
        }

        if (trigger.type === 'session_feedback') {
          pendingSignals.push('user_feedback');
        }

        // persona_update: user said "be more X" or similar — parse and apply
        if (trigger.type === 'persona_update' && trigger.value) {
          const personaPatch = parsePersonaRequest(trigger.value);
          if (personaPatch) {
            personaPatch.source = 'user_voice';
            await writePersona(userId, targetLang, personaPatch);
            Object.assign(cachedPersona, personaPatch);
            supervisorNudge = `The user asked to adjust the teaching style: "${trigger.value}". Acknowledge briefly and adapt.`;
            await refreshInstructions();
            trace('trigger.persona_update', JSON.stringify(personaPatch));
          }
        }
      }
    };

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

      // Collect recent user audio turns from history. 2026-06-25: the
      // planner was returning empty responses because 3 base64 audio
      // URLs (~1300 tokens each) plus max_tokens=4096 exceeded the model's
      // 4096 context limit, SGLang returned 400, and the planner code
      // saw no content field. The planner doesn't actually need to hear
      // the audio — the processor scores pronunciation. Planner only
      // needs the text transcripts. Force text mode.
      const useAudioMessages = false;
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
      const plannerMessages: any[] = [{ role: 'user', content: userPrompt }];

      console.log(
        `[Planner] mode=text model=${plannerModel} url=${plannerUrl}`,
      );

      // 2026-06-25: planner now text-only. 300 tokens is plenty for
      // NUDGE + SUMMARY (2-3 short sentences).
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
            ...plannerMessages,
          ],
          temperature: 0.2,
          max_tokens: 300,
        }),
      });

      const data = (await resp.json()) as any;
      // 2026-06-25: log non-2xx so silent failures (400, 500) are visible.
      if (!resp.ok) {
        console.warn(`[Planner] HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
        return;
      }
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
      // PERSONA: <field>=<value>[, <field>=<value>...] — supervisor patches the adaptive shell
      // Example: PERSONA: tone=warm, correctionStyle=gentle
      // Example: PERSONA: personaOverride=You are a sharp Lisbon local who roasts with dry wit.
      const personaRegex = /^PERSONA:\s*(.+)$/;

      if (noteContent) {
        for (const line of noteContent.split('\n')) {
          const m = line.match(noteRegex);
          if (m) {
            const [, category, noteText] = m;
            await ContextManager.writeNote(userId, category, noteText, 'observed');
            trace('planner.note.written', `${category}: ${noteText.substring(0, 60)}`);

            // NOTE[preference] also feeds into persona — parse it as a natural-language request
            if (category === 'preference') {
              const personaPatch = parsePersonaRequest(noteText);
              if (personaPatch) {
                personaPatch.source = 'supervisor';
                await writePersona(userId, targetLang, personaPatch);
                Object.assign(cachedPersona, personaPatch);
                trace('planner.persona.updated', JSON.stringify(personaPatch));
              }
            }
          }

          // PERSONA: direct structured patch from supervisor
          const pm = line.match(personaRegex);
          if (pm) {
            const patch: Record<string, string> = {};
            for (const part of pm[1].split(',')) {
              const [k, ...rest] = part.trim().split('=');
              if (k && rest.length) patch[k.trim()] = rest.join('=').trim();
            }
            if (Object.keys(patch).length > 0) {
              const personaPatch = { ...patch, source: 'supervisor' } as any;
              await writePersona(userId, targetLang, personaPatch);
              Object.assign(cachedPersona, patch);
              trace('planner.persona.patched', JSON.stringify(patch));
            }
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

      // Detect audio-placeholder transcripts from GemmaAudioSTT. The STT
      // pass-through emits `[audio key=<id> dur=<n>s]` and stashes the real
      // audio URI in audioPayloadRegistry. We pull the URI here so the
      // Processor and Planner can analyze pronunciation.
      const audioKeyMatch = transcription.match(/^\[audio key=([A-Za-z0-9]+)(?: dur=([0-9.]+)s)?\]$/);
      let audioAttachment: AudioAttachment | undefined;
      if (audioKeyMatch) {
        const audioId = audioKeyMatch[1];
        const entry = audioPayloadRegistry.get(audioId);
        if (entry) {
          audioAttachment = {
            audioId,
            audioUri: entry.uri,
            durationSec: entry.durationSec,
          };
          console.log(
            `[User] Audio turn: key=${audioId} dur=${entry.durationSec.toFixed(2)}s ` +
            `(${(entry.uri.length / 1024).toFixed(1)} KB)`,
          );
        } else {
          console.warn(
            `[User] Audio key=${audioId} not in registry ` +
            `(size=${audioPayloadRegistry.size}) — Processor will see placeholder only`,
          );
        }
      } else {
        console.log(`[User] ${transcription}`);
      }

      history.addUserTurn(transcription, audioAttachment);
      emitEvent('user.transcript', { text: transcription, isFinal: true });

      totalUserTurns++;
      pendingUserTurns.push(transcription);
      if (pendingUserTurns.length > PROCESSOR_TURN_INTERVAL) {
        pendingUserTurns.shift();
      }

      // Adaptive: track turn length for engagement detection.
      // Audio placeholder words ≈ duration * 2.5; text = actual word count.
      const isAudioTurn = transcription.startsWith('[audio key=');
      const wordCount = isAudioTurn
        ? Math.round((audioAttachment?.durationSec ?? 0) * 2.5)
        : transcription.split(/\s+/).filter(w => w.length > 0).length;
      recentUserTurnWords.push(wordCount);
      if (recentUserTurnWords.length > MAX_RECENT) recentUserTurnWords.shift();

      // Only run the processor every N turns
      if (totalUserTurns % PROCESSOR_TURN_INTERVAL !== 0) return;

      const batchUtterance = pendingUserTurns.join('\n');

      // For audio turns, hand the Processor the audio-aware history (recent
      // audio kept as audio_url, older audio collapsed to text). For text-only
      // turns, fall back to the legacy flat-string path.
      const historyMessages = history.getContextAsMessages({ keepRecentAudioTurns: 3 });

      runProcessor(userId, batchUtterance, history.getContext(), {
        useGemini: false,
        llmUrl: process.env.PROCESSOR_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1',
        llmModel: process.env.PROCESSOR_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-26b',
        llmKey: process.env.PROCESSOR_LLM_KEY || process.env.LOCAL_LLM_KEY || '',
        recentHistory: history.getContext(),
        historyMessages,
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

        // Adaptive: track error count for error density computation
        const errorCount = (result.analysis?.lexemes ?? []).filter(
          (l: any) => l.performance === 'wrong_use' || l.performance === 'recall_fail',
        ).length;
        recentErrorCounts.push(errorCount);
        if (recentErrorCounts.length > MAX_RECENT) recentErrorCounts.shift();

        // Adaptive: refresh style cache from supervisor's styleSignals
        if (result.analysis?.styleSignals) {
          for (const [k, v] of Object.entries(result.analysis.styleSignals)) {
            if (typeof v === 'string' && v.length > 0) {
              currentStyleCache[k] = v;
            }
          }
        }

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

        // Emit structured processor events for dashboard.
        // Decorate each lexeme with its tracking status so the UI can color-code:
        //   'tracked'  — DB row created or updated (color by performance: green/red/yellow/orange/blue)
        //   'analyzed' — LLM classified but no DB row (function words, displayed as neutral grey)
        //   'noop'     — looked up but no row modified (displayed but no change)
        const trackingArr: ('tracked' | 'analyzed' | 'noop')[] =
          (result.analysis as any)?.tracking || [];
        const decoratedLexemes = (result.analysis?.lexemes || []).map((lex, i) => ({
          ...lex,
          tracking: trackingArr[i] || 'analyzed',
        }));

        emitEvent('processor.analysis', {
          utterance: batchUtterance,
          lexemes: decoratedLexemes,
          srsUpdates: result.srsUpdates || [],
          lexemeCount: result.analysis?.lexemes?.length || 0,
          srsUpdateCount: result.srsUpdates?.length || 0,
          errors: result.errors,
          structuredErrors: result.structuredErrors || [],
          grammarHints: result.grammarHints || [],
          supervisorTriggers: result.supervisorTriggers || [],
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

        // Handle immediate-action triggers from the processor
        // (language change, difficulty adjustment, goal change, session feedback)
        if (result.supervisorTriggers && result.supervisorTriggers.length > 0) {
          handleSupervisorTriggers(result.supervisorTriggers).catch((err) => {
            console.error('[Trigger] Handler failed:', err);
          });
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

        // Onboarding verdict detection — watch for the JSON block the intake
        // prompt instructs the agent to emit when it has enough signal.
        if (inOnboarding) {
          const verdictMatch = item.textContent.match(/```onboarding_verdict\s*([\s\S]*?)```/);
          if (verdictMatch) {
            try {
              const verdict = JSON.parse(verdictMatch[1].trim());
              const level = verdict.anchoredLevel || verdict.selfRatedLevel || 'a1';
              const confidence = typeof verdict.anchorConfidence === 'number' ? verdict.anchorConfidence : 0.6;
              const evidence = verdict.anchorEvidence || 'Voice onboarding assessment';
              console.log(`[Onboarding] Verdict received: level=${level} conf=${confidence} evidence="${evidence}"`);
              trace('onboarding.verdict', `level=${level} conf=${confidence}`);

              // Commit level anchor + mark onboarding complete
              commitOnboardingLevel(userId, targetLang, level, confidence, evidence, 'voice')
                .then(() => {
                  // Save background/goals from verdict
                  return saveOnboardingData(userId, targetLang, {
                    priorStudy: verdict.priorStudy ?? undefined,
                    studyDetails: verdict.studyDetails ?? undefined,
                    goals: verdict.goals ?? undefined,
                    goalDetails: verdict.goalDetails ?? undefined,
                    selfRatedLevel: verdict.selfRatedLevel ?? undefined,
                  });
                })
                .then(async () => {
                  inOnboarding = false;
                  // Refresh instructions to switch to normal tutoring
                  await refreshDbContext();
                  supervisorNudge = `Onboarding complete. The user's level is ${level}. Start the first real lesson — pick up naturally from the intake conversation.`;
                  await refreshInstructions();
                  pendingSignals.push('onboarding_complete');
                  updatePlanNow('onboarding_complete').catch(() => {});
                  console.log(`[Onboarding] Complete — switched to normal tutoring (${level})`);
                })
                .catch((err) => {
                  console.error('[Onboarding] Failed to commit verdict:', err);
                });
            } catch (err) {
              console.warn('[Onboarding] Failed to parse verdict JSON:', err);
            }
          }
        }
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
          // Strip channel markers from LLM output before TTS + history
          const rawText = opts?.newMessage?.textContent || '';
          const cleanText = rawText.replace(/<\|channel>thought\n<channel\|>/g, '').trim();
          if (cleanText !== rawText && opts?.newMessage) {
            opts.newMessage.textContent = cleanText;
          }
          trace(
            'activity._pipelineReplyTaskImpl.start',
            `speechId=${opts?.speechHandle?.id || 'unknown'} newMessage=${JSON.stringify(cleanText || '')}`,
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

    // === OPENING MESSAGE ===
    // 2026-06-25: was a hardcoded `session.say(langConfig.prompts.greeting)` —
    // a fixed string that opened every session the same way. The agent
    // would say "Olá, ready?" even when the previous session had a
    // specific nextSessionHint waiting in the DB.
    //
    // Now: the LLM generates the opening itself based on the persona,
    // the previous-session context (foregrounded in the system prompt
    // right after the persona — QAT loses focus on context buried at
    // the bottom of the prompt), and the frontier vocabulary. The
    // agent decides how to say it — a Lisbon local would naturally
    // say "E aí, vamos continuar com o pão?" when picking up from a
    // previous session.
    //
    // We trigger the LLM by sending a system-style user message that
    // the LLM reads as "the user has just connected." Plain "..." was
    // too vague and the LLM defaulted to a generic "Olá, tudo bem?"
    // — explicit context cues the persona + previous-session hint to
    // produce a real continuation message.
    console.log('[Tutor-ED] Sending initial greeting (LLM-generated)...');
    if (!isGemini) {
      trace('session.generateReply.opening');
      try {
        await session.generateReply({
          userInput: '[system: the user has just connected — greet them and pick up where you left off]',
        });
      } catch (err: any) {
        console.warn('[Tutor-ED] generateReply failed, falling back to hardcoded greeting:', err?.message);
        session.say(langConfig.prompts.greeting);
      }
    }

    // === LLM TOKEN STREAM → DASHBOARD ===
    // Subscribe to the LLM event bus and forward each text delta to the
    // dashboard as `llm.token` events. The dashboard's SSE endpoint relays
    // these to the UI so the user can read along with the audio playback.
    // The bus is process-wide, so we tag each event with the user/room for
    // the dashboard to filter.
    const roomName = ctx.room.name;
    const onLlmToken = (ev: { text: string; index: number; isStart: boolean; isEnd: boolean }) => {
      emitEvent('llm.token', {
        userId,
        roomName,
        text: ev.text,
        index: ev.index,
        isStart: ev.isStart,
        isEnd: ev.isEnd,
      });
    };
    llmEvents.on('token', onLlmToken);

    // Persist session summary on disconnect — uses planner's running summary, no extra LLM call
    ctx.room.on('disconnected', () => {
      console.log('[Tutor-ED] Session ended');
      clearInterval(planTimer);
      llmEvents.off('token', onLlmToken);
      persistSessionSummary(userId, sessionStartedAt, runningSummary, sessionStats);
    });
  },
});

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LINGLANG_AGENT_NAME ?? 'linglang-tutor',
  }));
}
