import { db } from '../db/index.js';
import { userVocabulary, lexemes } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

const result = await db
  .select({
    total: sql<number>`COUNT(*)::int`,
    englishLemma: sql<number>`COUNT(*) FILTER (WHERE ${lexemes.lemma} ~ '^[A-Za-z\\-\\. '']+$' AND length(${lexemes.lemma}) > 1)::int`,
    ptLemma: sql<number>`COUNT(*) FILTER (WHERE ${lexemes.lemma} ~ '[à-ÿÀ-ŸáéíóúçãõâêôÁÉÍÓÚÇÃÕÂÊÔ]' OR ${lexemes.lemma} ~ '[áéíóú]' OR ${lexemes.lemma} ~ '[ãõç]' OR ${lexemes.lemma} ~ '[âêô]' OR ${lexemes.lemma} ~ '[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]')::int`,
    englishTranslation: sql<number>`COUNT(*) FILTER (WHERE ${lexemes.translation} ~ '^[A-Za-z\\-\\. '']+$' AND length(${lexemes.translation}) > 1)::int`,
    hasNativeLemma: sql<number>`COUNT(*) FILTER (WHERE ${lexemes.nativeLemma} IS NOT NULL)::int`,
  })
  .from(userVocabulary)
  .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
  .where(eq(lexemes.language, 'pt'));

console.log('PT vocabulary breakdown:', result);

// Sample English-contaminated rows
const samples = await db
  .select({
    lemma: lexemes.lemma,
    translation: lexemes.translation,
    nativeLemma: lexemes.nativeLemma,
    state: userVocabulary.state,
  })
  .from(userVocabulary)
  .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
  .where(eq(lexemes.language, 'pt'))
  .limit(500);

const englishRows = samples
  .filter((r) => /^[A-Za-z\-\. ']+$/.test(r.lemma) && r.lemma.length > 1)
  .slice(0, 30);

console.log('\nFirst 30 English-looking lemmas in PT table:');
for (const r of englishRows) {
  console.log(`  ${r.lemma}  →  ${r.translation || '(no translation)'}  [nativeLemma=${r.nativeLemma || 'null'}]`);
}

process.exit(0);
