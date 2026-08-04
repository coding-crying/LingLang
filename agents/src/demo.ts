import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { type JobContext, type JobProcess, WorkerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { getLanguageConfig, getSupportedLanguages } from './config/languages.js';
import { buildInstructions } from './config/prompts/base.js';
import { createTTS } from './tts/fallback.js';
import { createSTT } from './stt/fallback.js';
import { ElevenLabsRealtimeSTT } from './stt/elevenlabs-realtime.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { getDemoBudgetStatus, recordDemoUsage } from './lib/demo-budget.js';

type LangMatch = { code: string; name: string };

// Word-boundary safe language matching — avoids 'es' matching inside 'portuguese'
function matchLanguage(input: string): LangMatch | null {
  const text = input.trim().toLowerCase();

  // Full name map checked first (longest/most specific)
  const nameMap: [string, string][] = [
    ['russian', 'ru'],
    ['portuguese', 'pt'], ['português', 'pt'], ['portugues', 'pt'],
    ['spanish', 'es'], ['español', 'es'], ['espanol', 'es'],
    ['french', 'fr'], ['français', 'fr'], ['francais', 'fr'],
    ['arabic', 'ar'],
    ['english', 'en'],
  ];

  for (const [name, code] of nameMap) {
    if (text.includes(name)) {
      const lang = getSupportedLanguages().find(l => l.code === code);
      if (lang) return { code, name: lang.name };
    }
  }

  // Short ISO codes — word boundary only (prevents 'es' hitting 'portuguese')
  for (const code of ['ru', 'pt', 'fr', 'ar', 'en', 'es']) {
    if (new RegExp(`\\b${code}\\b`).test(text)) {
      const lang = getSupportedLanguages().find(l => l.code === code);
      if (lang) return { code, name: lang.name };
    }
  }

  return null;
}

function matchExperience(input: string): boolean | null {
  const text = input.trim().toLowerCase();
  const newTokens = ['new', 'beginner', 'never', 'no', 'nope', 'not really', 'starting', 'zero', 'nothing', 'nada'];
  const expTokens = ['yes', 'yeah', 'some', 'a little', 'bit', 'studied', 'know', 'intermediate', 'advanced', 'already', 'before'];
  for (const t of expTokens) { if (text.includes(t)) return false; }  // experienced
  for (const t of newTokens) { if (text.includes(t)) return true; }   // new
  return null;
}

async function createDemoUser(targetLanguage: string, nativeLanguage: string): Promise<string> {
  const userId = `demo-${randomUUID()}`;
  await db.insert(users).values({
    id: userId,
    targetLanguage,
    nativeLanguage,
    proficiencyLevel: 'beginner',
  });
  return userId;
}


function makeLLM() {
  return new openai.LLM({
    baseURL: process.env.CONVERSATION_LLM_URL || 'http://localhost:11434/v1',
    model: process.env.CONVERSATION_LLM_MODEL || 'gemma3:4b',
    apiKey: process.env.CONVERSATION_LLM_KEY || 'ollama',
  });
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    // This demo has no auth and no per-user budget row — it's a public,
    // unauthenticated entry point that (unlike the dashboard flow) can
    // silently fall through to paid ElevenLabs TTS/STT with nothing
    // tracking or capping the spend. See lib/demo-budget.ts. Checked
    // before any TTS/STT is created, so an exhausted budget costs nothing
    // beyond this one query.
    const budget = await getDemoBudgetStatus();
    if (budget.overBudget) {
      console.warn(`[Demo] Global demo budget exhausted (${budget.spentMicros}/${budget.limitMicros} micros) — declining session`);
      await ctx.connect();
      await ctx.room.disconnect();
      return;
    }

    const sessionStartedAt = Date.now();
    let usedElevenLabs = false;

    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    const defaultLang = getLanguageConfig(process.env.DEFAULT_TARGET_LANGUAGE || 'pt');

    // ── Phase 1: Bootstrap — scripted first question, LLM handles follow-up ──
    const englishLang = getLanguageConfig('en');
    const [englishTTS, englishSTT] = await Promise.all([
      createTTS(englishLang),
      createSTT(englishLang),
    ]);
    if (englishTTS instanceof elevenlabs.TTS || englishSTT instanceof ElevenLabsRealtimeSTT) usedElevenLabs = true;
    console.log(`[Demo] Bootstrap TTS: ${(englishTTS as any).label || englishTTS.constructor.name}`);
    console.log(`[Demo] Bootstrap STT: ${(englishSTT as any).label || englishSTT.constructor.name}`);

    const bootstrapAgent = new voice.Agent({
      instructions: `You are a quick onboarding assistant for a language learning app.
IMPORTANT: The opening question has already been asked: "What language would you like to learn?"
Do NOT repeat it or generate an opening message.

Supported languages: Russian, Spanish, French, European Portuguese, Arabic, English.

Once the user names a language, ask ONLY: "Have you studied [language] before, or are you starting fresh?"
After they answer that, say: "Perfect." and stop.

Do not teach. Do not explain. Do not add anything else.`,
    });

    const bootstrapSession = new voice.AgentSession({
      agent: bootstrapAgent,
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: englishSTT,
      tts: englishTTS,
    });

    await bootstrapSession.start({
      room: ctx.room,
      agent: bootstrapAgent,
      inputOptions: { participantIdentity: participant.identity },
    });

    // Greet immediately via scripted say() — no LLM wait
    bootstrapSession.say('What language would you like to learn?');

    // Routing state machine — sequential: language first, then experience
    let phase: 'language' | 'experience' = 'language';
    let detectedLang: LangMatch | null = null;
    let langResolve: ((v: LangMatch) => void) | null = null;
    let expResolve: ((v: boolean) => void) | null = null;
    let bootstrapComplete = false;
    let bootstrapReplyInFlight = false;

    bootstrapSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, async (ev: any) => {
      if (!ev.isFinal) return;
      if (bootstrapComplete || bootstrapReplyInFlight) return;
      const text = ev.transcript || ev.text || '';
      if (!text) return;

      if (phase === 'language') {
        const match = matchLanguage(text);
        if (match) {
          console.log(`[Demo] Language detected: ${match.name}`);
          detectedLang = match;
          langResolve?.(match);

          const combinedExperience = matchExperience(text);
          if (combinedExperience !== null) {
            console.log(`[Demo] Experience: ${combinedExperience ? 'beginner' : 'experienced'}`);
            bootstrapComplete = true;
            expResolve?.(combinedExperience);
            return;
          }

          phase = 'experience';
          bootstrapReplyInFlight = true;
          try {
            await bootstrapSession.say(`Have you studied ${match.name} before, or are you starting fresh?`);
          } finally {
            bootstrapReplyInFlight = false;
          }
        } else {
          bootstrapReplyInFlight = true;
          try {
            await bootstrapSession.say('Please choose one language: Russian, Spanish, French, European Portuguese, Arabic, or English.');
          } finally {
            bootstrapReplyInFlight = false;
          }
        }
      } else if (phase === 'experience') {
        const isNew = matchExperience(text);
        if (isNew !== null) {
          console.log(`[Demo] Experience: ${isNew ? 'beginner' : 'experienced'}`);
          bootstrapComplete = true;
          expResolve?.(isNew);
        } else {
          bootstrapReplyInFlight = true;
          try {
            await bootstrapSession.say(`Have you studied ${detectedLang?.name || 'that language'} before, or are you starting fresh?`);
          } finally {
            bootstrapReplyInFlight = false;
          }
        }
      }
    });

    const lang = await new Promise<LangMatch>((resolve) => { langResolve = resolve; });
    const isNew = await new Promise<boolean>((resolve) => { expResolve = resolve; });

    // Bridge the silence gap — user hears something while the new session loads
    await bootstrapSession.say(`Alright, ${lang.name}. Give me a second.`);
    console.log('[Demo] Closing bootstrap session');
    await bootstrapSession.close();

    // ── Phase 2: Main tutor session ──
    const langConfig = getLanguageConfig(lang.code);
    const userId = await createDemoUser(lang.code, process.env.DEFAULT_NATIVE_LANGUAGE || 'en');

    const levelNote = isNew
      ? 'Complete beginner. Lead the session — introduce ONE word or phrase at a time. Start with a basic greeting.'
      : 'Has some experience. Probe their level in the first exchange and calibrate accordingly.';

    const instructions = buildInstructions({
      targetLanguage: langConfig.name,
      nativeLanguage: langConfig.nativeLanguage,
      userLevel: isNew ? 'beginner' : 'intermediate',
      persona: "You are a sharp, witty language tutor. Roast mistakes with charm — not cruelty. No cheerleading.",
      frontier: { state: 'balance', directive: 'Just react to what they say.', dueWords: '', newWords: '' },
      goalUpdate: levelNote,
    });

    console.log(`[Demo] Starting tutor: ${langConfig.name} (${isNew ? 'beginner' : 'experienced'})`);

    const [tutorTTS, tutorSTT] = await Promise.all([
      createTTS(langConfig),
      createSTT(langConfig),
    ]);
    if (tutorTTS instanceof elevenlabs.TTS || tutorSTT instanceof ElevenLabsRealtimeSTT) usedElevenLabs = true;
    console.log(`[Demo] Tutor TTS: ${(tutorTTS as any).label || tutorTTS.constructor.name}`);
    console.log(`[Demo] Tutor STT: ${(tutorSTT as any).label || tutorSTT.constructor.name}`);
    const agent = new voice.Agent({ instructions });
    const session = new voice.AgentSession({
      agent,
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: tutorSTT,
      llm: makeLLM(),
      tts: tutorTTS,
    });

    await session.start({
      room: ctx.room,
      agent,
      inputOptions: { participantIdentity: participant.identity },
    });

    console.log('[Demo] Tutor session started');
    await session.say(langConfig.prompts.greeting);

    // Estimated cost accrual against the global demo budget — see this
    // function's opening comment and lib/demo-budget.ts. Only ElevenLabs
    // segments cost anything; local OmniVoice/MossTTS/Qwen3-ASR are free,
    // so a session that never fell back records nothing.
    ctx.addShutdownCallback(async () => {
      if (!usedElevenLabs) return;
      try {
        const seconds = (Date.now() - sessionStartedAt) / 1000;
        const ratePerSecond = parseInt(process.env.DEMO_ELEVENLABS_MICROS_PER_SECOND || '200', 10);
        await recordDemoUsage(Math.round(seconds * ratePerSecond));
      } catch (err) {
        console.warn('[Demo] Usage accrual failed in shutdown:', String(err).slice(0, 120));
      }
    });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
