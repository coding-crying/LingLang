import { db } from '../db/index.js';
import { userVocabulary, lexemes, users } from '../db/schema.js';
import { eq, sql, and, count, desc, asc } from 'drizzle-orm';

console.log('=== PT table contamination audit ===\n');

const ptRows = await db
  .select({
    id: lexemes.id,
    lemma: lexemes.lemma,
    pos: lexemes.pos,
    translation: lexemes.translation,
    nativeLemma: lexemes.nativeLemma,
    state: userVocabulary.state,
    reps: userVocabulary.reps,
    lapses: userVocabulary.lapses,
    nativeSubCount: userVocabulary.nativeSubstitutionCount,
  })
  .from(userVocabulary)
  .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
  .where(eq(lexemes.language, 'pt'))
  .orderBy(asc(lexemes.lemma));

// Classification function
function classify(lemma: string, nativeLemma: string | null): 'pt' | 'en' | 'uncertain' {
  const hasDiacritics = /[à-ÿÀ-ŸáéíóúçãõâêôÁÉÍÓÚÇÃÕÂÊÔ]/.test(lemma);
  if (hasDiacritics) return 'pt';
  // ASCII-only. Heuristics:
  // - native_lemma matches lemma and is set → was flagged native, definitely en
  // - lemma in known PT seed list → pt
  const PT_SEED = new Set([
    // 20+ most common PT words that happen to be ASCII
    'a', 'o', 'e', 'de', 'em', 'um', 'uma', 'eu', 'tu', 'ele', 'ela', 'nos', 'vos',
    'eles', 'elas', 'me', 'te', 'se', 'nos', 'lhe', 'lhes', 'que', 'com', 'por', 'para',
    'sem', 'sob', 'sobre', 'ate', 'ser', 'ter', 'haver', 'ir', 'vir', 'dar', 'ver',
    'saber', 'querer', 'poder', 'dizer', 'falar', 'fazer', 'pôr', 'trazer', 'gostar',
    'cafe', 'praia', 'mar', 'sol', 'ar', 'lua', 'ceu', 'rio', 'mato', 'mel', 'vinho',
    'pão',  // has diacritic but worth listing
    'bom', 'boa', 'mal', 'grande', 'pequeno', 'novo', 'velho', 'sim', 'nao',
  ]);
  if (PT_SEED.has(lemma.toLowerCase())) return 'pt';
  if (nativeLemma && nativeLemma.toLowerCase() === lemma.toLowerCase()) return 'en';
  return 'uncertain';
}

const classified = { pt: 0, en: 0, uncertain: 0 };
const uncertainExamples: any[] = [];
const contaminationByState: Record<number, { pt: number; en: number; uncertain: number }> = {};

for (const r of ptRows) {
  const c = classify(r.lemma, r.nativeLemma);
  classified[c]++;
  if (!contaminationByState[r.state]) contaminationByState[r.state] = { pt: 0, en: 0, uncertain: 0 };
  contaminationByState[r.state][c]++;
  if (c === 'uncertain' && uncertainExamples.length < 30) {
    uncertainExamples.push(r);
  }
}

console.log(`Total PT rows: ${ptRows.length}`);
console.log(`  PT (genuine): ${classified.pt}`);
console.log(`  EN (contamination): ${classified.en}`);
console.log(`  Uncertain: ${classified.uncertain}\n`);

console.log('By FSRS state:');
for (const [state, counts] of Object.entries(contaminationByState)) {
  const total = counts.pt + counts.en + counts.uncertain;
  console.log(`  state=${state} (n=${total}): pt=${counts.pt}, en=${counts.en}, uncertain=${counts.uncertain}`);
}

console.log('\nUncertain examples (need manual review):');
for (const r of uncertainExamples) {
  console.log(`  ${r.lemma.padEnd(15)} pos=${r.pos.padEnd(6)} nativeLemma=${r.nativeLemma || 'null'} translation=${r.translation || '(none)'}`);
}

process.exit(0);
