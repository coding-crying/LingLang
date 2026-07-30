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
import { llm } from '@livekit/agents';
import * as z from 'zod';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { writeFile, rename } from 'node:fs/promises';
import http from 'node:http';

import { runProcessor, transcribeAudioWithLocalLLM } from './tools/supervisor-functions.js';
import { transcribeAudioWithQwen3ASR } from './stt/qwen3-asr-client.js';
import { resolveAnalysisEndpoint } from './llm/analysis-endpoint.js';
import { resolveVoice } from './config/voices.js';
import { readPersona } from './lib/persona.js';
import { dbTools } from './tools/db-tools.js';
import { ContextManager } from './lib/context.js';
import { audioPayloadRegistry, setAudioTranscript, GemmaAudioSTT } from './stt/gemma-audio-stt.js';
import { getLanguageConfig, nativeLanguageName, LANGUAGES, resolveLanguageConfig, resolveSessionLanguage } from './config/languages.js';
import { buildInstructions, buildCoachNote, buildOnboardingInstructions, PLATFORM_KNOWLEDGE } from './config/prompts/base.js';
import type { PromptContext } from './config/prompts/base.js';
import { computeTargetShare, buildMixLine, measureTargetShare, targetShareForLevel, MAX_THROTTLE_NOTCHES, findForeignScriptChar } from './lib/language-mix.js';
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from './config/prompts/supervisor.js';
import { readLearnerView, invalidateLearnerView, formatWordList } from './lib/learner-view.js';
import { measureReplyOov } from './lib/lexical-lint.js';
import { buildFrontierInfo, type SessionMode } from './lib/frontier.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { emitEvent, setSessionId, getSessionId } from './lib/trace.js';
import { recordUtterance, recordErrorObservations } from './lib/memory.js';
import { recomputeActiveChunkCoverage, skipActiveChunk } from './lib/curriculum.js';
import { llmEvents } from './lib/llm-events.js';
import { getOnboardingState, saveOnboardingData, completeOnboarding, buildOnboardingContext, getOnboardingLadder } from './lib/onboarding.js';

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

  /**
   * False for a text-only local backend (Qwen3.5-9B, no audio modality) —
   * getLatestTurnMessages() must never attach a real audio_url content
   * block in that case, or the Processor's grading request to the same
   * vLLM server 400s. The transcript is already inline in `content`
   * (GemmaAudioSTT appends it after the `[audio key=...]` placeholder), so
   * falling through to the plain-text branch loses nothing but tone/
   * pronunciation nuance from the raw clip.
   */
  constructor(private audioCapable: boolean = true) {}

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
   * Replace an audio user turn's placeholder text with the words the
   * Processor actually extracted from it. Without this, the text-only
   * planner sees "User: [audio key=... dur=1.60s]" — it was strategizing
   * off half a conversation (tutor lines only, confirmed in a live planner
   * prompt 2026-07-02). Matched by audio key because the processor
   * completes asynchronously — by then the user may already be on a
   * later turn.
   */
  annotateUserTurnByAudioKey(audioId: string, heardText: string) {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i]!;
      if (t.role === 'user' && t.audio?.audioId === audioId) {
        t.content = heardText;
        return;
      }
    }
  }

  /**
   * Flat-text version of the last exchange only (tutor's previous line +
   * the current user turn). See getLatestTurnMessages for why this is
   * kept minimal — this is the text-fallback twin of that method, used
   * when there's no audio for the current turn.
   */
  getLastExchangeText(): string {
    const n = this.turns.length;
    if (n === 0) return '';
    const last = this.turns[n - 1]!;
    const prev = n >= 2 ? this.turns[n - 2] : null;
    const lines: string[] = [];
    if (prev && prev.role === 'assistant') lines.push(`Tutor: ${prev.content}`);
    lines.push(`${last.role === 'user' ? 'User' : 'Tutor'}: ${last.content}`);
    return lines.join('\n');
  }

  /**
   * Plain text of the tutor's last 1-2 assistant turns, tutor-only — for the
   * deterministic echo gate (learner-field spec §3.3), NOT for LLM context.
   * Kept separate from getLastExchangeText/getLatestTurnMessages on purpose:
   * this text is matched in code (lemma-in-recent-output check), never
   * placed in front of the grading LLM — see getLatestTurnMessages's note
   * on why assistant text in the prompt caused the model to grade its own
   * sentences as user speech.
   */
  getRecentTutorText(): string {
    return this.turns
      .filter(t => t.role === 'assistant')
      .slice(-2)
      .map(t => t.content)
      .join(' ');
  }

  /**
   * Minimal Processor context: the CURRENT user turn ONLY, as audio if
   * present. No prior turns, not even the tutor's immediately-preceding
   * line — see the note inside for why that was tried and rolled back.
   *
   * 2026-07-02: this originally sent a 5-turn window with up to 3 recent
   * audio clips plus interleaved assistant text. Confirmed live: with that
   * much context in view, the Processor tagged words from the assistant's
   * OWN prior turn as if the user had said them — a real, complex sentence
   * graded "correct_use" that the user never spoke, which directly
   * corrupted level inference. A wider window doesn't help this model
   * reason better about "whose turn is this"; it just gives it more
   * surface area to get confused on. One user turn in, one word-tagging
   * job out.
   */
  getLatestTurnMessages(): any[] {
    const out: any[] = [];
    const n = this.turns.length;
    if (n === 0) return out;

    const last = this.turns[n - 1]!;

    // 2026-07-02, round two: including the tutor's previous line (even as
    // its own message, even with an explicit "don't tag this" instruction)
    // was NOT enough — confirmed live, repeatedly, the model kept copying
    // the assistant's own sentence into the lexeme output as if the user
    // had said it (e.g. a 22-word Russian reply graded as "correct_use"
    // the user never spoke). A prompt instruction is not a hard constraint
    // for a 12B model; the only reliable fix is to not put the assistant's
    // text in front of it at all. Losing "scaffolded" detection accuracy
    // is a worthwhile trade for not writing hallucinated FSRS grades.
    if (last.role === 'user') {
      if (last.audio && this.audioCapable) {
        // 2026-07-02: a 1.57s clip produced a fabricated 9-word English
        // sentence — physically impossible (speech tops out ~2-3
        // words/sec, so ~4 words max). The system prompt's "return empty
        // if unclear" is a soft judgment call the model doesn't reliably
        // follow; a computed, per-turn word ceiling is a hard number it
        // can actually check itself against.
        const maxWords = Math.max(2, Math.round(last.audio.durationSec * 3));
        out.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[User spoke for ${last.audio.durationSec.toFixed(2)}s — at most ~${maxWords} words could physically fit in that time. Grade only the words you clearly hear. Do not invent content beyond what's physically possible in this clip — if you can't make out real words, return an empty lexemes array.]`,
            },
            { type: 'audio_url', audio_url: { url: last.audio.audioUri } },
          ],
        });
      } else {
        out.push({ role: 'user', content: last.content });
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
  // 2026-07-12: this runs from `prewarm`, which fires once per worker
  // process before any job (and therefore any per-session mode) exists —
  // a single worker process serves whichever mode the NEXT dispatch asks
  // for via job metadata (see resolveServiceMode), so this can't know in
  // advance which one that'll be. Check both local-service groups
  // unconditionally; skipped health checks just don't push a `checks`
  // entry, so this stays a no-op cost for whichever half turns out
  // unused this session.
  const ttsMode = process.env.TTS_MODE || 'local';
  const checks: Array<{ name: string; url: string }> = [];

  if (ttsMode === 'local') {
    checks.push({ name: 'TTS', url: 'http://localhost:8882/v1/audio/speech' });
  }

  checks.push({ name: 'LLM', url: 'http://localhost:8093/v1/models' });

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

async function persistSessionSummaryAsync(
  userId: string,
  targetLang: string,
  startedAt: Date,
  runningSummary: string,
  stats: { totalSrsUpdates: number; allErrors: Array<{ lemma: string; rule?: string }>; allHints: string[] },
): Promise<void> {
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

  await ContextManager.writeSessionSummary(userId, {
    languageCode: targetLang,
    startedAt,
    endedAt,
    durationMinutes,
    topicsCovered: null, // planner's summary already captures this
    wordsWorked: null,
    errorsPattern,
    summary,
    nextSessionHint: nextHint,
  });
  console.log(`[Tutor-ED] Session summary written (${durationMinutes}min)`);
}

// ============================================================================

// 2026-07-12: mode is now a per-session choice made at connect time (see
// dashboard/server.ts's /api/token — the demo site offers "local" and
// "cloud" as two distinct connect options), carried through LiveKit's
// dispatch metadata rather than a single deployment-wide env var. A worker
// process is prewarmed once and then serves whichever mode each dispatch
// asks for, so the actual mode can only be resolved per-job, inside
// `entry`, once `ctx.job.metadata` is available — never in `prewarm`.
// Falls back to SERVICE_MODE (.env.local) for dispatches that don't carry
// mode metadata at all (manual CLI/dev runs, `pnpm dev:tutor-ed`).
// 2026-07-16: dashboard's "Local" button was temporarily pointed at 'audex'
// (Audex-30B-A3B cascaded s2s, ~/audex-quant/WIRING.md) for a live A/B
// comparison against 'local-gemma-audio'. Reverted 2026-07-21 — a live
// session produced 0-token LLM responses and empty STT transcripts despite
// Audex's /api/status reporting healthy (see project-linglang-audex-ab
// memory: known crash-prone shared vLLM engine, TTS 2.7-3.2x slower than
// real-time).
// 2026-07-21, same day: tried swapping again to 'local-qwen'
// (Qwen3.5-9B-FP8-dynamic) for more KV cache headroom — reverted same day,
// the FP8-dynamic quant produced degenerate garbage output on this Ampere
// (sm_86) GPU even at temperature 0 (see gemma4-qat-vllm's 2026-07-21
// comment: likely needs native FP8 tensor cores this card doesn't have).
// The local-qwen ServiceMode and its supporting code (GemmaAudioLLM's
// audioCapable option, ConversationHistory's audioCapable flag) are left
// in place for a retry with a weight-only quant (AWQ/W4A16) that wouldn't
// hit the same FP8-on-Ampere problem — only this mapping was reverted.
// There will only ever be one "local" option in the UI, so this is a
// straight swap, not an added mode.
function resolveServiceMode(ctx: JobContext): 'local' | 'cloud' | 'local-gemma-audio' | 'local-qwen' | 'gemini' | 'audex' {
  try {
    const raw = ctx.job.metadata;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.mode === 'local') return 'local-gemma-audio';
      if (parsed?.mode === 'cloud') return 'gemini';
    }
  } catch {
    // Malformed metadata — fall through to the env default below.
  }
  return (process.env.SERVICE_MODE as 'local' | 'cloud' | 'local-gemma-audio' | 'local-qwen' | 'gemini' | 'audex') || 'local';
}

// 2026-07-17: /api/token resolves the caller's Google API plan (BYO key vs
// shared-key budget, see lib/google-budget.ts) at dispatch time and hands
// the result down via job metadata — the agent worker has no direct HTTP
// session to ask the dashboard, so this is the only channel. `googleApiKey`
// is only present when the user has their own key; `billGoogleUsage` marks
// a gemini-mode session as needing to record its estimated cost against
// the shared key on disconnect (see the gemini usage-accrual block below).
function resolveGoogleBilling(ctx: JobContext): { googleApiKey?: string; billGoogleUsage: boolean } {
  try {
    const raw = ctx.job.metadata;
    if (raw) {
      const parsed = JSON.parse(raw);
      return { googleApiKey: parsed?.googleApiKey || undefined, billGoogleUsage: !!parsed?.billGoogleUsage };
    }
  } catch {
    // Malformed metadata — no per-user key/billing info available.
  }
  return { billGoogleUsage: false };
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Ensure local STT/TTS/LLM are running before we need them. Mode is
    // per-job (see resolveServiceMode) and unknown at this point, so this
    // always checks both local-service groups — see ensureLocalServices's
    // own comment.
    await ensureLocalServices();

    // VAD is cheap to prewarm and harmless even for a session that ends up
    // in gemini mode (RealtimeModel just won't use it) — unconditional
    // beats guessing the wrong mode here and needing a slow first-use load.
    console.log('[Tutor-ED] Prewarming VAD...');
    proc.userData.vad = await silero.VAD.load();
    console.log('[Tutor-ED] VAD prewarmed');
  },

  entry: async (ctx: JobContext) => {
    console.log('[Tutor-ED] Connecting to room...');
    await ctx.connect();
    console.log('[Tutor-ED] Connected to room');

    const resolvedMode = resolveServiceMode(ctx);
    // 2026-07-17: job metadata can carry a user's real Google API key (see
    // resolveGoogleBilling below) — never log it verbatim. Redact before
    // printing rather than dropping the log line, since the rest of the
    // metadata (mode, userId) is still useful for debugging dispatch issues.
    let redactedMetadata = ctx.job.metadata || '(none)';
    try {
      if (ctx.job.metadata) {
        const parsed = JSON.parse(ctx.job.metadata);
        if (parsed.googleApiKey) parsed.googleApiKey = '[redacted]';
        redactedMetadata = JSON.stringify(parsed);
      }
    } catch {
      // Malformed metadata — fall through and log the raw (non-JSON,
      // therefore not a valid carrier for a key) string as-is.
    }
    console.log(`[Tutor-ED] Resolved service mode: ${resolvedMode} (job metadata: ${redactedMetadata})`);
    const { googleApiKey, billGoogleUsage } = resolveGoogleBilling(ctx);
    const geminiSessionStartedAt = resolvedMode === 'gemini' ? Date.now() : null;

    const participant = await ctx.waitForParticipant();
    const userId = participant.identity || 'test-user';
    console.log(`[Tutor-ED] Starting session for user: ${userId}`);
    setSessionId(`room-${ctx.room.name}-${userId}`);

    // Same signal the wrap-up/hard-stop timers below key off: this worker
    // is running the anonymous landing-page demo, not a real account.
    const isDemoSession = !!process.env.DEMO_SESSION_TIME_LIMIT_MS;

    // A demo visitor arrives having chosen nothing — the landing page's
    // only control is "Start talking". The tutor asks what they want to
    // learn as its opening line and commits the answer with the
    // set_target_language tool, so until that fires the session's language
    // is a placeholder, not a real choice.
    let languageUndecided = isDemoSession;
    let demoIntentCaptured = false;

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
    // Never getLanguageConfig() here: it throws for anything outside the
    // curated table, and throwing in the entry function drops the job before
    // the participant is ever spoken to. See resolveSessionLanguage().
    const resolvedLang = resolveSessionLanguage(targetLang, resolvedMode);
    let langConfig = resolvedLang.config;
    if (resolvedLang.fellBackFrom) {
      console.error(
        `[Tutor-ED] Cannot run "${resolvedLang.fellBackFrom}" in ${resolvedMode} mode — ` +
        `starting in ${langConfig.name} instead. The learner should be told and asked to pick again.`,
      );
      targetLang = langConfig.code;
    }
    console.log(`[Tutor-ED] Language: ${langConfig.name}`);
    emitEvent('session.start', { userId, language: langConfig.name, mode: resolvedMode });

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
    // let, not const: re-inferred once onboarding completes (see
    // submit_onboarding_verdict below) — without this, a session that
    // starts in onboarding would keep using the pre-onboarding cold-start
    // value for reply-length/mix-share prompt lines for its entire
    // duration, since buildDynamicInstructions closes over this variable
    // rather than re-reading it. Pre-existing staleness (the old
    // onboarding-anchor write had the same gap); fixed now because the new
    // probe-evidence flow (spec §6.5) is worthless if it doesn't take
    // effect until the NEXT session.
    let userLevel = levelEstimate.level;
    console.log(`[Tutor-ED] Level: ${userLevel} (${levelEstimate.source}, score=${levelEstimate.score.toFixed(1)}, conf=${levelEstimate.confidence.toFixed(2)})`);

    // === ONBOARDING STATE ===
    // Check if this user has completed onboarding for this language.
    // If not, the agent runs the onboarding conversation first, then
    // switches to normal tutoring once the verdict JSON is emitted.
    const onboardingState = await getOnboardingState(userId, targetLang);
    let inOnboarding = !onboardingState?.isComplete;
    // Fetched once per session (not per buildDynamicInstructions call —
    // that runs on every refresh during the 5-8 turn intake) — real words
    // from frequency_rank data to ground the staircase, spec §9. Only
    // fetch when actually needed.
    const onboardingLadder = inOnboarding ? await getOnboardingLadder(targetLang) : [];
    if (inOnboarding) {
      console.log(`[Tutor-ED] Onboarding incomplete for ${userId}/${targetLang} — running intake flow (ladder: ${onboardingLadder.map((w) => w.lemma).join(', ') || 'none — falling back to unanchored'})`);
      // While the demo's language is still undecided, targetLang is only a
      // placeholder — writing the intake row now files it under a language
      // the visitor never asked for (every demo pt session had its intake
      // stored under 'ru'). applyTargetLanguage() creates it for real once
      // they say what they want.
      if (!languageUndecided) await saveOnboardingData(userId, targetLang, {});
    } else {
      console.log(`[Tutor-ED] Onboarding complete for ${userId}/${targetLang}`);
    }

    // The persona/style profile is read fresh through readLearnerView on
    // every prompt build (§1/§4 of the redesign) — no session-local persona
    // or style cache. writePersona() call sites invalidate the cached view
    // so a patch takes effect on the very next build, not after a TTL.
    const { buildPersonaBlockSync, writePersona, parsePersonaRequest } = await import('./lib/persona.js');

    // === DYNAMIC INSTRUCTIONS (Supervisor-driven teaching plan) ===
    let supervisorNudge = '';
    let nudgeIssuedAtTurn: number | null = null;
    // Realtime sessions deliver the volatile tail as injected context
    // rather than a system-prompt rewrite; these hold the last context
    // built and the last note actually sent, so identical guidance isn't
    // re-injected turn after turn.
    let lastPromptContext: PromptContext | null = null;
    let lastCoachNote: string | null = null;
    let runningSummary = '';
    let lastPlanAt = 0;
    const sessionStartedAt = new Date();

    // Cumulative session data for summary on disconnect
    const sessionStats = {
      totalSrsUpdates: 0,
      allErrors: [] as Array<{ lemma: string; rule?: string }>,
      allHints: [] as string[],
    };

    // 2026-07-16: self-watchdog against a real, repeatedly-observed hang
    // class — the job process gets stuck mid-turn (state stays 'thinking'
    // or 'speaking' forever) and pegs a CPU core indefinitely. Confirmed
    // live across BOTH local (OmniVoice) and cloud (Gemini Realtime) modes,
    // so it's not a backend-specific bug — `top -H` on stuck PIDs showed
    // the hot threads were native @livekit/rtc-node (Rust/WebRTC) worker
    // threads, not our own JS, so this isn't fixable by patching our own
    // pipeline code. Worse: the framework's OWN ping/pong health-check
    // (supervised_proc.ts) is supposed to catch an unresponsive job and
    // kill it, but in 2 of 4 real incidents today it never fired at all —
    // the hang can apparently happen in a window where that monitoring
    // isn't active. This is a defensive backstop: if the agent state
    // enters 'thinking'/'speaking' and doesn't return to 'listening'/'idle'
    // within AGENT_STUCK_TIMEOUT_MS, self-terminate so a fresh job process
    // takes over on the next connect, instead of silently burning a CPU
    // core for hours (observed: up to 22h before manual intervention).
    let agentBusySince: number | null = null;
    const AGENT_STUCK_TIMEOUT_MS = Number(process.env.AGENT_STUCK_TIMEOUT_MS || 40_000);
    const stuckWatchdog = setInterval(() => {
      if (agentBusySince !== null && Date.now() - agentBusySince > AGENT_STUCK_TIMEOUT_MS) {
        console.error(
          `[Tutor-ED] CRITICAL: agent state stuck for >${AGENT_STUCK_TIMEOUT_MS}ms — ` +
          `self-terminating job process to force recovery (see 2026-07-16 note above)`,
        );
        try { trace('watchdog.stuck_exit', `busyMs=${Date.now() - agentBusySince}`); } catch { /* best effort */ }
        process.exit(1);
      }
    }, 10_000);

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
    // turnSeq of the exchange currently streaming/replying, captured ONCE at
    // the start of that exchange's token stream (see onLlmToken's isStart
    // branch below) and reused by every later `llm.token` delta AND by the
    // `agent.reply` emit for the same exchange. Do NOT read `totalUserTurns`
    // live from either of those emit sites — a new/interrupting user turn
    // can land (and bump totalUserTurns) before this exchange's stream
    // reaches isEnd, and a live read would mis-stamp the tail of an
    // in-flight exchange with the newer turn's id, reproducing the
    // duplicate-bubble bug fixed in Task 4a (see review notes on
    // tutor-event-driven.ts:1611/:1807).
    let currentExchangeTurnSeq = 0;
    const recentErrorCounts: number[] = []    // errors per processor run, last 3
    const MAX_RECENT = 3

    // Nudge lifecycle (§5): a nudge older than this many turns is dropped
    // from the prompt so a stalled/failed planner cycle can't leave a stale
    // angle pinned indefinitely.
    const NUDGE_TTL_TURNS = 8;
    const setNudge = (text: string) => {
      supervisorNudge = text;
      nudgeIssuedAtTurn = totalUserTurns;
    };

    // Session mode (design doc §10): explicit user intent outranks the
    // planner's inference, same precedent as the curriculum_advance
    // trigger. 'mixed' is today's unchanged behavior. Session-local only —
    // resets each session by design (a review request is "for now," not a
    // standing preference; use persona/extraInstructions for that).
    let sessionMode: SessionMode = 'mixed';

    // ── Comprehensible-input controller state (lib/language-mix.ts) ──
    // Measured target-language share of the tutor's own last reply
    // (script-based, null when unmeasurable), plus session-local distress
    // notches: difficulty_adjustment=easier drops the target share a
    // notch, and a notch decays after enough clean processor runs. This
    // is what makes "I'm drowning" persist past one turn instead of the
    // model apologizing in English once and reverting.
    let lastTutorMixShare: number | null = null;
    let mixThrottleNotches = 0;
    let cleanRunsSinceThrottle = 0;
    const THROTTLE_DECAY_RUNS = 8;

    // Session phase (§3): signal-driven, not turn-count-driven. wrapup is
    // sticky once set — reached only via an explicit "wants_to_end" signal
    // or the participant leaving, never by turn count alone (a long
    // session used to lock into goodbye mode forever at turn 21).
    let forcedWrapup = false;

    function computeSessionPhase(turnCount: number): 'opening' | 'warmup' | 'flow' | 'wrapup' {
      if (forcedWrapup) return 'wrapup'
      if (turnCount === 0) return 'opening'
      if (turnCount <= 2) return 'warmup'
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

    // Turn-length trend and error trend — shared with the planner's
    // engagement block (§5) so its mandate has real inputs instead of
    // "care about enjoyment equally" with nothing to act on.
    function computeTurnLengthTrend(): 'growing' | 'shrinking' | 'steady' {
      if (recentUserTurnWords.length < MAX_RECENT) return 'steady'
      const first = recentUserTurnWords[0]!
      const last = recentUserTurnWords[recentUserTurnWords.length - 1]!
      if (last > first * 1.3) return 'growing'
      if (last < first * 0.7) return 'shrinking'
      return 'steady'
    }

    function computeErrorTrend(): 'rising' | 'falling' | 'steady' {
      if (recentErrorCounts.length < MAX_RECENT) return 'steady'
      const first = recentErrorCounts[0]!
      const last = recentErrorCounts[recentErrorCounts.length - 1]!
      if (last > first) return 'rising'
      if (last < first) return 'falling'
      return 'steady'
    }

    const buildDynamicInstructions = async (): Promise<string> => {
      // Onboarding mode: use the intake prompt until the verdict tool is called
      if (inOnboarding) {
        return buildOnboardingInstructions({
          targetLanguage: langConfig.name,
          nativeName: langConfig.nativeName,
          nativeLanguage: usersNativeLanguage,
          demo: isDemoSession,
          languageUndecided,
          // Hand-written hook, if one is configured — see DEMO_OPENING_LINE.
          openingLine: process.env.DEMO_OPENING_LINE?.trim() || undefined,
          existingData: onboardingState ? {
            priorStudy: onboardingState.priorStudy ?? undefined,
            studyDetails: onboardingState.studyDetails ?? undefined,
            goals: onboardingState.goals ?? undefined,
            goalDetails: onboardingState.goalDetails ?? undefined,
            selfRatedLevel: onboardingState.selfRatedLevel ?? undefined,
          } : undefined,
          ladderWords: onboardingLadder,
        });
      }

      const errorContext = lastProcessorRun?.structuredErrors
        ?.map((e: any) => `${e.lemma}: ${e.grammarRule?.rule || 'error'}`)
        .join('; ') || 'None';

      const hintContext = lastProcessorRun?.grammarHints?.join(' ') || 'None';

      const phase = computeSessionPhase(totalUserTurns)
      const adaptive = {
        sessionPhase: phase,
        turnCount: totalUserTurns,
        errorDensity: computeErrorDensity(),
        pacing: computeEngagement(),
      } as const;

      // The one read path (§1): due/new words, frontier inputs, and the
      // persona row, all live off the DB with a short TTL — no session
      // cache to keep in sync by hand.
      const view = await readLearnerView(userId, targetLang);
      const frontier = buildFrontierInfo(view.dueWords, view.newWords, view.dueBacklog, view.recentSuccess, sessionMode);

      const nudgeAgeTurns = nudgeIssuedAtTurn !== null ? totalUserTurns - nudgeIssuedAtTurn : null;
      const activeNudge = nudgeAgeTurns !== null && nudgeAgeTurns > NUDGE_TTL_TURNS ? '' : supervisorNudge;

      const mixTargetShare = computeTargetShare({
        userLevel,
        recentSuccess: view.recentSuccess,
        throttleNotches: mixThrottleNotches,
      });
      const mixLine = buildMixLine({
        targetShare: mixTargetShare,
        lastMeasuredShare: lastTutorMixShare,
        targetLanguage: langConfig.name,
        nativeLanguage: usersNativeLanguage,
      });

      const promptCtx = {
        targetLanguage: langConfig.name,
        nativeLanguage: usersNativeLanguage,
        userLevel,
        persona: buildPersonaBlockSync(
          view.persona.personaOverride, view.persona.tone,
          view.persona.correctionStyle, view.persona.teachingMode,
          view.persona.extraInstructions,
        ),
        frontier,
        recentErrors: errorContext,
        grammarHints: hintContext,
        demandWords: formatWordList(view.demandWords),
        // Re-enabled 2026-07-07 after redesigning the card format. The
        // original multi-field block (Topic:/Phrases:/Vocab:/Grammar:)
        // reproducibly broke real audio attention regardless of wording
        // around it (6/6 failures). Root cause wasn't token budget — a
        // length-matched non-topical filler survived at the same size —
        // it was the block reading as a directive ("the topic is X") vs
        // an optional aside. `card` is now a single short conditional
        // instruction ("If it fits naturally, ... they're studying ...",
        // capped ~60 tokens at ingestion — see ingest.ts) and verified 4/4
        // against real audio through this exact code path with a real
        // model-generated card, not a hand-crafted one. If the card format
        // or wrapper text ever changes, re-verify with real audio first —
        // this model's audio attention is measurably fragile to phrasing.
        lessonCard: view.activeChunk?.card ?? undefined,
        goalUpdate: activeNudge || 'Just chat. React to what they say. If quiet, ask a simple question.',
        previousSessionContext: greetingContext,
        mixLine,
        adaptive,
        specialInstructions: langConfig.pedagogy.specialInstructions,
        realtime: isGemini,
      };
      // Stashed so the realtime path can rebuild just the volatile tail as
      // an injected [COACH] note — under Gemini the system prompt this
      // returns is only ever read once, at connect.
      lastPromptContext = promptCtx;
      const instructions = buildInstructions(promptCtx);

      // Demo visitors are evaluating the product while they talk, so the
      // tutor needs to be able to field "what is this / what's it cost"
      // without guessing. Real accounts already know what they signed up
      // for — no reason to spend their context window on it.
      return isDemoSession ? `${instructions}\n\n${PLATFORM_KNOWLEDGE}` : instructions;
    };

    // === ONBOARDING VERDICT TOOL (§10, revised 2026-07-10 per learner-field
    // spec §6.5) ===
    // No longer commits a level anchor — the model doesn't get to declare a
    // CEFR verdict from vibes on a 5-8 turn chat. Its only job now is to
    // end the intake conversation once background/goals/a language sample
    // have been captured; graded evidence from the staircase elicitation
    // (buildOnboardingInstructions) already accumulated via the normal
    // processor pipeline (provenance='probe') while the conversation ran —
    // level-inference.ts reads it directly on the very next inferLevel()
    // call, no separate commit step needed.
    const submitOnboardingVerdictTool = llm.tool({
      name: 'submit_onboarding_verdict',
      description: `Call this once you have background, goals, and have had them try producing some ${langConfig.name} from the onboarding conversation. Ends the intake and switches the session to normal tutoring. Do not call mid-conversation — only when you are ready to end the intake.`,
      parameters: z.object({
        priorStudy: z.enum(['none', 'self_taught', 'class', 'immersion', 'heritage']),
        studyDetails: z.string().optional().describe('Free text, e.g. "Duolingo 6 months"'),
        goals: z.array(z.enum(['travel', 'work', 'heritage', 'media', 'academic', 'other'])),
        goalDetails: z.string().optional(),
        selfRatedLevel: z.enum(['pre_a1', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2']).describe('Their OWN self-report, for context only — this does not set their level. Their level comes from how they actually did on the words you asked them to try.'),
      }),
      execute: async (args: any) => {
        console.log(`[Onboarding] Verdict tool called: self-rated=${args.selfRatedLevel}`);
        trace('onboarding.verdict', `selfRated=${args.selfRatedLevel}`);

        await saveOnboardingData(userId, targetLang, {
          priorStudy: args.priorStudy,
          studyDetails: args.studyDetails,
          goals: args.goals,
          goalDetails: args.goalDetails,
          selfRatedLevel: args.selfRatedLevel,
        });
        await completeOnboarding(userId, targetLang, 'voice');

        inOnboarding = false;
        await refreshDbContext();
        // Re-infer NOW from whatever probe/conversation evidence just
        // accumulated during intake — see the `let userLevel` note above
        // for why this can't wait for the next session.
        const freshEstimate = await inferLevel(userId, targetLang);
        userLevel = freshEstimate.level;
        console.log(`[Onboarding] Level re-inferred post-intake: ${userLevel} (${freshEstimate.source}, score=${freshEstimate.score.toFixed(1)})`);
        setNudge(`Onboarding complete. The user's level is ${userLevel}. Start the first real lesson — pick up naturally from the intake conversation.`);
        await refreshInstructions();
        pendingSignals.push('onboarding_complete');
        updatePlanNow('onboarding_complete').catch(() => {});
        console.log(`[Onboarding] Complete — switched to normal tutoring`);

        return { ok: true };
      },
    });
    const onboardingTools = [submitOnboardingVerdictTool];

    // Demo only. The processor's language_change trigger can also switch
    // languages, but it runs a turn behind and its own comments record it
    // fumbling the value field — fine as a mid-conversation safety net,
    // far too slow and too vague for the opening seconds of a 3-minute
    // demo, where the visitor's answer to "what do you want to learn"
    // has to take effect on the very next breath.
    const setTargetLanguageTool = llm.tool({
      name: 'set_target_language',
      description: "Set the language you are teaching. Call this the instant the learner names what they want to learn, before you reply to them. Pass the ISO 639-1 code — most widely-spoken languages work (es, fr, pt, ru, ar, de, it, ja, ko, zh, hi, uk, pl, tr, vi, th, sv, el, he and more). If the tool comes back unsupported, tell the learner that one isn't available yet and ask what else they'd like; never teach a language the tool rejected.",
      parameters: z.object({
        language: z.string().describe('ISO 639-1 code of the language the learner wants to learn, e.g. "es", "ja", "de"'),
      }),
      execute: async (args: any) => {
        const code = String(args.language || '').toLowerCase().trim();
        const cfg = resolveLanguageConfig(code);
        if (!cfg) {
          trace('lang.tool', `${code} unsupported`);
          return { ok: false, unsupported: true, note: `${code} isn't available yet — ask them to pick another language.` };
        }
        const ok = await applyTargetLanguage(code, 'tool');
        trace('lang.tool', `${code} ok=${ok}`);
        return ok
          ? { ok: true, language: cfg.name }
          : { ok: false, note: 'Already teaching that language — just carry on.' };
      },
    });
    const demoTools = isDemoSession ? [setTargetLanguageTool] : [];

    // === CREATE AGENT ===
    // 2026-07-09: @livekit/agents 1.5.0 broke the old `Record<string,
    // FunctionTool>` map shape for Agent({ tools }) — it now requires a
    // flat array, and llm.tool() requires an explicit `name` field (both
    // fixed at each tool's definition site). This was found while
    // investigating gemini mode's total audio silence — the old map shape
    // silently mismatching the new plugin's expectations is a real
    // candidate for that bug, on top of the confirmed realtime_input
    // media_chunks deprecation fixed by the upgrade itself.
    const agent = new voice.Agent({
      instructions: await buildDynamicInstructions(),
      tools: [...dbTools, ...onboardingTools, ...demoTools],
    });

    // === CREATE SERVICES (LOCAL, CLOUD, OR GEMINI) ===
    const { ServiceFactory } = await import('./services/factory.js');
    // Voice is connect-time provider config, so it has to be resolved
    // before the factory is built — the per-turn learner view comes too
    // late to influence it. Anonymous demo visitors have no saved setting.
    const sessionPersona = isDemoSession ? null : await readPersona(userId, targetLang);

    const serviceFactory = new ServiceFactory({
      mode: resolvedMode,
      targetLanguage: targetLang,
      // A demo connects before the visitor has chosen anything, so
      // targetLang is still the placeholder default — pinning speech
      // recognition to it made the model hear plain English as broken
      // Russian. What they're about to speak is their own language.
      speechLanguage: languageUndecided ? (user.nativeLanguage || 'en') : undefined,
      // Same reason as speechLanguage: fixed at connect, so it can't be
      // inherited from a placeholder. One default across demo and app so
      // signing up doesn't change who the user is talking to; a signed-in
      // user's saved setting wins. See config/voices.ts.
      voice: resolveVoice(sessionPersona?.voice),
      userId,
      googleApiKey,
    });

    const mode = serviceFactory.getMode();
    const isGemini = mode === 'gemini';

    const sttService = isGemini ? undefined : serviceFactory.createSTT();

    // Wire real transcription into the STT node (see GemmaAudioSTT's
    // configureTranscription doc for the three live incidents that led
    // here). Closure reads langConfig/usersNativeLanguage live, so a
    // mid-session language change is picked up automatically.
    if (sttService instanceof GemmaAudioSTT) {
      sttService.configureTranscription(async (audioUri, durationSec) => {
        // 2026-07-12: Qwen3-ASR is the primary transcription pass now — a
        // dedicated ASR model can't drop into Gemma's assistant-refusal
        // failure mode (see qwen3-asr-client.ts doc comment, confirmed
        // live: 0/3 refusals vs Gemma's 3/3 on the same hard clips). Falls
        // back to Gemma's own transcription if the Qwen3-ASR server is
        // unreachable (not always running) so this degrades gracefully
        // instead of losing transcription entirely.
        let transcript = await transcribeAudioWithQwen3ASR(audioUri, langConfig.code);
        // 2026-07-21: the Gemma-audio fallback below sends a real audio_url
        // block to PROCESSOR_LLM_URL/LOCAL_LLM_URL — for local-qwen mode
        // that's the same text-only vLLM server this session's own LLM
        // uses, which 400s on audio content. Skip straight to "no
        // transcript" (placeholder-only, same as any other STT failure)
        // instead of making a doomed request.
        if (transcript === null && mode !== 'local-qwen') {
          const maxWords = Math.max(2, Math.round(durationSec * 3));
          transcript = await transcribeAudioWithLocalLLM(
            [{
              role: 'user',
              content: [
                // Same physical word ceiling the processor's audio messages
                // carry — the stated bound is what keeps the 12B from
                // inventing words that couldn't fit in the clip.
                { type: 'text', text: `[User spoke for ${durationSec.toFixed(2)}s — at most ~${maxWords} words could physically fit in that time. Transcribe only the words you clearly hear; if you can't make out real words, output nothing.]` },
                { type: 'audio_url', audio_url: { url: audioUri } },
              ],
            }],
            process.env.PROCESSOR_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8093/v1',
            process.env.PROCESSOR_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-12b-it-qat',
            process.env.PROCESSOR_LLM_KEY || process.env.LOCAL_LLM_KEY || '',
            langConfig.name,
            usersNativeLanguage,
          );
        }
        // Deterministic script guard: a transcript containing letters from
        // a script that is neither the target's nor Latin is a
        // hallucination by definition (live: Mandarin audio → Thai script).
        // Reject → placeholder-only fallback, strictly safer than anchoring
        // the conversation on hallucinated text.
        if (transcript) {
          const foreign = findForeignScriptChar(transcript, langConfig.code);
          if (foreign) {
            console.warn(`[STT] Rejecting transcript with foreign-script char "${foreign}" (target=${langConfig.code}): "${transcript.slice(0, 60)}"`);
            trace('stt.transcript.foreign_script_rejected', transcript.slice(0, 80));
            return null;
          }
        }
        return transcript;
      });
    }
    const llmService = await serviceFactory.createLLM();
    const ttsService = isGemini ? undefined : await serviceFactory.createTTS();

    console.log(`[Tutor-ED] Service mode: ${mode}`);

    // === WARM UP LOCAL LLM ===
    // llama-swap unloads models after idle TTL; first request after load takes 30s+.
    // Fire a tiny request to wake the model and populate the KV cache before the user speaks.
    if (!isGemini && mode !== 'audex' && (llmService as any).model) {
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
    // Also warm the supervisor/processor model (think variant) in parallel.
    // 2026-07-17: skip in audex mode — SUPERVISOR_LLM_URL defaults to the
    // local port (8093) that audex's GPU-exclusive session doesn't run;
    // the .catch(() => {}) already made this a harmless no-op either way,
    // but there's no point firing a request known to fail.
    if (mode !== 'audex') {
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
    } else {
      // 2026-07-09: @livekit/agents 1.5.0 changed AgentSession's default —
      // if turnDetection isn't explicitly set, it now auto-applies a local
      // InferenceTurnDetector() (audio-level VAD + a turn-detector-v1
      // inference model) instead of leaving it unconfigured. Found live:
      // this local detector WAS firing (START_OF_SPEECH/END_OF_SPEECH,
      // real EOU predictions) while Gemini's own transcript came back
      // empty every turn — the local detector was intercepting/gating the
      // turn instead of the RealtimeModel's server-side detection ever
      // getting a real shot at the audio. Explicit 'realtime_llm' delegates
      // turn detection to the RealtimeModel itself, matching what
      // agent_activity.js's own capability check expects when
      // llm.capabilities.turnDetection is true (confirmed true in our
      // services.llm.capabilities trace).
      sessionConfig.turnDetection = 'realtime_llm';
    }

    const session = new voice.AgentSession(sessionConfig);

    // === CONVERSATION TRACKING ===
    const history = new ConversationHistory(mode !== 'local-qwen');

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
      // 2026-07-12: this used to hand-set `_instructions` and push it
      // through `agent.updateChatCtx()`. For a RealtimeModel session (see
      // agent_activity.ts's updateChatCtx), that path calls
      // `removeInstructions(chatCtx)` then `realtimeSession.updateChatCtx()`
      // — but Gemini Live's API has no message-removal support ("Gemini
      // Live does not support removing messages" WARN, live on every single
      // turn since this runs after every processor/planner update). The
      // failed removal was causing Gemini to treat the resend as "continue
      // the conversation," producing a spontaneous near-duplicate reply
      // ~1-2s after every real one — the "everything twice" bug. The SDK
      // has a purpose-built method for exactly this: agent.updateInstructions()
      // dispatches to `realtimeSession.updateInstructions()` for RealtimeModel
      // sessions (instructions-only, no chat-item churn) and to the normal
      // in-place instructions patch otherwise — correct for both modes.
      await agent.updateInstructions(await buildDynamicInstructions());

      // Under a realtime model that call is inert by design: Gemini Live
      // takes its system instruction once, in the setup message, and the
      // plugin's updateInstructions() only marks the session for restart.
      // So the adaptive tail (planner nudge, frontier words, error
      // treatment, mix line) has to travel as conversation instead —
      // updateChatCtx DOES deliver mid-session. Without this the whole
      // adaptive loop runs, logs, and changes nothing the learner hears.
      //
      // It goes to the realtime session directly rather than through
      // agent.updateChatCtx(), which calls removeInstructions() on the
      // copy first and hands Gemini a diff containing a removal it can't
      // honour. Building on the plugin's own chat context instead makes
      // the diff exactly one added message.
      if (isGemini && lastPromptContext) {
        const note = buildCoachNote(lastPromptContext, lastCoachNote);
        if (note) {
          const realtimeSession = (agent as any)._activity?.realtimeSession;
          if (realtimeSession) {
            lastCoachNote = note;
            const ctx = realtimeSession.chatCtx;
            ctx.addMessage({ role: 'user', content: note });
            await realtimeSession.updateChatCtx(ctx);
            trace('coach.note', note);
          }
        }
      }
    };

    // Single place that actually moves a session to another language, so
    // the processor's language_change trigger and the tutor's own
    // set_target_language tool can't drift apart. Returns false (leaving
    // everything untouched) if the switch is impossible or a no-op, so
    // callers can just carry on.
    async function applyTargetLanguage(
      newLang: string,
      source: 'trigger' | 'tool',
    ): Promise<boolean> {
      const resolved = resolveLanguageConfig(newLang);
      if (!resolved) {
        console.warn(`[Lang:${source}] Unsupported language: ${newLang}`);
        return false;
      }
      if (newLang === targetLang && !languageUndecided) return false;

      const newConfig = resolved;
      try {
        await db.update(users).set({ targetLanguage: newLang }).where(eq(users.id, userId));
        console.log(`[Lang:${source}] Language set: ${targetLang} → ${newLang}`);
      } catch (err) {
        console.error(`[Lang:${source}] Failed to update DB:`, err);
        return false;
      }

      const wasUndecided = languageUndecided;
      targetLang = newLang;
      langConfig = newConfig;
      languageUndecided = false;

      // Update TTS voice to match the new language
      const ttsService = session.tts as any;
      if (ttsService?.updateVoice) {
        ttsService.updateVoice(newConfig.tts.omnivoiceVoice || 'auto', newConfig.tts.omnivoiceLanguage || newLang);
      } else if (!isGemini) {
        console.warn(`[Lang:${source}] TTS does not support updateVoice — voice will stay as the old language`);
      }

      // Now that the language is real, open the intake record against it.
      if (wasUndecided) {
        await saveOnboardingData(userId, newLang, {}).catch((err: any) =>
          console.warn('[Lang] Could not open onboarding row:', err?.message));
      }

      await refreshDbContext();
      invalidateLearnerView(userId, newLang);
      setNudge(wasUndecided
        // First answer of a demo, not a change of mind — there is nothing
        // to switch away from, and framing it as a switch would have the
        // tutor apologise for a language the visitor never asked for.
        ? `They just told you they want to learn ${newConfig.name}. React with delight IN THEIR OWN LANGUAGE, then hand them exactly ONE short ${newConfig.name} phrase with its meaning in the same breath, and get them saying it. Assume they understand no ${newConfig.name} at all yet — a full sentence of it right now is noise to them, not a welcome. No more setup questions.`
        : `The user just asked to switch to ${newConfig.name}. Switch immediately, no pushback — don't question it, joke about it, or make them justify it. That's not a teaching moment, it's a request to honor. Greet them warmly in ${newConfig.name} right now and find out what they know.`);
      await refreshInstructions();
      pendingSignals.push('language_changed');
      updatePlanNow('user_request').catch(() => {});
      return true;
    }

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
        ContextManager.getSummariesContext(userId, targetLang),
      ]);
      cachedDbContext = dbContext;
      cachedNotes = notes;
      cachedSessions = sessions;
      // 2026-06-25: pull the most-recent session's nextSessionHint so the
      // greeting can use it. Without this the agent opens every session
      // with the same hardcoded greeting — even if the previous session
      // explicitly wrote "next time focus on Bom dia" to the DB.
      // 2026-07-02: scoped to targetLang — this used to pull the most
      // recent session across ALL languages, so a Russian session's hint
      // could open a Portuguese session.
      const recent = await ContextManager.getRecentSummaries(userId, targetLang, 1);
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
          let newLang = trigger.value;

          // The 12B fumbles the value field: live 2026-07-03 its reason
          // said "user explicitly asked to learn Portuguese" while value
          // was "ru" — the CURRENT language — so the switch was a ru→ru
          // no-op and the conversation agent riffed a refusal. When the
          // value is a no-op, recover the intent from the reason text:
          // the one supported language it names that is neither the
          // current target nor the learner's native language (those two
          // appear in context phrases like "English-to-Russian learner").
          if (newLang === targetLang) {
            const reason = (trigger.reason || '').toLowerCase();
            const candidates = Object.entries(LANGUAGES).filter(([code, cfg]) => {
              if (code === targetLang || code === (user.nativeLanguage || 'en')) return false;
              const tokens = cfg.name.toLowerCase().match(/[a-z]{4,}/g) || [];
              return tokens.some((t) => reason.includes(t));
            });
            if (candidates.length === 1) {
              newLang = candidates[0]![0];
              console.log(`[Trigger] language_change value was a no-op (${targetLang}→${targetLang}); recovered "${newLang}" from trigger reason`);
            } else {
              console.warn(`[Trigger] language_change is a no-op (already ${targetLang}) and reason names ${candidates.length} other languages — skipping`);
              continue;
            }
          }

          const switched = await applyTargetLanguage(newLang, 'trigger');
          if (!switched) continue;
        }

        if (trigger.type === 'difficulty_adjustment' && trigger.value) {
          const direction = trigger.value;

          // Comprehensible-input throttle: "easier" also drops the
          // language-mix target a notch so the complaint has a mechanical,
          // persistent effect on how much target language the tutor speaks
          // — not just on vocabulary difficulty.
          if (direction === 'easier' && mixThrottleNotches < MAX_THROTTLE_NOTCHES) {
            mixThrottleNotches++;
            cleanRunsSinceThrottle = 0;
            console.log(`[Trigger] Mix throttle: notch ${mixThrottleNotches} — reducing target-language share`);
            trace('mix.throttle', `notches=${mixThrottleNotches}`);
          } else if (direction === 'harder' && mixThrottleNotches > 0) {
            mixThrottleNotches--;
            trace('mix.throttle', `notches=${mixThrottleNotches} (released by harder)`);
          }

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
              setNudge(`Adjusted difficulty to ${newLevel}. Adapt your teaching accordingly.`);
              await refreshInstructions();
            }
          } catch (err) {
            console.error(`[Trigger] Difficulty adjustment failed:`, err);
          }
          // The throttle notch must reach the prompt even when the coarse
          // proficiency level was already at its floor/ceiling (the branch
          // above only refreshes on a level change).
          await refreshInstructions();
        }

        if (trigger.type === 'goal_change' && trigger.value) {
          setNudge(`The user wants to focus on: ${trigger.value}. Adjust your teaching to cover this topic.`);
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
          // Signal-driven wrapup (§3): the only way into wrapup phase is
          // explicit evidence the user is done — never turn count alone.
          if (trigger.value === 'wants_to_end' && !forcedWrapup) {
            forcedWrapup = true;
            trace('session.wrapup.triggered', trigger.reason || 'wants_to_end');
            await refreshInstructions();
          }
        }

        // session_mode_change: explicit user intent for THIS session's
        // shape — outranks the frontier's computed state entirely (design
        // doc §10, same trust-the-user precedent as language_change).
        if (trigger.type === 'session_mode_change' && trigger.value) {
          const requested = trigger.value as SessionMode;
          if (requested === 'review' || requested === 'new' || requested === 'mixed') {
            sessionMode = requested;
            trace('session.mode_change', requested);
            const modeLine = requested === 'review'
              ? `The user asked to focus on review — work only with due/known words for now, no new material, until they say otherwise.`
              : requested === 'new'
                ? `The user asked for new material — lead with new words for now, still weave in due words when they fit.`
                : `The user asked to go back to normal pacing.`;
            setNudge(modeLine);
            await refreshInstructions();
          } else {
            console.warn(`[Trigger] session_mode_change: unrecognized value "${trigger.value}"`);
          }
        }

        // curriculum_advance: explicit user request to move on — no
        // coverage check at all, same trust-the-user precedent as
        // language_change above. See lib/curriculum.ts's skipActiveChunk.
        if (trigger.type === 'curriculum_advance') {
          const advancedChunkId = await skipActiveChunk(userId, targetLang).catch((err) => {
            console.error('[Trigger] curriculum_advance failed:', err);
            return null;
          });
          if (advancedChunkId) {
            trace('curriculum.advanced', `chunkId=${advancedChunkId} reason=user_request`);
            setNudge(`The user asked to move on from the current material — they said they know it or want to skip ahead. Honor it immediately, no pushback, and pick up the next topic naturally.`);
            await refreshInstructions();
          }
        }

        // persona_update: user said "be more X" or similar — parse and apply
        if (trigger.type === 'persona_update' && trigger.value) {
          const personaPatch = parsePersonaRequest(trigger.value);
          if (personaPatch) {
            personaPatch.source = 'user_voice';
            await writePersona(userId, targetLang, personaPatch);
            invalidateLearnerView(userId, targetLang);
            setNudge(`The user asked to adjust the teaching style: "${trigger.value}". Acknowledge briefly and adapt.`);
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
        setNudge('Start simple. Find out what they know, then build from there.');
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

      const plannerUrl = process.env.SUPERVISOR_PLANNER_LLM_URL || process.env.SUPERVISOR_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1';
      const plannerModel = process.env.SUPERVISOR_PLANNER_LLM_MODEL || process.env.SUPERVISOR_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-26b';
      const plannerKey = process.env.SUPERVISOR_PLANNER_LLM_KEY || process.env.SUPERVISOR_LLM_KEY || process.env.LOCAL_LLM_KEY || '';

      const systemPrompt = PLANNER_SYSTEM_PROMPT;

      // Planner is text-only by design (see role→model contract, spec §11) —
      // it reads pre-aggregated text (DB state, engagement trends, history),
      // it doesn't need audio itself.
      const previousNudgeAgeTurns = nudgeIssuedAtTurn !== null ? totalUserTurns - nudgeIssuedAtTurn : null;
      // Cheap: readLearnerView has its own 10s TTL cache, so this is not an
      // extra DB round-trip on every planner cycle.
      const plannerView = await readLearnerView(userId, targetLang);
      const userPrompt = buildPlannerPrompt({
        dbContext,
        goalNote,
        recentHistory,
        previousNudge: supervisorNudge || null,
        previousNudgeAgeTurns,
        runningSummary,
        reason,
        signals: pendingSignals,
        notes,
        recentSessions,
        engagement: {
          turnLengthTrend: computeTurnLengthTrend(),
          pacing: computeEngagement(),
          errorTrend: computeErrorTrend(),
        },
        curriculum: plannerView.activeChunk ? {
          sourceTitle: plannerView.activeChunk.sourceTitle,
          chunkTitle: plannerView.activeChunk.chunkTitle,
          ord: plannerView.activeChunk.ord,
          totalChunks: plannerView.activeChunk.totalChunks,
          coverage: plannerView.activeChunk.coverage,
          // Interpolated directly into the planner prompt (supervisor.ts) —
          // fall back rather than let a literal "null" show up in-prompt
          // for the rare case distillation hasn't finished/failed yet.
          summary: plannerView.activeChunk.summary ?? '(not yet analyzed)',
          nextChunk: plannerView.activeChunk.nextChunk ? {
            title: plannerView.activeChunk.nextChunk.title,
            summary: plannerView.activeChunk.nextChunk.summary ?? '(not yet analyzed)',
          } : null,
        } : null,
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
      // CURRICULUM: skip|revisit — a suggestion, not a command (design doc
      // §5): it goes through the same coverage-tracked advancement write
      // path as everything else, never mutates position directly.
      const curriculumRegex = /^CURRICULUM:\s*(skip|revisit)\s*$/i;

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
                invalidateLearnerView(userId, targetLang);
                trace('planner.persona.updated', JSON.stringify(personaPatch));
              }
            }
          }

          // CURRICULUM: planner-suggested skip/revisit — only "skip" is
          // wired (calls the same skipActiveChunk write path the
          // curriculum_advance voice trigger uses). "revisit" would mean
          // reactivating a DONE chunk, which no write path supports yet —
          // logged, not silently dropped, so a real ask for it is visible.
          const cm = line.match(curriculumRegex);
          if (cm) {
            const action = cm[1].toLowerCase();
            if (action === 'skip') {
              skipActiveChunk(userId, targetLang).then((chunkId) => {
                if (chunkId) trace('curriculum.advanced', `chunkId=${chunkId} reason=planner_suggested`);
              }).catch((err) => console.error('[Planner] curriculum skip failed:', err));
            } else {
              console.warn(`[Planner] CURRICULUM: revisit requested — not yet implemented (no write path to reactivate a done chunk).`);
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
              invalidateLearnerView(userId, targetLang);
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
        if (noteRegex.test(trimmed) || personaRegex.test(trimmed) || curriculumRegex.test(trimmed)) {
          currentField = 'other'; // NOTE/PERSONA/CURRICULUM lines are parsed above
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

      // Only bump the nudge's issue-turn when it actually changed — an
      // unchanged nudge keeps aging toward its TTL (§5).
      if (parsedNudge) {
        setNudge(parsedNudge);
      } else if (!supervisorNudge) {
        setNudge('Continue the conversation naturally.');
      }
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

    // Generate an initial plan in the background — NOT awaited. Desired
    // flow: the conversation agent greets immediately with a simple,
    // low-latency opener; the planner pulls last-session context
    // concurrently; once it lands, the next refreshInstructions() (already
    // wired into updatePlanNow) picks up "Current angle" for the *next*
    // turn. Blocking the greeting on an LLM round-trip added latency for
    // no real benefit now that the conversation agent isn't trying to
    // synthesize continuity itself (see computeOpeningLine).
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

      // PTT: commit when the turn is actually over. Two cases:
      //  - release arrived first (mic mutes ~1s before the STT's inline
      //    transcription lands) — pttCommitPending is set, commit now.
      //  - STRAND RECOVERY (2026-07-11): manual mode, nobody holding, no
      //    release pending — this transcript has no other path to a commit
      //    (live: speech captured during a hands-free→PTT mode switch
      //    stranded forever, agent silent). A transcript arriving mid-hold
      //    (pttHeld) is the one case that must NOT commit — that's just a
      //    pause while the button is down.
      if (pttCommitPending || (pttMode === 'ptt' && !pttHeld)) {
        const reason = pttCommitPending ? 'final transcript arrived' : 'strand recovery — manual mode, no hold in progress';
        pttCommitPending = false;
        if (pttCommitTimer) { clearTimeout(pttCommitTimer); pttCommitTimer = null; }
        trace('ptt.commit', reason);
        try { session.commitUserTurn(); } catch (err) {
          console.warn('[PTT] commitUserTurn failed:', String(err).slice(0, 100));
        }
      }

      // Deduplicate: the VAD EOU and STT FINAL_TRANSCRIPT can both trigger this
      // with the same text within ~500ms. Skip if we already processed this exact text.
      if (transcription === lastProcessedTranscript) {
        console.log(`[User] Duplicate transcript skipped: "${transcription.substring(0, 50)}"`);
        trace('session.user_input_duplicate', transcription.substring(0, 80));
        return;
      }
      lastProcessedTranscript = transcription;

      // Detect audio transcripts from GemmaAudioSTT. The STT emits
      // `[audio key=<id> dur=<n>s] <transcript>` (transcript may be absent
      // if the transcription call failed — placeholder-only fallback) and
      // stashes the real audio URI in audioPayloadRegistry. We pull the URI
      // here so the Processor and Planner can analyze pronunciation.
      const audioKeyMatch = transcription.match(/^\[audio key=([A-Za-z0-9]+)(?: dur=([0-9.]+)s)?\](?:\s+([\s\S]+))?$/);
      const inlineTranscript = audioKeyMatch?.[3]?.trim() || undefined;
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
            `(${(entry.uri.length / 1024).toFixed(1)} KB)` +
            (inlineTranscript ? ` heard="${inlineTranscript.slice(0, 60)}"` : ' (no transcript)'),
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
      totalUserTurns++;
      // turnSeq: monotonic per-user-turn id, threaded through the related
      // processor.analysis / agent.reply / llm.token events below so the
      // dashboard frontend can correlate them without guessing from arrival
      // order or timestamps (see Task 4a — useConversationStream rewrite).
      const turnSeq = totalUserTurns;
      // Frontend chat shows the real words when we have them, not the
      // bracket placeholder. Mid-hold segments buffer instead of emitting
      // (see pttSegmentTexts) — the user's bubble appears once, on commit,
      // with the whole utterance.
      if (pttMode === 'ptt' && pttHeld) {
        pttSegmentTexts.push(inlineTranscript ?? transcription);
        if (audioAttachment) pttSegmentAudioIds.push(audioAttachment.audioId);
        trace('ptt.segment.buffered', `${pttSegmentTexts.length} segment(s) held`);
      } else {
        const combined = [...pttSegmentTexts, inlineTranscript ?? transcription].join(' ');
        // Audio dump keys ride along so the frontend can offer playback of
        // exactly what the model heard (served via /api/audio-dumps/:key).
        const audioIds = [...pttSegmentAudioIds, ...(audioAttachment ? [audioAttachment.audioId] : [])];
        pttSegmentTexts = [];
        pttSegmentAudioIds = [];
        emitEvent('user.transcript', { text: combined, isFinal: true, turnSeq, audioIds });
      }

      // The visitor's first real answer is the single most valuable thing
      // the demo produces: it's them saying, unprompted and in their own
      // words, why they're here ("I'm going to Japan in April", "I want to
      // talk to my grandmother"). Vocabulary can be re-earned in a minute
      // of conversation; this can't, and it's what lets their first real
      // session pick up where the demo left off instead of starting cold.
      if (isDemoSession && !demoIntentCaptured && transcription.trim().split(/\s+/).length >= 3) {
        demoIntentCaptured = true;
        const intent = transcription.trim().slice(0, 200);
        ContextManager.writeNote(userId, 'goal', `Said at the demo: "${intent}"`, 'demo')
          .catch((err: any) => console.warn('[Demo] intent note failed:', err?.message));
        saveOnboardingData(userId, targetLang, { goalDetails: intent })
          .catch((err: any) => console.warn('[Demo] intent onboarding save failed:', err?.message));
        console.log(`[Demo] Captured stated intent: "${intent}"`);
      }

      pendingUserTurns.push(transcription);
      if (pendingUserTurns.length > PROCESSOR_TURN_INTERVAL) {
        pendingUserTurns.shift();
      }

      // Adaptive: track turn length for engagement detection.
      // Real transcript when we have one; duration estimate for
      // placeholder-only audio turns; actual word count for text.
      const isAudioTurn = transcription.startsWith('[audio key=');
      const wordCount = isAudioTurn
        ? (inlineTranscript
            ? inlineTranscript.split(/\s+/).filter((w: string) => w.length > 0).length
            : Math.round((audioAttachment?.durationSec ?? 0) * 2.5))
        : transcription.split(/\s+/).filter(w => w.length > 0).length;
      recentUserTurnWords.push(wordCount);
      if (recentUserTurnWords.length > MAX_RECENT) recentUserTurnWords.shift();

      // Only run the processor every N turns
      if (totalUserTurns % PROCESSOR_TURN_INTERVAL !== 0) return;

      const batchUtterance = pendingUserTurns.join('\n');

      // Minimal Processor context: previous tutor line + current user turn
      // only — see getLatestTurnMessages for why a wider window is actively
      // harmful here, not just wasteful.
      const historyMessages = history.getLatestTurnMessages();
      const lastExchange = history.getLastExchangeText();

      // Physical word ceiling for the hallucination guard: speech runs
      // ~2-3 words/sec, so an analysis with more lexemes than duration*3
      // transcribed sounds that weren't there. Text turns are bounded by
      // their own word count (+2 margin for lemma splits).
      const maxLexemes = audioAttachment
        ? Math.max(2, Math.round(audioAttachment.durationSec * 3))
        : batchUtterance.split(/\s+/).filter(w => w.length > 0).length + 2;

      // Cloud-mode sessions never populate audio_url content in
      // historyMessages (Gemini Realtime hands back transcripts, not raw
      // audio — see analyzeUtteranceWithLocalLLM's hasAudioMessages check),
      // so it's safe to route cloud-mode grading to the cheaper text-only
      // 26B-A4B model. Local mode's Processor call DOES send real audio for
      // pronunciation/tone judgment, so it must stay on the local
      // audio-capable model — do not apply this swap there.
      // 2026-07-16: audex mode joins this group too — AudexSTT returns real
      // ASR text (not the `[audio key=...]` placeholder GemmaAudioSTT uses),
      // so historyMessages has no audio_url here either. It also MUST use
      // the cloud route rather than the "local" default: audex owns the GPU
      // exclusively while it's running (vllm-qat/omnivoice-tts stopped), so
      // the local processor URL (port 8082/8093) is unreachable during an
      // audex session.
      const usesTextOnlyProcessor = isGemini || mode === 'audex';
      // Within the local branch, prefer whichever analysis model is already
      // warm and fall back to OpenRouter when none is — see
      // analysis-endpoint.ts. Resolved per batch, not once at startup: a
      // session outlives any given local model's residency, and a cold
      // local model would otherwise stall a live turn on a 15GB load.
      resolveAnalysisEndpoint('PROCESSOR', { allowCloud: usesTextOnlyProcessor }).then((endpoint) => {
        console.log(`[Processor] Analysis via ${endpoint.source}: ${endpoint.model}`);
        return runProcessor(userId, batchUtterance, lastExchange, {
        maxLexemes,
        useGemini: false,
        llmUrl: endpoint.url,
        llmModel: endpoint.model,
        llmKey: endpoint.key,
        recentHistory: lastExchange,
        historyMessages,
        tutorRecentText: history.getRecentTutorText(),
        provenance: inOnboarding ? 'probe' : 'conversation',
        // STT already transcribed this turn (see configureTranscription
        // above) — hand it over so the processor skips its own pass 1 and
        // grading stays anchored to the SAME text the conversation saw.
        knownTranscript: inlineTranscript,
      }).then((result) => {
        lastProcessorRun = {
          at: Date.now(),
          batch: pendingUserTurns.slice(),
          analysisLexemeCount: result.analysis?.lexemes?.length || 0,
          srsUpdateCount: result.srsUpdates?.length || 0,
          errors: result.errors,
          rawPrompt: result.rawPrompt,
          rawResponse: result.rawResponse,
          // These three feed buildDynamicInstructions's tail lines directly —
          // they must be here for the error/hint/pronunciation lines to work.
          structuredErrors: result.structuredErrors,
          grammarHints: result.grammarHints,
        };

        // Give the text-only planner eyes on what the user said: swap the
        // opaque audio placeholder for the words the processor extracted.
        // (Only target-language words + substitutions are tagged now, so
        // pure-native chatter keeps its placeholder — still better than
        // nothing for the turns that matter.)
        const heardForms = (result.analysis?.lexemes ?? [])
          .map((l: any) => l.form || l.lemma)
          .filter(Boolean);
        // The STT-inline transcript already gives the planner/LLM real
        // words in the turn text itself; the lexeme-forms annotation and
        // the registry transcript are only worth writing when the inline
        // transcription failed (placeholder-only turn).
        if (audioAttachment && !inlineTranscript && heardForms.length > 0) {
          history.annotateUserTurnByAudioKey(
            audioAttachment.audioId,
            `(heard: ${heardForms.join(' ')})`,
          );
        }
        if (audioAttachment && !inlineTranscript && result.transcript) {
          setAudioTranscript(audioAttachment.audioId, result.transcript);
        }

        // Adaptive: track error count for error density computation
        const errorCount = (result.analysis?.lexemes ?? []).filter(
          (l: any) => l.performance === 'wrong_use' || l.performance === 'recall_fail',
        ).length;
        recentErrorCounts.push(errorCount);
        if (recentErrorCounts.length > MAX_RECENT) recentErrorCounts.shift();

        // Mix-throttle decay: a distress notch releases only after a run
        // of clean turns — the learner has to re-earn immersion, it never
        // snaps back the moment they stop complaining.
        if (mixThrottleNotches > 0) {
          if (errorCount === 0) {
            cleanRunsSinceThrottle++;
            if (cleanRunsSinceThrottle >= THROTTLE_DECAY_RUNS) {
              mixThrottleNotches--;
              cleanRunsSinceThrottle = 0;
              trace('mix.throttle', `notches=${mixThrottleNotches} (decayed after ${THROTTLE_DECAY_RUNS} clean runs)`);
            }
          } else {
            cleanRunsSinceThrottle = 0;
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

        // Discourse memory (Phase M, record-only — see design doc §7).
        // Fire-and-forget: a failure here must never affect the live loop.
        // Prefer the cascade's clean transcript for audio turns; falls
        // back to the raw batched text for text-only turns.
        recordUtterance({
          userId,
          sessionId: getSessionId(),
          turnSeq,
          language: targetLang,
          transcript: result.transcript || batchUtterance,
          analysis: result.analysis,
        }).then((utteranceId) => {
          if (result.structuredErrors?.length) {
            recordErrorObservations({
              userId,
              language: targetLang,
              utteranceId,
              errors: result.structuredErrors,
            }).catch(() => {});
          }
        }).catch(() => {});

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
          // turnSeq of the last (most recent) user turn in this batch —
          // when PROCESSOR_TURN_INTERVAL > 1 this analysis covers multiple
          // prior turns joined into `utterance`, but the frontend still
          // needs a single anchor point to attach it to; the newest turn
          // in the batch is the natural choice since the batch only fires
          // once that turn lands.
          turnSeq,
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

        // === DEMO MODE: mirror the processor's tracked words onto the
        // LiveKit data channel so the marketing site's live memory graph
        // can render them in real time. Only active when
        // DEMO_SESSION_TIME_LIMIT_MS is set (this worktree only — see
        // ROADMAP.md in the marketing-site repo; production's own copy of
        // this file is untouched). Deliberately reads the same
        // decoratedLexemes the dashboard's SSE stream already gets, just
        // delivered over the room's own (already-public) data channel
        // instead of the admin dashboard's not-yet-exposed SSE endpoint.
        if (process.env.DEMO_SESSION_TIME_LIMIT_MS && decoratedLexemes.length > 0) {
          try {
            // The graph is the only proof a visitor gets that anything
            // was actually processed, so it needs the two distinctions the
            // processor already makes and used to discard here:
            //   - `exposed` — the tutor said it and they repeated it. New
            //     to them, not yet evidence of knowing it (echo gate,
            //     supervisor-functions.ts §3.3).
            //   - `tracked` + isNew — they produced it unprompted, first
            //     time. That's the good one, and it should look like it.
            // Mastery comes from FSRS state (0 new / 1 learning / 2 review
            // / 3 relearning) and the grade the word just earned, matched
            // back through lexemeIndex.
            const updateByIndex = new Map<number, any>(
              (result.srsUpdates || []).map((u: any) => [u.lexemeIndex, u]),
            );
            const payload = JSON.stringify({
              type: 'linglang.demo.words',
              lexemes: decoratedLexemes.map((lex: any, i: number) => {
                const upd = updateByIndex.get(i);
                return {
                  lemma: lex.lemma,
                  translation: lex.translation,
                  tracking: lex.tracking,
                  // Tutor-introduced, or produced cold for the first time.
                  isNew: lex.tracking === 'exposed' ? true : upd?.isNew ?? false,
                  // Only meaningful for graded words; absent for exposures.
                  grade: upd?.grade,
                  state: upd?.newState,
                };
              }),
            });
            ctx.room.localParticipant?.publishData(new TextEncoder().encode(payload), {
              reliable: true,
              topic: 'linglang-demo-events',
            });
          } catch (err: any) {
            console.warn('[Tutor-ED] demo word-event publish failed:', err?.message);
          }
        }

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
        // Also refresh DB cache since SRS state has changed — and drop the
        // learner-view cache so the frontier reflects it on the very next
        // prompt build instead of waiting out the TTL (§2: "clearing the
        // due queue mid-session changes tutor behavior within a turn").
        if ((result.srsUpdates?.length || 0) > 0) {
          refreshDbContext();
          invalidateLearnerView(userId, targetLang);
          // Curriculum coverage (no-op today — no content has been ingested
          // yet, so no user_content_progress row is ever 'active'; wired
          // now so it starts working the moment Phase 2 ingests a source).
          recomputeActiveChunkCoverage(userId, targetLang).catch(() => {});
        }
        writeRuntimeStateSoon();
        refreshInstructions().catch(() => {});
      }).catch((err) => {
        console.error('[Processor] Failed:', err);
        trace('processor.error', String(err));
      });
      });
    });

    // Cleanup timer on disconnect
    ctx.room.once('disconnected', () => {
      clearInterval(planTimer);
      clearInterval(stuckWatchdog);
    });

    // === PUSH-TO-TALK TURN CONTROL (2026-07-10) ===
    // The frontend's PTT button only mutes/unmutes the mic, so server-side
    // VAD used to commit the turn on any mid-hold pause — the turn "sent
    // itself" while the user was still holding the button (live report).
    // Protocol (topic 'linglang.ptt', published by VoiceControl.tsx):
    //   {type:'mode', mode:'ptt'|'handsFree'} — sent on connect + mode
    //     switch. 'ptt' → manual turn detection (VAD still segments and STT
    //     still transcribes; only the COMMIT is gated). 'handsFree' → back
    //     to automatic detection (null = SDK auto-selection).
    //   {type:'release'} — commit the turn. The STT's inline transcription
    //     lands ~1s AFTER the mic mutes, so we commit on the next final
    //     transcript rather than immediately; if none arrives in 4s the
    //     hold contained nothing transcribable (silence/mic tap) and the
    //     turn is cleared instead — committing an empty turn would make
    //     the agent reply to nothing.
    //   {type:'cancel'} — swipe-up cancel: discard the pending turn.
    let pttCommitPending = false;
    let pttCommitTimer: NodeJS.Timeout | null = null;
    // Hold-state tracking (2026-07-11): lets the transcript handler tell
    // "mid-hold pause — wait for release" from "nobody is holding — this
    // transcript will strand if we don't commit it." The live failure: a
    // turn spoken during a hands-free→PTT mode switch landed in manual
    // mode with no release ever coming (the user never held the button for
    // it) — stranded turn, agent silent.
    let pttMode: 'ptt' | 'handsFree' = 'handsFree';
    let pttHeld = false;
    // Mid-hold transcript buffer (2026-07-11): VAD segments on every pause
    // even while the button is down — that's fine for the commit logic
    // (held segments don't commit), but each segment used to emit its own
    // user.transcript to the frontend the moment it transcribed, so the
    // user watched their words "send" mid-hold and read it as VAD
    // bypassing PTT (live report). Segments now buffer here and emit as
    // ONE combined message at commit.
    let pttSegmentTexts: string[] = [];
    // Parallel to pttSegmentTexts — audio dump keys for in-chat playback.
    let pttSegmentAudioIds: string[] = [];
    ctx.room.on('dataReceived' as any, (payload: Uint8Array, _participant: any, _kind: any, topic?: string) => {
      if (topic !== 'linglang.ptt') return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === 'mode') {
          const manual = msg.mode === 'ptt';
          pttMode = manual ? 'ptt' : 'handsFree';
          if (!manual) pttHeld = false;
          session.updateOptions({ turnHandling: { turnDetection: manual ? 'manual' : null } });
          trace('ptt.mode', `${msg.mode} → turnDetection=${manual ? 'manual' : 'auto'}`);
        } else if (msg.type === 'hold') {
          pttHeld = true;
          trace('ptt.hold', 'press started');
        } else if (msg.type === 'release') {
          pttHeld = false;
          pttCommitPending = true;
          if (pttCommitTimer) clearTimeout(pttCommitTimer);
          // 12s, was 4s (2026-07-10, live failure): VAD end-of-speech can
          // lag the mic mute by several seconds and a degenerate
          // transcription decode ran 5.9s — the 4s timer fired first. And
          // the old timeout action, clearUserTurn(), RESTARTS the STT node
          // ("agent.sttNode.start" right after every timeout in the log),
          // which killed the in-flight transcription and orphaned the turn
          // entirely — the agent just went silent. Timeout now COMMITS
          // whatever the turn holds instead: worst case the agent responds
          // to a sparse turn, which beats responding to nothing. cancel
          // (deliberate user gesture) remains the only clearUserTurn path.
          pttCommitTimer = setTimeout(() => {
            if (!pttCommitPending) return;
            pttCommitPending = false;
            trace('ptt.commit.timeout', 'no transcript within 12s of release — committing as-is');
            try { session.commitUserTurn(); } catch { /* nothing to commit — fine */ }
            // 2026-07-11: flush whatever was buffered from mid-hold segments
            // — the ONLY other flush site is inside the UserInputTranscribed
            // handler below, gated on a NEW transcript arriving. On a timeout
            // (no new transcript came, that's WHY it timed out) that handler
            // never runs, so buffered segments — and their audio-dump ids,
            // meaning the in-chat playback feature — silently never reached
            // the frontend. The conversation reply itself was never affected
            // (that reads the SDK's own turn state, not this buffer); this
            // only fixes the user's chat bubble + audio player going missing.
            if (pttSegmentTexts.length > 0) {
              emitEvent('user.transcript', {
                text: pttSegmentTexts.join(' '),
                isFinal: true,
                turnSeq: totalUserTurns,
                audioIds: pttSegmentAudioIds,
              });
              pttSegmentTexts = [];
              pttSegmentAudioIds = [];
            }
          }, 12000);
          trace('ptt.release', 'awaiting final transcript to commit');
        } else if (msg.type === 'cancel') {
          pttHeld = false;
          pttCommitPending = false;
          pttSegmentTexts = [];
          pttSegmentAudioIds = [];
          if (pttCommitTimer) { clearTimeout(pttCommitTimer); pttCommitTimer = null; }
          try { session.clearUserTurn(); } catch { /* no pending turn — fine */ }
          trace('ptt.cancel', 'turn discarded');
        }
      } catch (err) {
        console.warn('[PTT] Bad data message:', String(err).slice(0, 80));
      }
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
      // Watchdog liveness: 'thinking'/'speaking' start the stuck-timer;
      // any other state (listening/idle/initializing) clears it.
      agentBusySince = (ev.newState === 'thinking' || ev.newState === 'speaking') ? Date.now() : null;
    });

    // Capture agent replies (LLM responses) for live chat view.
    // Onboarding completion is now driven by the submit_onboarding_verdict
    // tool call (§10), not by scraping a JSON block out of spoken text —
    // see the tool definition above.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev: any) => {
      const item = ev.item;
      if (item?.role === 'assistant' && item?.textContent) {
        // turnSeq: the turn this reply responds to, captured once at this
        // exchange's token-stream start (currentExchangeTurnSeq) rather than
        // read live from totalUserTurns — see the declaration comment above
        // for why a live read is unsafe across an in-flight interruption.
        // Lets the frontend replace/finalize the matching streamed bubble
        // instead of appending a duplicate (see Task 4a).
        emitEvent('agent.reply', { text: item.textContent, source: item.source || 'unknown', turnSeq: currentExchangeTurnSeq });
        history.addAssistantTurn(item.textContent);

        // Comprehensible-input controller: measure how much of the reply
        // was actually in the target language. On a bad overshoot, refresh
        // instructions immediately so the corrective line is in place
        // before the next reply, even if no processor run lands in between.
        const measured = measureTargetShare(item.textContent, targetLang);
        lastTutorMixShare = measured;
        if (measured !== null) {
          const levelTarget = targetShareForLevel(userLevel);
          trace('mix.measured', `share=${measured.toFixed(2)} levelTarget=${levelTarget.toFixed(2)} throttle=${mixThrottleNotches}`);
          if (measured > levelTarget + 0.25) {
            refreshInstructions().catch(() => {});
          }
        }

        // Passive OOV measurement (learner-field spec §5.2, measure-only —
        // no rewrite loop). Fire-and-forget: does its own DB read, never
        // blocks the reply/TTS pipeline that already dispatched this text.
        readLearnerView(userId, targetLang).then((view) => {
          const frontierLemmas = [...view.dueWords, ...view.newWords].map((w) => w.lemma);
          return measureReplyOov(userId, targetLang, item.textContent, frontierLemmas);
        }).then((oov) => {
          if (oov) {
            trace('lexicalLint.oov', `rate=${oov.oovRate.toFixed(2)} (${oov.oovWords.length}/${oov.totalWords}) words=${oov.oovWords.slice(0, 8).join(',')}`);
          }
        }).catch(() => {});
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
        participantIdentity: participant.identity,
        // 2026-07-12: room names are deterministic per user (linglang-${userId}),
        // so a page reload rejoins the SAME room/job instead of spawning a new
        // one. Default closeOnDisconnect=true tears down the AgentSession the
        // instant the old tab drops — but this job's dataReceived listener
        // (PTT) lives outside the session and keeps running, so the agent
        // silently "hears" holds/releases with no session left to reply
        // through. Nothing recreates the session on reconnect, so it stays
        // dead until the whole job is killed. Keep the session alive across
        // reconnects instead.
        closeOnDisconnect: false,
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
    // 2026-07-02: greet immediately with a simple, low-latency opener — the
    // planner is still working in the background (fired above, not
    // awaited) and its "Current angle" lands in time for the *next* turn's
    // refreshInstructions(), not this one. Deciding *how* to pick up from
    // last session is the planner's job; the conversation agent's job here
    // is just a fluent, fast greeting, not synthesizing continuity from
    // raw session data (see computeOpeningLine).
    //
    // We trigger the LLM by sending a system-style user message that
    // the LLM reads as "the user has just connected." Plain "..." was
    // too vague and the LLM defaulted to a generic "Olá, tudo bem?"
    console.log('[Tutor-ED] Sending initial greeting (LLM-generated)...');
    trace('session.generateReply.opening');
    try {
      await session.generateReply({
        userInput: isDemoSession
          // A demo visitor has no history to pick up from and has chosen
          // nothing — the opening turn's whole job is to find out what
          // they want to learn so the real conversation can start.
          ? '[system: a brand-new visitor just connected, having chosen nothing — run your opening line now: say hello, ask what language they want to speak, and name the options. Keep it under 10 seconds, then stop and listen.]'
          : '[system: the user has just connected — greet them and pick up where you left off]',
      });
    } catch (err: any) {
      console.warn('[Tutor-ED] generateReply failed:', err?.message);
      // session.say() isn't supported on the RealtimeModel (Gemini) path —
      // only fall back to it for the STT/TTS pipeline modes, where a silent
      // demo session is otherwise unrecoverable.
      if (!isGemini) session.say(langConfig.prompts.greeting);
    }

    // === DEMO MODE: graceful session wrap-up before the hard token expiry ===
    // Only active when DEMO_SESSION_TIME_LIMIT_MS is set (the anonymous demo
    // worker only, see ROADMAP.md in the marketing-site repo — production
    // never sets this, so this block is a no-op there). Nudges the model to
    // wrap up warmly ~30s before the LiveKit token's hard TTL, then force-
    // disconnects a few seconds before the token actually expires so the
    // session ends cleanly instead of getting cut off mid-sentence.
    const demoLimitMs = process.env.DEMO_SESSION_TIME_LIMIT_MS
      ? parseInt(process.env.DEMO_SESSION_TIME_LIMIT_MS, 10)
      : null;
    if (demoLimitMs && demoLimitMs > 0) {
      const wrapUpAt = Math.max(0, demoLimitMs - 30_000);
      const hardStopAt = Math.max(0, demoLimitMs - 5_000);
      setTimeout(() => {
        trace('demo.wrapup.nudge');
        // Tell the page we're wrapping up, so it can put the create-account
        // button on screen NOW. The tutor is about to say "you can make a
        // free account" out loud, and until this existed the button didn't
        // appear until the session actually ended half a minute later,
        // leaving people asking where they were supposed to click.
        try {
          ctx.room.localParticipant?.publishData(
            new TextEncoder().encode(JSON.stringify({ type: 'linglang.demo.wrapup' })),
            { reliable: true, topic: 'linglang-demo-events' },
          );
        } catch (err: any) {
          console.warn('[Tutor-ED] demo wrap-up publish failed:', err?.message);
        }
        (async () => {
          try {
            await session.generateReply({
              userInput:
                '[system: this demo session is almost out of time — wrap up the conversation warmly in this reply, thank them, and mention they can create a free account to keep going and save their progress]',
            });
          } catch (err: any) {
            console.warn('[Tutor-ED] demo wrap-up generateReply failed:', err?.message);
          }
        })();
      }, wrapUpAt);
      setTimeout(() => {
        trace('demo.session.hardstop');
        console.log('[Tutor-ED] Demo session time limit reached, disconnecting');
        ctx.room.disconnect();
      }, hardStopAt);
    }

    // === LLM TOKEN STREAM → DASHBOARD ===
    // Subscribe to the LLM event bus and forward each text delta to the
    // dashboard as `llm.token` events. The dashboard's SSE endpoint relays
    // these to the UI so the user can read along with the audio playback.
    // The bus is process-wide, so we tag each event with the user/room for
    // the dashboard to filter.
    const roomName = ctx.room.name;
    const onLlmToken = (ev: { text: string; index: number; isStart: boolean; isEnd: boolean }) => {
      // Capture turnSeq ONCE per exchange, at the first delta of a new
      // response (isStart) — then hold it steady for every later delta of
      // the SAME stream, all the way to isEnd. Do not re-read
      // totalUserTurns on every delta: if a new/interrupting user turn
      // lands mid-stream (a real, supported feature — see the
      // speechHandle.interrupted tracing elsewhere in this file),
      // totalUserTurns bumps before this stream's isEnd, and a live read
      // would stamp the stream's tail with the wrong (newer) turnSeq,
      // breaking the frontend's `agent-${turnSeq}` bubble lookup (Task 4a
      // review finding). currentExchangeTurnSeq is also what `agent.reply`
      // above reads, so both events for one exchange always agree.
      if (ev.isStart) {
        currentExchangeTurnSeq = totalUserTurns;
      }
      emitEvent('llm.token', {
        userId,
        roomName,
        text: ev.text,
        index: ev.index,
        isStart: ev.isStart,
        isEnd: ev.isEnd,
        turnSeq: currentExchangeTurnSeq,
      });
    };
    llmEvents.on('token', onLlmToken);

    // Persist session summary on disconnect — uses planner's running summary, no extra LLM call
    ctx.room.on('disconnected', () => {
      console.log('[Tutor-ED] Session ended');
      clearInterval(planTimer);
      clearInterval(stuckWatchdog);
      llmEvents.off('token', onLlmToken);
    });
    // 2026-07-11: the summary write used to live in the 'disconnected'
    // handler as fire-and-forget — but the job process tears down ~10ms
    // after that event, killing the DB write mid-flight EVERY time (zero
    // summaries in the table despite weeks of sessions; neither the
    // success nor the failure log line ever appeared). addShutdownCallback
    // is awaited by the worker before the process exits — the write
    // actually completes here.
    ctx.addShutdownCallback(async () => {
      try {
        await persistSessionSummaryAsync(userId, targetLang, sessionStartedAt, runningSummary, sessionStats);
      } catch (err) {
        console.warn('[Tutor-ED] Session summary failed in shutdown:', String(err).slice(0, 120));
      }
    });

    // Estimated Google API cost accrual — see lib/google-budget.ts's doc
    // comment on why this is an estimate (duration * a configurable
    // per-second rate), not real billing reconciliation. Only for sessions
    // riding the shared key (billGoogleUsage); BYO-key users are unlimited.
    if (billGoogleUsage && geminiSessionStartedAt) {
      ctx.addShutdownCallback(async () => {
        try {
          const seconds = (Date.now() - geminiSessionStartedAt) / 1000;
          const ratePerSecond = parseInt(process.env.GOOGLE_REALTIME_MICROS_PER_SECOND || '350', 10);
          const { recordGoogleUsage } = await import('./lib/google-budget.js');
          await recordGoogleUsage(userId, Math.round(seconds * ratePerSecond));
        } catch (err) {
          console.warn('[Tutor-ED] Google usage accrual failed in shutdown:', String(err).slice(0, 120));
        }
      });
    }
  },
});

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LINGLANG_AGENT_NAME ?? 'linglang-tutor',
  }));
}
