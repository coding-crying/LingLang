/**
 * Content provenance: what a source MEANS to a learner — see
 * docs/superpowers/specs/2026-08-08-content-provenance-design.md §2.
 *
 * Adding content is two separate problems, and conflating them is what
 * makes upload flows miserable:
 *
 *   1. What IS this? — kind, language, title. Answerable from the input
 *      itself almost every time (a youtube.com URL is a YouTube video; a
 *      .pdf is a textbook). The learner should not be asked.
 *
 *   2. What is it TO YOU? — have you worked through it, how far, how long
 *      ago, do you want the exercises. Unanswerable from the file. Only the
 *      learner knows, and the answers are worth real money: they're what
 *      lets placement put a day-25 Pimsleur learner at lesson 25 instead of
 *      lesson 1 (see lib/prior-knowledge.ts).
 *
 * So (1) is inferred and (2) is asked — but asked LATER. A questionnaire
 * between "I found a book" and "it's in my library" is the fastest way to
 * make someone not add the book. The source ingests immediately and lands
 * in the library greyed out, carrying an unanswered profile; the questions
 * get answered whenever the learner opens the tile, or simply in
 * conversation, because a tutor asking "how far did you get with it?" is a
 * normal thing for a tutor to say and a form is not.
 *
 * This module owns the question specs, the inference, and the normalization
 * of free-text (voice) answers into typed values. It does NOT own what
 * happens with the answers — that's reconcileSourceProgress in curriculum.ts.
 */

import type { ContentKind } from './ingest.js';

// Re-exported so consumers of the profile layer (routes, voice tools) have
// a single import site and don't have to reach into the ingestion module.
export type { ContentKind };
import type { StudyIntensity } from './prior-knowledge.js';

/** What the source is to this learner. Drives whether we seed at all. */
export type ContentIntent = 'study' | 'known' | 'aspire';

export type ProfileStatus = 'needed' | 'complete' | 'skipped';

// ── Question specs ────────────────────────────────────────────────────────

export type QuestionType = 'enum' | 'position' | 'boolean' | 'text';

export interface ProfileQuestion {
  id: string;
  /** Shown in the upload/library UI. */
  label: string;
  /** How a tutor would ask it out loud. Fed to the voice agent verbatim so
   *  the spoken and typed flows can't drift apart. */
  spoken: string;
  type: QuestionType;
  options?: { value: string; label: string }[];
  /** Unanswered required questions keep the profile 'needed' (tile greyed). */
  required: boolean;
  /** Only asked for these intents (omitted = all). */
  intents?: ContentIntent[];
  /** Only asked for these kinds (omitted = all). */
  kinds?: ContentKind[];
}

/**
 * How long ago, in coarse buckets. Buckets rather than a date picker
 * because nobody remembers the date they last opened a textbook, and the
 * seeding math doesn't need one — the difference between 20 and 25 days is
 * far inside the noise of "how much of a Pimsleur lesson sticks."
 * Each bucket carries the representative age used for backdating.
 */
export const RECENCY_BUCKETS: { value: string; label: string; days: number }[] = [
  { value: 'today', label: 'Today or yesterday', days: 1 },
  { value: 'this_week', label: 'Within the last week', days: 4 },
  { value: 'this_month', label: 'Within the last month', days: 16 },
  { value: 'few_months', label: 'A few months ago', days: 75 },
  { value: 'long_ago', label: 'Over a year ago', days: 400 },
];

export const INTENSITY_OPTIONS: { value: StudyIntensity; label: string }[] = [
  { value: 'drilled', label: 'Drilled it — repeated the exercises until they stuck' },
  { value: 'studied', label: 'Studied it properly — read it and did the work' },
  { value: 'skimmed', label: 'Went through it once' },
];

export const PROFILE_QUESTIONS: ProfileQuestion[] = [
  {
    id: 'intent',
    label: 'Where are you with this?',
    spoken: 'Have you already worked through this one, or is it something you want to get into?',
    type: 'enum',
    required: true,
    options: [
      { value: 'study', label: "I'm partway through it" },
      { value: 'known', label: "I've finished it" },
      { value: 'aspire', label: "Haven't started — I want to get to it" },
    ],
  },
  {
    id: 'known_through',
    label: 'How far did you get?',
    spoken: 'How far into it did you get?',
    type: 'position',
    required: true,
    intents: ['study'],
  },
  {
    id: 'last_studied',
    label: 'When did you last work on it?',
    spoken: 'And when did you last actually sit down with it?',
    type: 'enum',
    required: true,
    intents: ['study', 'known'],
    options: RECENCY_BUCKETS.map(({ value, label }) => ({ value, label })),
  },
  {
    id: 'intensity',
    label: 'How did you work through it?',
    spoken: 'Did you drill it properly, or more just read through it?',
    type: 'enum',
    required: true,
    intents: ['study', 'known'],
    options: INTENSITY_OPTIONS,
  },
  {
    id: 'continue_or_restart',
    label: 'Pick up where you left off, or start over?',
    spoken: 'Do you want to carry on from where you stopped, or go back over it from the start?',
    type: 'enum',
    required: false,
    intents: ['study'],
    options: [
      { value: 'continue', label: 'Carry on from where I stopped' },
      { value: 'restart', label: 'Start again from the beginning' },
    ],
  },
  {
    id: 'do_exercises',
    label: 'Include the exercises and worksheets?',
    spoken: 'Do you want me to put you through the exercises too, or just the material itself?',
    type: 'boolean',
    required: false,
    kinds: ['textbook'],
    intents: ['study', 'aspire'],
  },
  {
    id: 'depth',
    label: 'How deep do you want to go?',
    spoken: 'Are you after understanding the whole thing, or just picking up the useful phrases?',
    type: 'enum',
    required: false,
    kinds: ['youtube', 'movie', 'audio'],
    options: [
      { value: 'full', label: 'Understand all of it' },
      { value: 'phrases', label: 'Just pick up phrases' },
    ],
  },
  {
    id: 'goal',
    label: 'What do you want out of it?',
    spoken: "What's pulling you toward this one?",
    type: 'text',
    required: false,
    intents: ['aspire'],
  },
];

/** The questions that actually apply to one source, in asking order. */
export function questionsFor(kind: ContentKind, intent: ContentIntent | null): ProfileQuestion[] {
  return PROFILE_QUESTIONS.filter((q) => {
    if (q.kinds && !q.kinds.includes(kind)) return false;
    // Until intent is known, only intent itself is answerable — every other
    // question's applicability depends on it.
    if (intent === null) return q.id === 'intent';
    if (q.intents && !q.intents.includes(intent)) return false;
    return true;
  });
}

export interface ProfileAnswers {
  intent?: ContentIntent;
  /** 'all' | 'none' | { ord } | { fraction } — see resolveKnownThroughOrd. */
  known_through?: unknown;
  last_studied?: string;
  intensity?: StudyIntensity;
  continue_or_restart?: 'continue' | 'restart';
  do_exercises?: boolean;
  depth?: 'full' | 'phrases';
  goal?: string;
  [key: string]: unknown;
}

export interface ProfileEvaluation {
  status: ProfileStatus;
  /** Required question ids still unanswered, in asking order. */
  missing: string[];
  /** The next thing to ask — null when nothing is outstanding. */
  next: ProfileQuestion | null;
}

/**
 * Is this profile answered enough to reconcile? Note that 'aspire' completes
 * as soon as intent is given: there's no prior study to date or measure, so
 * asking further questions would be friction with nothing behind it.
 */
export function evaluateProfile(kind: ContentKind, answers: ProfileAnswers): ProfileEvaluation {
  const intent = (answers.intent as ContentIntent | undefined) ?? null;
  const applicable = questionsFor(kind, intent);
  const missing = applicable
    .filter((q) => q.required && !isAnswered(answers[q.id]))
    .map((q) => q.id);

  return {
    status: missing.length === 0 ? 'complete' : 'needed',
    missing,
    next: missing.length ? applicable.find((q) => q.id === missing[0]) ?? null : null,
  };
}

function isAnswered(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

// ── Resolving answers into reconciler inputs ──────────────────────────────

/** Recency bucket → the timestamp we backdate seeded cards to. */
export function resolveLastStudiedAt(bucket: string | undefined, now = new Date()): Date | null {
  const match = RECENCY_BUCKETS.find((b) => b.value === bucket);
  if (!match) return null;
  return new Date(now.getTime() - match.days * 86_400_000);
}

/**
 * "How far did you get" → a chunk ord, given how many chunks the source
 * actually has.
 *
 * Three shapes, because three different flows produce three different
 * kinds of certainty: a chunk picker in the UI gives an exact ord; a
 * learner saying "about halfway" gives a fraction; "I finished it" gives
 * 'all'. Fractions round DOWN (Math.floor) — over-claiming skips a learner
 * past material silently, under-claiming costs them one revisit.
 *
 * `chunkCount` is the source's chunk count; ords are 0-based, so the
 * returned value is the ord of the LAST chunk they've already done, and
 * null means "none of it."
 */
export function resolveKnownThroughOrd(value: unknown, chunkCount: number): number | null {
  if (chunkCount <= 0) return null;
  const maxOrd = chunkCount - 1;

  if (value === 'all') return maxOrd;
  if (value === 'none' || value === undefined || value === null) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // A bare number is an ord when it's in range. Fractions arrive as
    // { fraction } — a plain 0.5 here would be ord 0, which is what a
    // caller passing an index means.
    return clampOrd(Math.floor(value), maxOrd);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.ord === 'number' && Number.isFinite(obj.ord)) {
      return clampOrd(Math.floor(obj.ord), maxOrd);
    }
    if (typeof obj.fraction === 'number' && Number.isFinite(obj.fraction)) {
      const f = Math.max(0, Math.min(1, obj.fraction));
      if (f <= 0) return null;
      return clampOrd(Math.floor(f * chunkCount) - 1, maxOrd);
    }
    // "I did the first 25 lessons" — a count, not an index. Off by one
    // from `ord` and worth keeping distinct rather than making the caller
    // remember which one the API wanted.
    if (typeof obj.count === 'number' && Number.isFinite(obj.count)) {
      const c = Math.floor(obj.count);
      if (c <= 0) return null;
      return clampOrd(c - 1, maxOrd);
    }
  }

  return null;
}

function clampOrd(ord: number, maxOrd: number): number | null {
  if (!Number.isFinite(ord) || ord < 0) return null;
  return Math.min(ord, maxOrd);
}

// ── Inference: what IS this thing ─────────────────────────────────────────

export interface InferredSource {
  kind: ContentKind;
  title: string;
  /** Only set when the input itself names a language; otherwise the caller's
   *  current target language wins. */
  language?: string;
  /** How we got here — surfaced in the UI so a wrong guess is visibly a
   *  guess and not a decision the learner has to hunt for. */
  via: 'url' | 'extension' | 'llm' | 'default';
  confidence: 'high' | 'low';
}

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'];
const EXTENSION_KINDS: Record<string, ContentKind> = {
  '.pdf': 'textbook', '.epub': 'textbook', '.djvu': 'textbook',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio', '.aac': 'audio',
  '.srt': 'movie', '.vtt': 'movie', '.ass': 'movie',
  '.txt': 'text', '.md': 'text',
};

/**
 * Deterministic first. The rules below cover essentially every real input
 * (a URL or a filename), cost nothing, and never surprise anyone; the LLM
 * exists for the leftovers — bare titles like "Pimsleur Spanish 1" or
 * "that Rosalía song" — where there is genuinely nothing to parse.
 *
 * Returns null when the rules don't fire, so callers can decide whether the
 * LLM round-trip is worth it (inferSource does; a fast UI hint may not).
 */
export function inferSourceByRule(input: string): InferredSource | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    let host = '';
    try {
      host = new URL(trimmed).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (YOUTUBE_HOSTS.includes(host)) {
      return { kind: 'youtube', title: trimmed, via: 'url', confidence: 'high' };
    }
    const ext = extensionOf(new URL(trimmed).pathname);
    if (ext && EXTENSION_KINDS[ext]) {
      return { kind: EXTENSION_KINDS[ext], title: basename(trimmed), via: 'extension', confidence: 'high' };
    }
    // Some other web page. No fetch path exists for arbitrary URLs (see
    // ingest.ts's extractText), so this is deliberately NOT guessed into a
    // kind that would fail at ingest time — let the LLM or the learner say.
    return null;
  }

  const ext = extensionOf(trimmed);
  if (ext && EXTENSION_KINDS[ext]) {
    return { kind: EXTENSION_KINDS[ext], title: basename(trimmed), via: 'extension', confidence: 'high' };
  }

  // Multi-line or long input is pasted content, not a reference to
  // something. 'text' takes the body verbatim as its ref.
  if (trimmed.includes('\n') || trimmed.length > 200) {
    return { kind: 'text', title: firstLine(trimmed), via: 'default', confidence: 'high' };
  }

  return null;
}

function extensionOf(s: string): string | null {
  const m = /(\.[a-z0-9]{2,5})$/i.exec(s.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

function basename(s: string): string {
  const cleaned = s.split(/[?#]/)[0] ?? s;
  const last = cleaned.split('/').filter(Boolean).pop() ?? cleaned;
  return last.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim() || cleaned;
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? s;
  return line.trim().slice(0, 80);
}

// ── LLM fallback ──────────────────────────────────────────────────────────

/**
 * One schema-constrained call to the same cheap cloud model the ingestion
 * pipeline distills with (CONVERSATION_LLM_*).
 *
 * The request/response shape is duplicated from ingest.ts's distillChunk
 * rather than shared: it's ~15 lines, and factoring it out would put a
 * shared dependency in the path of the live ingestion pipeline for the
 * benefit of a fallback that fires on a minority of inputs. Revisit if a
 * third caller appears.
 */
async function callStructuredLLM<T>(prompt: string, schema: object, name: string, maxTokens = 400): Promise<T | null> {
  const url = process.env.CONVERSATION_LLM_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.CONVERSATION_LLM_MODEL || 'google/gemma-4-26b-a4b-it';
  const key = process.env.CONVERSATION_LLM_KEY || '';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  try {
    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name, schema } },
      }),
    });
    if (!response.ok) {
      console.warn(`[ContentProfile] ${name} call failed: HTTP ${response.status}`);
      return null;
    }
    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content;
    return content ? JSON.parse(content) as T : null;
  } catch (err) {
    // Every caller has a usable fallback, so a model outage degrades the
    // experience (one extra question) instead of blocking the upload.
    console.warn(`[ContentProfile] ${name} call errored:`, err);
    return null;
  }
}

/**
 * Full inference: rules, then the model, then a safe default.
 *
 * Never throws and never returns null — adding content must not be
 * blockable by a classification failure. The worst case is kind 'text'
 * flagged low-confidence, which the UI shows as an editable guess.
 */
export async function inferSource(input: string, fallbackTitle?: string): Promise<InferredSource> {
  const byRule = inferSourceByRule(input);
  if (byRule) return byRule;

  const guess = await callStructuredLLM<{ kind: string; title: string; language?: string }>(
    `Classify what kind of language-learning material this reference points to. Return JSON only.

Reference: """${input.slice(0, 400)}"""

kind must be exactly one of:
- "youtube" — a YouTube video, or a song/clip most easily found on YouTube
- "movie" — a film or TV episode (subtitles would be the text)
- "textbook" — a book, coursebook, workbook or PDF
- "audio" — an audio course or recording (Pimsleur, Michel Thomas, a podcast)
- "text" — pasted prose, an article, lyrics, or anything else

title: a short human-readable name, 60 characters or fewer.
language: the ISO 639-1 code of the language being LEARNED, only if the reference states or strongly implies it. Omit otherwise.`,
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['youtube', 'movie', 'textbook', 'audio', 'text'] },
        title: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['kind', 'title'],
    },
    'source_inference',
  );

  if (guess?.kind && ['youtube', 'movie', 'textbook', 'audio', 'text'].includes(guess.kind)) {
    return {
      kind: guess.kind as ContentKind,
      title: (guess.title || fallbackTitle || input).slice(0, 80),
      language: guess.language,
      via: 'llm',
      // Low regardless: the model saw a bare string with no content behind
      // it. The UI should present this as a guess, not a determination.
      confidence: 'low',
    };
  }

  return {
    kind: 'text',
    title: (fallbackTitle || firstLine(input)).slice(0, 80),
    via: 'default',
    confidence: 'low',
  };
}

/**
 * Parse a spoken answer into a typed value.
 *
 * This is what lets the tutor collect the profile in conversation. A
 * learner says "yeah I got through about the first twenty-five lessons,
 * finished the last one maybe three weeks back" — one utterance carrying
 * three answers, in no particular order, in no particular format. Rules
 * handle the unambiguous cases (a bare number, an obvious yes/no); the
 * model handles the rest.
 *
 * Returns only the fields it is confident about, so a partial parse
 * advances the profile rather than discarding the turn.
 */
export async function normalizeSpokenAnswers(
  utterance: string,
  pending: ProfileQuestion[],
  chunkCount: number,
): Promise<ProfileAnswers> {
  if (!utterance.trim() || pending.length === 0) return {};

  const askable = pending.map((q) => {
    if (q.id === 'known_through') {
      return `- known_through: how far they got. Return {"count": N} for "the first N lessons/chapters", {"fraction": F} for a proportion like "about half" (F between 0 and 1), or "all" / "none". The source has ${chunkCount} sections.`;
    }
    const opts = q.options ? ` One of: ${q.options.map((o) => o.value).join(', ')}.` : '';
    const type = q.type === 'boolean' ? ' true or false.' : q.type === 'text' ? ' A short string.' : '';
    return `- ${q.id}: ${q.label}${opts}${type}`;
  }).join('\n');

  const parsed = await callStructuredLLM<ProfileAnswers>(
    `A language learner was asked about study material they added. Extract ONLY the fields their reply actually answers. Omit anything they did not address — do not guess, and do not fill a field just because it was asked.

Their reply: """${utterance.slice(0, 600)}"""

Fields:
${askable}

For last_studied, map to the closest bucket: ${RECENCY_BUCKETS.map((b) => `${b.value} (${b.label})`).join(', ')}.`,
    {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['study', 'known', 'aspire'] },
        known_through: {
          oneOf: [
            { type: 'string', enum: ['all', 'none'] },
            { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
            { type: 'object', properties: { fraction: { type: 'number' } }, required: ['fraction'] },
          ],
        },
        last_studied: { type: 'string', enum: RECENCY_BUCKETS.map((b) => b.value) },
        intensity: { type: 'string', enum: ['drilled', 'studied', 'skimmed'] },
        continue_or_restart: { type: 'string', enum: ['continue', 'restart'] },
        do_exercises: { type: 'boolean' },
        depth: { type: 'string', enum: ['full', 'phrases'] },
        goal: { type: 'string' },
      },
    },
    'profile_answers',
    300,
  );

  if (!parsed) return {};

  // Only fields that were actually asked for — the model is capable of
  // volunteering an `intent` when intent wasn't in `pending`, which would
  // silently overwrite an answer the learner already gave.
  const allowed = new Set(pending.map((q) => q.id));
  const result: ProfileAnswers = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (allowed.has(k) && v !== undefined && v !== null) result[k] = v;
  }
  return result;
}
