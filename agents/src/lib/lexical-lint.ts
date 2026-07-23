/**
 * Passive out-of-bank (OOV) measurement for tutor replies — learner-field
 * spec §5.2 (docs/plans/2026-07-09-learner-field-design.md), measure-only
 * phase. Logs how much of the tutor's own reply falls outside the user's
 * known + frontier vocabulary. No rewrite/retry loop yet — that's gated on
 * this data actually showing a problem (over-engineering audit, §10).
 *
 * Deliberately cheap and heuristic, not a real lemmatizer:
 * - Whitespace-script languages (ru, etc.): tokenize on \p{L}+ runs, match
 *   against known lemmas exact-first, then a stem fallback (same "strip
 *   last ~2 chars" heuristic as the frequency backfill script) so
 *   inflected forms of known words don't false-positive as OOV.
 * - CJK (zh, no whitespace): greedy longest-match segmentation against the
 *   known-lemma set. Crude — no real segmenter — but our zh vocab is short
 *   (1-3 char) words, so it's a reasonable approximation for a metric that
 *   isn't gating anything yet.
 */
import { db } from '../db/index.js';
import { userVocabulary, lexemes } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { SCRIPT_RANGES } from './language-mix.js';

const CJK_LANGS = new Set(['zh', 'ja']);

function stem(word: string): string | null {
  if (word.length < 5) return null;
  return word.slice(0, word.length - 2);
}

function buildStemIndex(knownLemmas: Set<string>): Map<string, true> {
  const idx = new Map<string, true>();
  for (const lemma of knownLemmas) {
    const s = stem(lemma);
    if (s) idx.set(s, true);
  }
  return idx;
}

function tokenizeWhitespace(text: string): string[] {
  return (text.match(/\p{L}+/gu) || []).map((w) => w.toLowerCase());
}

/** Greedy longest-match segmentation for CJK — max lemma length 4 chars is plenty for our vocab. */
function segmentCjk(text: string, knownLemmas: Set<string>): string[] {
  const chars = Array.from(text.replace(/[\s\p{P}]/gu, ''));
  const tokens: string[] = [];
  let i = 0;
  const maxLen = 4;
  while (i < chars.length) {
    let matched = false;
    for (let len = Math.min(maxLen, chars.length - i); len >= 1; len--) {
      const candidate = chars.slice(i, i + len).join('');
      if (knownLemmas.has(candidate)) {
        tokens.push(candidate);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push(chars[i]!);
      i += 1;
    }
  }
  return tokens;
}

export interface OovResult {
  totalWords: number;
  oovWords: string[];
  oovRate: number;
}

/**
 * Fire-and-forget from the caller — does its own DB read, never blocks the
 * reply/TTS pipeline. Returns null when there's not enough text to measure
 * or no known-vocab signal yet (new user — everything would trivially
 * "OOV", not a useful measurement).
 */
export async function measureReplyOov(
  userId: string,
  languageCode: string,
  replyText: string,
  frontierLemmas: string[] = [],
): Promise<OovResult | null> {
  const rows = await db
    .select({ lemma: lexemes.lemma })
    .from(userVocabulary)
    .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
    .where(and(
      eq(userVocabulary.userId, userId),
      eq(lexemes.language, languageCode),
      inArray(userVocabulary.state, [1, 2, 3]),
    ));

  if (rows.length < 5) return null; // too little known vocab to measure meaningfully

  const knownLemmas = new Set(rows.map((r) => r.lemma.toLowerCase()));
  for (const l of frontierLemmas) knownLemmas.add(l.toLowerCase());
  const stemIndex = buildStemIndex(knownLemmas);

  // 2026-07-10: score only TARGET-SCRIPT tokens. Without this, a tutor
  // reply that's mostly English measured as ~100% OOV every turn (all the
  // English words counted), drowning the actual signal — which is "how much
  // of the tutor's TARGET-LANGUAGE vocabulary is outside the user's bank."
  // For non-Latin-script targets (ru/zh/ar — see SCRIPT_RANGES) this is
  // exact. For Latin-script targets (es/pt/fr) English and target words are
  // indistinguishable by script, so the metric stays noisy there — known
  // limitation, revisit if those languages go live.
  const script = SCRIPT_RANGES[languageCode];
  const isCjk = CJK_LANGS.has(languageCode);
  let tokens = isCjk ? segmentCjk(replyText, knownLemmas) : tokenizeWhitespace(replyText);
  if (script) tokens = tokens.filter((tok) => script.test(tok));
  if (tokens.length === 0) return null;

  const oovWords: string[] = [];
  for (const tok of tokens) {
    if (knownLemmas.has(tok)) continue;
    const s = stem(tok);
    if (s && stemIndex.has(s)) continue;
    // Single CJK chars are common function words/particles even when not
    // independently tracked as lexemes — not worth flagging as OOV.
    if (isCjk && tok.length === 1) continue;
    oovWords.push(tok);
  }

  return {
    totalWords: tokens.length,
    oovWords,
    oovRate: oovWords.length / tokens.length,
  };
}
