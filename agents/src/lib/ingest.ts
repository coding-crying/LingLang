/**
 * Curriculum ingestion pipeline — see
 * docs/superpowers/specs/2026-07-06-curriculum-design.md §2.
 *
 * Five stages, each independently callable and testable:
 *   extractText   — kind-specific raw text acquisition
 *   segmentText   — split into ~500-1500 token chunks on structural boundaries
 *   distillChunk  — one schema-constrained cloud LLM call per chunk
 *   linkChunkVocab — dictionary-gated lexeme resolution + chunk_lexemes write
 *   embedChunk    — BGE-M3 embedding for the chunk
 *
 * Runs offline, outside the live session loop — none of this touches
 * latency-sensitive code. Anti-hallucination rules carried over from the
 * live loop: schema-constrained decoding, hard per-chunk caps, the same
 * dictionary gate the processor uses, log-don't-silently-drop.
 */

import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contentSources, contentChunks, chunkLexemes, lexemes } from '../db/schema.js';
import { embedText, lexemeEmbedText } from './embedding.js';
import { passesDictionaryGate } from './dictionary.js';
import { transcribeAudioWithLocalLLM } from '../tools/supervisor-functions.js';

export type ContentKind = 'text' | 'textbook' | 'audio' | 'youtube' | 'movie';

// 'textbook'/'audio' `ref` reaches here straight from the authenticated (not
// admin-gated) POST /api/content-sources body — never trust it as a raw
// filesystem path. Resolve it under this fixed directory only; no upload
// flow writes here yet, so these two kinds are effectively inert until one
// does, rather than an arbitrary-file-read vector.
const UPLOAD_DIR = process.env.INGEST_UPLOAD_DIR || path.join(process.cwd(), 'uploads');

async function resolveUploadPath(ref: string): Promise<string> {
  // path.basename strips any directory component (including `..`), so the
  // join below can't escape UPLOAD_DIR by construction; realpath then also
  // rejects a symlink inside UPLOAD_DIR that points back out of it.
  const base = await realpath(UPLOAD_DIR);
  const candidate = path.join(base, path.basename(ref));
  const real = await realpath(candidate);
  if (real !== candidate && !real.startsWith(base + path.sep)) {
    throw new Error('ref resolves outside the uploads directory');
  }
  return candidate;
}

// ── Stage 1: extract ─────────────────────────────────────────────────────

/**
 * Kind-specific raw text acquisition. Returns the full source text —
 * segmentation (stage 2) does the chaptering/chunking.
 */
export async function extractText(kind: ContentKind, ref: string, language = 'en'): Promise<string> {
  switch (kind) {
    case 'text':
      // `ref` IS the content here (the frontend's "text" kind is a paste-in
      // textarea, not a file picker) — never treat it as a filesystem path.
      return ref;

    case 'textbook': {
      // pdf-parse v2: class-based API (PDFParse), not a default-export
      // function — pure-JS PDF text extraction, no system deps.
      const { PDFParse } = await import('pdf-parse');
      const buf = await readFile(await resolveUploadPath(ref));
      const parser = new PDFParse({ data: buf });
      try {
        const result = await parser.getText();
        return result.text;
      } finally {
        await parser.destroy();
      }
    }

    case 'audio': {
      // Reuse the cascade's own transcription pass (buildTranscriptionOnlyPrompt
      // + transcribeAudioWithLocalLLM) — same model, same lean prompt that
      // already proved reliable in the live conversation cascade. For a
      // single short clip this is one call; long files need windowing into
      // ~30s segments with overlap (design doc §2 step 1) — not yet
      // implemented here, tracked as a follow-up once a long real file is
      // available to test windowing boundaries against.
      const audioPath = await resolveUploadPath(ref);
      const audioBuf = await readFile(audioPath);
      const mime = audioPath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
      const dataUri = `data:${mime};base64,${audioBuf.toString('base64')}`;
      const historyMessages = [{
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this audio clip.' },
          { type: 'audio_url', audio_url: { url: dataUri } },
        ],
      }];
      const llmUrl = process.env.LOCAL_LLM_URL || 'http://localhost:8093/v1';
      const llmModel = process.env.LOCAL_LLM_MODEL || 'gemma4-12b-it-qat';
      const llmKey = process.env.LOCAL_LLM_KEY || '';
      // Language names are only used for the "may code-switch" framing in
      // the transcription prompt — ingestion doesn't know the native
      // language of a future learner, so this is a best-effort default.
      const transcript = await transcribeAudioWithLocalLLM(historyMessages, llmUrl, llmModel, llmKey, 'the target language', 'English');
      if (!transcript) throw new Error(`Transcription returned empty for ${ref}`);
      return transcript;
    }

    case 'youtube': {
      // Primary path: YouTubeTranscript hits YouTube's own timedtext API
      // directly (no system binary, no download) — works for any video with
      // captions (manual or auto-generated). Falls back to yt-dlp (subtitle
      // download, then audio+cascade-transcription) only if that fails,
      // since yt-dlp is a system binary that may not be installed.
      const videoId = extractYoutubeId(ref);
      if (!videoId) throw new Error(`Could not parse a YouTube video ID out of "${ref}"`);

      try {
        const { YoutubeTranscript } = await import('youtube-transcript');
        const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: language }).catch(() =>
          YoutubeTranscript.fetchTranscript(videoId),
        );
        const text = segments.map((s) => s.text).join(' ').replace(/\s{2,}/g, ' ').trim();
        if (!text) throw new Error('transcript came back empty');
        return text;
      } catch (transcriptErr) {
        console.warn(`[Ingest] youtube-transcript failed (${String(transcriptErr).slice(0, 150)}), trying yt-dlp fallback...`);
      }

      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      try {
        // Pass the already-validated videoId, not raw ref — ref is
        // attacker-controlled (POST /api/content-sources body) and a bare
        // positional argv value starting with `-` could be parsed as a
        // yt-dlp flag (e.g. --exec) instead of a URL. The `--` separator is
        // defense in depth on top of that.
        await execFileAsync('yt-dlp', ['--write-auto-sub', '--skip-download', '--sub-format', 'vtt', '-o', '/tmp/yt-ingest.%(ext)s', '--', videoId]);
        const vtt = await readFile('/tmp/yt-ingest.en.vtt', 'utf-8').catch(() => readFile('/tmp/yt-ingest.vtt', 'utf-8'));
        return vtt.replace(/^WEBVTT[\s\S]*?\n\n/, '').replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> .*\n/g, '').replace(/\n{2,}/g, '\n').trim();
      } catch (err) {
        throw new Error(`No captions available via YouTube's transcript API, and yt-dlp fallback failed (is yt-dlp installed?): ${String(err).slice(0, 200)}`);
      }
    }

    case 'movie': {
      const srt = await fetchOpenSubtitlesSrt(ref, language);
      // Strip SRT sequence numbers and timestamp lines, collapse blank lines.
      return srt
        .replace(/^\d+\r?\n/gm, '')
        .replace(/\d{2}:\d{2}:\d{2}[,.]\d{3} --> .*\r?\n/g, '')
        .replace(/\r/g, '')
        .replace(/\n{2,}/g, '\n')
        .trim();
    }
  }
}

/**
 * OpenSubtitles REST API v1 — ref is a free-text movie title (e.g. "The
 * Matrix 1999"). Requires a free OpenSubtitles.com API consumer key
 * (Settings > API Consumers on their site) in OPENSUBTITLES_API_KEY.
 * Factored out of extractText's `movie` case so extractTimedSegments can
 * reuse the same fetch and parse timestamps out of the same raw SRT
 * instead of the already-stripped plain text.
 */
async function fetchOpenSubtitlesSrt(ref: string, language: string): Promise<string> {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) {
    throw new Error('OPENSUBTITLES_API_KEY is not set — register a free API consumer at opensubtitles.com and set it to enable movie ingestion.');
  }
  const headers = {
    'Api-Key': apiKey,
    'User-Agent': 'LingLang v1.0',
    'Content-Type': 'application/json',
  };

  const searchUrl = `https://api.opensubtitles.com/api/v1/subtitles?${new URLSearchParams({ query: ref, languages: language })}`;
  const searchRes = await fetch(searchUrl, { headers });
  if (!searchRes.ok) throw new Error(`OpenSubtitles search failed: HTTP ${searchRes.status} ${(await searchRes.text()).slice(0, 200)}`);
  const searchData = await searchRes.json() as any;
  const best = searchData.data?.[0];
  const fileId = best?.attributes?.files?.[0]?.file_id;
  if (!fileId) throw new Error(`No OpenSubtitles results for "${ref}" in language "${language}"`);

  const downloadRes = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!downloadRes.ok) throw new Error(`OpenSubtitles download request failed: HTTP ${downloadRes.status} ${(await downloadRes.text()).slice(0, 200)}`);
  const downloadData = await downloadRes.json() as any;
  if (!downloadData.link) throw new Error('OpenSubtitles download response had no link');

  const srtRes = await fetch(downloadData.link);
  if (!srtRes.ok) throw new Error(`Fetching subtitle file failed: HTTP ${srtRes.status}`);
  return srtRes.text();
}

// ── Timed extraction (stage 1b) — youtube/movie only ───────────────────────

export interface TimedSegment {
  text: string;
  startSec: number;
  endSec: number;
}

function srtTimeToSec(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/** Parses SRT (`,` ms separator) or WebVTT (`.` ms separator) — same block
 *  shape otherwise (index line optional, "start --> end", then text). */
export function parseSubtitleTimestamps(raw: string): TimedSegment[] {
  const blocks = raw.replace(/\r/g, '').trim().split(/\n{2,}/);
  const cueRe = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;
  const segments: TimedSegment[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const cueLine = lines.find((l) => cueRe.test(l));
    if (!cueLine) continue;
    const m = cueLine.match(cueRe);
    if (!m) continue;
    const startSec = srtTimeToSec(m[1]!, m[2]!, m[3]!, m[4]!);
    const endSec = srtTimeToSec(m[5]!, m[6]!, m[7]!, m[8]!);
    const textLines = lines.slice(lines.indexOf(cueLine) + 1).filter((l) => l.trim());
    const text = textLines.join(' ').replace(/<[^>]+>/g, '').trim();
    if (text) segments.push({ text, startSec, endSec });
  }
  return segments;
}

/**
 * youtube-transcript's TranscriptResponse.offset/duration are NOT
 * consistently unit'd — the srv3 XML branch it parses gives milliseconds,
 * the classic-format fallback branch gives seconds, and the library
 * exposes no flag saying which path was hit (checked the installed
 * package's source directly, both branches map straight into the same
 * field names). Caption duration is a robust unit signal regardless of
 * video length (bounded by reading speed, typically 1-6s): if the median
 * duration looks like whole seconds we're already in seconds, if it's in
 * the hundreds/thousands we're in milliseconds.
 */
function normalizeYoutubeOffsets(
  segments: { text: string; offset: number; duration: number }[],
): TimedSegment[] {
  const durations = segments.map((s) => s.duration).filter((d) => d > 0).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  const isMs = median > 50;
  const div = isMs ? 1000 : 1;
  return segments
    .filter((s) => s.text.trim())
    .map((s) => ({ text: s.text.trim(), startSec: s.offset / div, endSec: (s.offset + s.duration) / div }));
}

/**
 * Timed counterpart to extractText, for kinds that carry real timing
 * (youtube captions, movie subtitles) — returns null for everything else
 * so callers fall back to the flat extractText + segmentText path.
 * Throws (rather than returning null) on a genuine extraction failure so
 * the caller's error message stays as specific as extractText's own.
 */
export async function extractTimedSegments(kind: ContentKind, ref: string, language: string): Promise<TimedSegment[] | null> {
  if (kind === 'movie') {
    const srt = await fetchOpenSubtitlesSrt(ref, language);
    return parseSubtitleTimestamps(srt);
  }

  if (kind === 'youtube') {
    const videoId = extractYoutubeId(ref);
    if (!videoId) throw new Error(`Could not parse a YouTube video ID out of "${ref}"`);

    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const raw = await YoutubeTranscript.fetchTranscript(videoId, { lang: language }).catch(() =>
        YoutubeTranscript.fetchTranscript(videoId),
      );
      const segments = normalizeYoutubeOffsets(raw);
      if (segments.length === 0) throw new Error('transcript came back empty');
      return segments;
    } catch (transcriptErr) {
      console.warn(`[Ingest] Timed youtube-transcript failed (${String(transcriptErr).slice(0, 150)}), trying yt-dlp fallback...`);
    }

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('yt-dlp', ['--write-auto-sub', '--skip-download', '--sub-format', 'vtt', '-o', '/tmp/yt-ingest.%(ext)s', '--', videoId]);
    const vtt = await readFile('/tmp/yt-ingest.en.vtt', 'utf-8').catch(() => readFile('/tmp/yt-ingest.vtt', 'utf-8'));
    return parseSubtitleTimestamps(vtt);
  }

  return null;
}

export function formatTimeRange(startSec: number, endSec: number): string {
  const fmt = (sec: number) => {
    const total = Math.round(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  return `${fmt(startSec)}-${fmt(endSec)}`;
}

function extractYoutubeId(ref: string): string | null {
  if (/^[\w-]{11}$/.test(ref)) return ref; // already a bare video ID
  try {
    const url = new URL(ref);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1) || null;
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const shortMatch = url.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/);
    if (shortMatch) return shortMatch[1] ?? null;
  } catch {
    // not a URL — fall through
  }
  return null;
}

// ── Stage 2: segment ─────────────────────────────────────────────────────

export interface RawChunk {
  ord: number;
  parentTitle: string | null;
  title: string;
  body: string;
  /** Only set when produced by segmentTimedText (youtube/movie). */
  startSec?: number;
  endSec?: number;
}

const TARGET_CHUNK_TOKENS_MIN = 500;
const TARGET_CHUNK_TOKENS_MAX = 1500;
// Rough tokens-per-word for the languages we ingest — good enough for a
// chunking heuristic, not used for anything that needs precision.
const WORDS_PER_TOKEN = 0.75;

function estimateTokens(text: string): number {
  return Math.round(text.split(/\s+/).filter(Boolean).length / WORDS_PER_TOKEN);
}

/**
 * Split on structural boundaries (markdown/plain headings, "Chapter N",
 * numbered sections) when present, then merge/split paragraph-wise to hit
 * the target token range. Falls back to pure paragraph merging when no
 * heading structure is detected (e.g. a transcript). Never splits
 * mid-paragraph — a paragraph is the smallest unit, so a single huge
 * paragraph can still produce an oversized chunk (logged, not silently
 * truncated — truncating mid-thought would corrupt the distillation input).
 */
export function segmentText(text: string): RawChunk[] {
  const headingRe = /^(?:#{1,3}\s+.+|chapter\s+\d+.*|unit\s+\d+.*|lesson\s+\d+.*)$/im;
  const lines = text.split(/\r?\n/);
  const sections: { title: string; body: string }[] = [];
  let currentTitle = 'Untitled';
  let currentLines: string[] = [];

  const flush = () => {
    const body = currentLines.join('\n').trim();
    if (body) sections.push({ title: currentTitle, body });
    currentLines = [];
  };

  let sawHeading = false;
  for (const line of lines) {
    if (headingRe.test(line.trim())) {
      sawHeading = true;
      flush();
      currentTitle = line.trim().replace(/^#{1,3}\s+/, '');
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // No headings detected at all — whole text is one section; the
  // paragraph-merge pass below does the actual chunking.
  const workingSections = sawHeading ? sections : [{ title: 'Untitled', body: text }];

  const chunks: RawChunk[] = [];
  let ord = 0;
  for (const section of workingSections) {
    const paragraphs = section.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let buf: string[] = [];
    let bufTokens = 0;
    let partIdx = 0;

    const flushChunk = () => {
      if (buf.length === 0) return;
      partIdx++;
      const title = sawHeading && partIdx > 1 ? `${section.title} (part ${partIdx})` : section.title;
      chunks.push({ ord: ord++, parentTitle: sawHeading ? section.title : null, title, body: buf.join('\n\n') });
      buf = [];
      bufTokens = 0;
    };

    for (const para of paragraphs) {
      const paraTokens = estimateTokens(para);
      if (bufTokens > 0 && bufTokens + paraTokens > TARGET_CHUNK_TOKENS_MAX) {
        flushChunk();
      }
      buf.push(para);
      bufTokens += paraTokens;
      if (bufTokens >= TARGET_CHUNK_TOKENS_MIN && bufTokens >= TARGET_CHUNK_TOKENS_MAX * 0.7) {
        flushChunk();
      }
    }
    flushChunk();
  }

  for (const c of chunks) {
    const tokens = estimateTokens(c.body);
    if (tokens > TARGET_CHUNK_TOKENS_MAX * 1.5) {
      console.warn(`[Ingest] Chunk "${c.title}" is ${tokens} est. tokens — a single paragraph exceeded the target range and was not split (never splits mid-paragraph).`);
    }
  }

  return chunks;
}

/**
 * Time-aware counterpart to segmentText, for youtube/movie sources —
 * merges consecutive caption/subtitle segments (never splitting one) until
 * the same token target is hit, same as the paragraph-merge pass above.
 * Each resulting chunk's title is the caption time range ("12:30-15:00")
 * rather than a heading, since transcripts have no chapter structure —
 * that range is what makes manual chunk navigation actually usable for
 * video content (see GET /api/content-sources/:id/chunks).
 */
export function segmentTimedText(segments: TimedSegment[]): RawChunk[] {
  const chunks: RawChunk[] = [];
  let ord = 0;
  let buf: TimedSegment[] = [];
  let bufTokens = 0;

  const flushChunk = () => {
    if (buf.length === 0) return;
    const startSec = buf[0]!.startSec;
    const endSec = buf[buf.length - 1]!.endSec;
    chunks.push({
      ord: ord++,
      parentTitle: null,
      title: formatTimeRange(startSec, endSec),
      body: buf.map((s) => s.text).join(' '),
      startSec,
      endSec,
    });
    buf = [];
    bufTokens = 0;
  };

  for (const seg of segments) {
    const segTokens = estimateTokens(seg.text);
    if (bufTokens > 0 && bufTokens + segTokens > TARGET_CHUNK_TOKENS_MAX) {
      flushChunk();
    }
    buf.push(seg);
    bufTokens += segTokens;
    if (bufTokens >= TARGET_CHUNK_TOKENS_MIN && bufTokens >= TARGET_CHUNK_TOKENS_MAX * 0.7) {
      flushChunk();
    }
  }
  flushChunk();

  return chunks;
}

// ── Stage 3: distill ─────────────────────────────────────────────────────

export interface DistilledVocabItem {
  lemma: string;
  pos: string;
  translation: string;
  salience: number;
}

export interface DistilledChunk {
  summary: string;
  card: string;
  vocab: DistilledVocabItem[];
  grammarPoints: { rule: string; example: string; explanation: string }[];
  difficulty: string;
}

const MAX_VOCAB_PER_CHUNK = 12;
const MAX_GRAMMAR_POINTS = 3;
// 2026-07-07: dropped from 200 to 60 after real-audio testing. The
// original multi-field format (Topic:/Phrases:/Vocab:/Grammar: block)
// reproducibly broke the local 12B's audio attention regardless of
// wording around it — isolated via a length-matched non-topical filler
// control that survived at the SAME token count, proving it wasn't a
// budget problem. A follow-up test of several alternative framings found
// two survived (2/2 real-audio each): a short, single-clause instruction
// with explicit "if it fits"/optional conditioning. A flat vocab list
// WITHOUT that conditional framing still failed at a similar length — the
// framing, not the length, is what matters, but shorter also means less
// surface area for a directive-sounding phrase to creep back in. `card`
// is now a plain teaching instruction (frontier.directive/grammarHints
// pattern, not a structured block) capped accordingly.
const CARD_MAX_TOKENS = 60;

function buildDistillSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      card: { type: 'string' },
      vocab: {
        type: 'array',
        maxItems: MAX_VOCAB_PER_CHUNK,
        items: {
          type: 'object',
          properties: {
            lemma: { type: 'string' },
            pos: { type: 'string' },
            translation: { type: 'string' },
            salience: { type: 'number' },
          },
          required: ['lemma', 'pos', 'translation', 'salience'],
        },
      },
      grammarPoints: {
        type: 'array',
        maxItems: MAX_GRAMMAR_POINTS,
        items: {
          type: 'object',
          properties: {
            rule: { type: 'string' },
            example: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['rule', 'example'],
        },
      },
      difficulty: { type: 'string', enum: ['pre_a1', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2'] },
    },
    required: ['summary', 'card', 'vocab', 'difficulty'],
  } as const;
}

function buildDistillPrompt(language: string, title: string, body: string): string {
  return `You are distilling one chapter/section of a ${language} learning source into structured teaching material. Return JSON only.

Title: ${title}
Text:
"""
${body}
"""

Produce:
- summary: 2-3 sentences, for a teaching planner's own reference (not shown to the learner).
- card: ONE short teaching instruction for a conversation partner, STRICT MAXIMUM ${CARD_MAX_TOKENS} tokens (~${Math.round(CARD_MAX_TOKENS * 0.75)} words). Not a lesson outline, not a topic header — a single plain sentence, phrased as optional/conditional (e.g. "If it fits naturally, work in <2-3 words from the text> — they're studying <one-clause topic>"). Never a directive that reads as "the topic for this turn is X." Example of the right shape: "If it fits naturally, weave in яблоко, банан, and сколько стоит — they're studying buying fruit at a market."
- vocab: up to ${MAX_VOCAB_PER_CHUNK} of the MOST central words in this text (not every word — pick by importance to the chapter's topic). salience 0-1, how central each word is.
- grammarPoints: up to ${MAX_GRAMMAR_POINTS} grammar points actually demonstrated in this text, each with one real example FROM the text.
- difficulty: your best CEFR estimate for this material.

Only extract words/phrases that actually appear in the text. Do not invent vocabulary or examples not present in the source.`;
}

/**
 * One schema-constrained call to the cloud model (26B-A4B via
 * CONVERSATION_LLM_* — cheap, no VRAM cost, no session latency budget).
 * Same anti-hallucination posture as the live processor: constrained
 * decoding + hard caps, never "trust the model to self-limit."
 */
export async function distillChunk(language: string, title: string, body: string): Promise<DistilledChunk> {
  const url = process.env.CONVERSATION_LLM_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.CONVERSATION_LLM_MODEL || 'google/gemma-4-26b-a4b-it';
  const key = process.env.CONVERSATION_LLM_KEY || '';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const response = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildDistillPrompt(language, title, body) }],
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: 'json_schema', json_schema: { name: 'chunk_distillation', schema: buildDistillSchema() } },
    }),
  });

  if (!response.ok) {
    throw new Error(`Distillation call failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Distillation call returned empty content');

  const parsed = JSON.parse(content) as DistilledChunk;
  parsed.vocab = (parsed.vocab || []).slice(0, MAX_VOCAB_PER_CHUNK);
  parsed.grammarPoints = (parsed.grammarPoints || []).slice(0, MAX_GRAMMAR_POINTS);

  // Card token budget is a hard rule (design doc §3 — the conversation
  // prompt has ~300-500 tokens of headroom under the 12B's audio-attention
  // ceiling). One retry with an explicit trim instruction, then truncate
  // and log — never silently ship an oversized card.
  if (estimateTokens(parsed.card) > CARD_MAX_TOKENS * 1.3) {
    console.warn(`[Ingest] Card for "${title}" is ~${estimateTokens(parsed.card)} est. tokens (budget ${CARD_MAX_TOKENS}) — truncating.`);
    const words = parsed.card.split(/\s+/);
    parsed.card = words.slice(0, Math.round(CARD_MAX_TOKENS * 0.75)).join(' ') + ' […]';
  }

  return parsed;
}

// ── Stage 4: link ─────────────────────────────────────────────────────────

/**
 * Resolve one distilled vocab item to a lexeme row, creating it if
 * missing. Dictionary-gated exactly like the processor's own lexeme
 * creation path (lib/dictionary.ts) — a hallucinated word in a textbook
 * scan is blocked the same way a hallucinated word in speech is.
 * Unresolvable items are dropped and logged, never force-created.
 */
async function findOrCreateLexeme(lemma: string, pos: string, language: string, translation: string): Promise<string | null> {
  const gated = await passesDictionaryGate(lemma, lemma, language);
  if (gated === false) {
    console.warn(`[Ingest] Dropping non-dictionary word "${lemma}" (${language}) — failed the dictionary gate.`);
    return null;
  }

  const existing = await db.query.lexemes.findFirst({
    where: and(eq(lexemes.lemma, lemma), eq(lexemes.language, language)),
  });
  if (existing) return existing.id;

  const embedding = await embedText(lexemeEmbedText(lemma, language, translation));
  const id = `${language}:${lemma}:${pos}:${randomUUID().slice(0, 8)}`;
  await db.insert(lexemes).values({
    id,
    lemma,
    pos,
    language,
    translation,
    embedding: embedding.length > 0 ? embedding : null,
  });
  return id;
}

export async function linkChunkVocab(chunkId: string, language: string, vocab: DistilledVocabItem[]): Promise<number> {
  let linked = 0;
  for (const item of vocab) {
    if (!item.lemma?.trim()) continue;
    const lexemeId = await findOrCreateLexeme(item.lemma.trim(), item.pos || 'X', language, item.translation || '');
    if (!lexemeId) continue;
    await db.insert(chunkLexemes).values({
      chunkId,
      lexemeId,
      salience: Math.max(0, Math.min(1, item.salience ?? 0.5)),
    }).onConflictDoNothing();
    linked++;
  }
  return linked;
}

// ── Stage 5: embed ────────────────────────────────────────────────────────

export async function embedChunk(chunkId: string, body: string): Promise<void> {
  const embedding = await embedText(body.slice(0, 4000)); // embedding services have their own input caps
  if (embedding.length === 0) {
    console.warn(`[Ingest] Chunk ${chunkId} embedding came back empty — left null, not blocking ingestion on it.`);
    return;
  }
  await db.update(contentChunks).set({ embedding }).where(eq(contentChunks.id, chunkId));
}

// ── Orchestration ─────────────────────────────────────────────────────────

export interface IngestOptions {
  sourceId: string;
  ownerId?: string;
  language: string;
  kind: ContentKind;
  title: string;
  ref: string;
}

/**
 * Runs all five stages against a new source. Idempotent at the
 * content_sources.status level — a failed run leaves status='failed' with
 * ingestError set, so a retry can be triggered by the caller without this
 * function needing its own resume logic (chunks already inserted for a
 * partially-completed run are left as-is; re-running would duplicate them,
 * so a real retry path is future work — fine for a single-shot v1 script).
 */
export async function ingestSource(opts: IngestOptions): Promise<{ chunkCount: number }> {
  await db.insert(contentSources).values({
    id: opts.sourceId,
    ownerId: opts.ownerId ?? null,
    language: opts.language,
    kind: opts.kind,
    title: opts.title,
    originalRef: opts.ref,
    status: 'ingesting',
  }).onConflictDoUpdate({ target: contentSources.id, set: { status: 'ingesting' } });

  try {
    console.log(`[Ingest] Extracting (${opts.kind}) from ${opts.ref}...`);

    // Timed sources (youtube/movie) get real time-range chunk titles —
    // "12:30-15:00" instead of "Untitled (part N)" — since transcripts
    // have no chapter-heading structure for segmentText to key off. Falls
    // back to the flat extractText + segmentText path on any failure here
    // (including "this kind has no timing," which returns null rather
    // than throwing) so a parsing edge case in the timed path never blocks
    // ingestion outright.
    let rawChunks: RawChunk[] | null = null;
    try {
      const timed = await extractTimedSegments(opts.kind, opts.ref, opts.language);
      if (timed && timed.length > 0) {
        rawChunks = segmentTimedText(timed);
        console.log(`[Ingest] Timed-segmented into ${rawChunks.length} chunk(s) with time ranges.`);
      }
    } catch (timedErr) {
      console.warn(`[Ingest] Timed extraction failed (${String(timedErr).slice(0, 150)}), falling back to flat text.`);
    }

    if (!rawChunks) {
      const text = await extractText(opts.kind, opts.ref, opts.language);
      console.log(`[Ingest] Extracted ${text.length} chars.`);
      rawChunks = segmentText(text);
      console.log(`[Ingest] Segmented into ${rawChunks.length} chunk(s).`);
    }

    // Insert raw rows only — no distillation call here. Most chunks in a
    // long source may never be reached by a learner (they place partway
    // in based on what they already know, and may never finish), so
    // paying a cloud LLM call for all of them up front was spend on
    // material that might never matter, and made the source unusable
    // until every chunk finished (a full textbook could mean minutes of
    // waiting before chapter 1 was even selectable). See
    // ensureChunkDistilled below — it runs stages 3-5 lazily, the first
    // time a chunk actually becomes a learner's active chunk
    // (curriculum.ts's placeUserInSource/activateChunk/advanceChunk).
    for (const raw of rawChunks) {
      const chunkId = `${opts.sourceId}:${raw.ord}`;
      await db.insert(contentChunks).values({
        id: chunkId,
        sourceId: opts.sourceId,
        ord: raw.ord,
        parentTitle: raw.parentTitle,
        title: raw.title,
        body: raw.body,
        startSec: raw.startSec ?? null,
        endSec: raw.endSec ?? null,
      }).onConflictDoNothing();
    }

    await db.update(contentSources).set({ status: 'ready' }).where(eq(contentSources.id, opts.sourceId));
    console.log(`[Ingest] Done: ${rawChunks.length} chunks inserted (undistilled — distillation happens lazily as chunks are reached).`);
    return { chunkCount: rawChunks.length };
  } catch (err) {
    const message = String(err).slice(0, 500);
    await db.update(contentSources).set({ status: 'failed', ingestError: message }).where(eq(contentSources.id, opts.sourceId));
    throw err;
  }
}

// ── Lazy distillation (stages 3-5, deferred) ────────────────────────────

// Collapses concurrent calls for the same chunk (e.g. two learners reaching
// a shared source's same chunk at once) into a single distillation run
// instead of racing duplicate cloud calls.
const distillInFlight = new Map<string, Promise<void>>();

/**
 * Runs distillChunk + linkChunkVocab + embedChunk for ONE chunk, if it
 * hasn't been already (checked via distilledAt). Called from
 * curriculum.ts at the three points a chunk actually starts mattering to a
 * learner — placeUserInSource, activateChunk, advanceChunk — rather than
 * eagerly for a whole source at ingest time (see ingestSource above).
 *
 * Never rejects: a distillation hiccup degrades gracefully (undistilled
 * chunk → no `card`, vocab falls back to global frequency rank per
 * learner-view.ts) rather than blocking whatever curriculum write
 * triggered it. Logged, not silent — matches this file's existing
 * log-don't-silently-drop posture, just non-fatal here since this call
 * site is always incidental to a larger write the caller still needs to
 * complete either way.
 */
export function ensureChunkDistilled(chunkId: string): Promise<void> {
  const existing = distillInFlight.get(chunkId);
  if (existing) return existing;

  const run = (async () => {
    const chunk = await db.query.contentChunks.findFirst({
      where: eq(contentChunks.id, chunkId),
      with: { source: true },
    });
    if (!chunk || chunk.distilledAt || !chunk.source) return;

    console.log(`[Ingest] Lazily distilling chunk ${chunkId} ("${chunk.title}")...`);
    const distilled = await distillChunk(chunk.source.language, chunk.title, chunk.body);

    await db.update(contentChunks).set({
      summary: distilled.summary,
      card: distilled.card,
      grammarPoints: JSON.stringify(distilled.grammarPoints),
      difficulty: distilled.difficulty,
      distilledAt: new Date(),
    }).where(eq(contentChunks.id, chunkId));

    const linked = await linkChunkVocab(chunkId, chunk.source.language, distilled.vocab);
    console.log(`[Ingest]   linked ${linked}/${distilled.vocab.length} vocab items, card ~${estimateTokens(distilled.card)} est. tokens`);

    await embedChunk(chunkId, chunk.body);
  })()
    .catch((err) => {
      console.warn(`[Ingest] Lazy distillation failed for chunk ${chunkId}: ${String(err).slice(0, 200)}`);
    })
    .finally(() => {
      distillInFlight.delete(chunkId);
    });

  distillInFlight.set(chunkId, run);
  return run;
}
