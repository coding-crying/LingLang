/**
 * One-off backfill of lexemes.frequency_rank for ru and zh, learner-field
 * spec §9 (docs/plans/2026-07-09-learner-field-design.md).
 *
 * Source: hermitdave/FrequencyWords (OpenSubtitles-derived, MIT), rank =
 * line order in the raw word\tcount list.
 *
 * Lemma-alignment mitigation (the "ugliest part" the spec calls out): the
 * source list is SURFACE-FORM frequency, but our `lexemes.lemma` column is
 * dictionary form. For zh (isolating — no inflection) exact match is
 * correct. For ru (inflectional — быть/был/было/будет all rank separately
 * in the source), exact match alone badly under-ranks common verbs/
 * adjectives. Mitigation: for unmatched ru lemmas, fall back to a stem
 * match — strip the last ~2 chars (typical inflectional ending length) and
 * take the LOWEST (most frequent) rank among source entries sharing that
 * stem. Approximate, not a real lemmatizer — logged match-method counts +
 * a top-20 sample for manual sanity-check per the spec's explicit ask.
 *
 * Usage: tsx src/scripts/backfill-frequency-rank.ts <ru_list.txt> <zh_list.txt>
 */
import { readFileSync } from 'fs';
import { db } from '../db/index.js';
import { lexemes } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';

interface FreqEntry {
  word: string;
  rank: number;
}

function loadFreqList(path: string): FreqEntry[] {
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim());
  return lines.map((line, i) => ({
    word: line.split(/\s+/)[0]!.trim().toLowerCase(),
    rank: i + 1,
  }));
}

function stem(word: string): string | null {
  // Only stem words long enough that trimming 2 chars leaves a meaningful
  // root — short words (< 5 chars) get no stem fallback, exact-match only.
  if (word.length < 5) return null;
  return word.slice(0, word.length - 2);
}

async function backfillLanguage(
  languageCode: string,
  freqPath: string,
  useStemFallback: boolean,
) {
  const freqList = loadFreqList(freqPath);
  const exactIndex = new Map<string, number>();
  for (const e of freqList) {
    if (!exactIndex.has(e.word)) exactIndex.set(e.word, e.rank); // first occurrence = lowest rank
  }

  // Stem index: stem -> best (lowest) rank among entries sharing that stem.
  // Only built if useStemFallback, and only over a bounded prefix of the
  // list (top 20k) — stemming the full 50k tail is noise, not signal.
  const stemIndex = new Map<string, number>();
  if (useStemFallback) {
    for (const e of freqList.slice(0, 20000)) {
      const s = stem(e.word);
      if (!s) continue;
      const existing = stemIndex.get(s);
      if (existing === undefined || e.rank < existing) stemIndex.set(s, e.rank);
    }
  }

  const rows = await db.query.lexemes.findMany({
    where: eq(lexemes.language, languageCode),
  });

  let exactMatches = 0;
  let stemMatches = 0;
  let unmatched = 0;
  const sample: Array<{ lemma: string; rank: number; method: string }> = [];

  for (const row of rows) {
    const lemma = row.lemma.toLowerCase().trim();
    let rank: number | null = null;
    let method = '';

    if (exactIndex.has(lemma)) {
      rank = exactIndex.get(lemma)!;
      method = 'exact';
      exactMatches++;
    } else if (useStemFallback) {
      const s = stem(lemma);
      if (s && stemIndex.has(s)) {
        rank = stemIndex.get(s)!;
        method = 'stem';
        stemMatches++;
      }
    }

    if (rank === null) {
      unmatched++;
      continue;
    }

    await db.update(lexemes).set({ frequencyRank: rank }).where(eq(lexemes.id, row.id));
    sample.push({ lemma: row.lemma, rank, method });
  }

  sample.sort((a, b) => a.rank - b.rank);

  console.log(`\n=== ${languageCode} ===`);
  console.log(`Total lexemes: ${rows.length}`);
  console.log(`Exact matches: ${exactMatches}`);
  console.log(`Stem-fallback matches: ${stemMatches}`);
  console.log(`Unmatched (left NULL): ${unmatched}`);
  console.log(`\nTop 20 by assigned rank (sanity-check — these should be genuinely common words):`);
  for (const s of sample.slice(0, 20)) {
    console.log(`  rank ${s.rank}\t${s.lemma}\t[${s.method}]`);
  }
}

async function main() {
  const [ruPath, zhPath] = process.argv.slice(2);
  if (!ruPath || !zhPath) {
    console.error('Usage: tsx backfill-frequency-rank.ts <ru_list.txt> <zh_list.txt>');
    process.exit(1);
  }
  await backfillLanguage('ru', ruPath, true);
  await backfillLanguage('zh', zhPath, false);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
