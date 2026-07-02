import { db } from '../db/index.js';
import { users, userVocabulary, lexemes } from '../db/schema.js';
import { eq, sql, and, count, countDistinct } from 'drizzle-orm';
import { runProcessor } from '../tools/supervisor-functions.js';

const TEST_USER_ID = process.env.TEST_USER_ID || '';

// Find a user with target=pt
const targetUser = await db
  .select()
  .from(users)
  .where(eq(users.targetLanguage, 'pt'))
  .limit(1);

const userId = TEST_USER_ID || targetUser[0]?.id;

if (!userId) {
  console.error('No user with target=pt found');
  process.exit(1);
}

console.log(`Testing with user: ${userId} (target=pt, native=${targetUser[0]?.nativeLanguage})`);

// Snapshot PT row counts BEFORE
const before = await db
  .select({
    total: count(),
    englishLemmas: sql<number>`COUNT(*) FILTER (WHERE ${lexemes.lemma} ~ '^[A-Za-z\\-\\. '']+$' AND length(${lexemes.lemma}) > 1)::int`,
    ptLemmas: sql<number>`COUNT(*) FILTER (WHERE ${lexemes.lemma} ~ '[à-ÿÀ-ŸáéíóúçãõâêôÁÉÍÓÚÇÃÕÂÊÔ]')::int`,
  })
  .from(userVocabulary)
  .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
  .where(and(eq(userVocabulary.userId, userId), eq(lexemes.language, 'pt')));

console.log('\nBEFORE:');
console.log(`  PT table rows: ${before[0].total}`);
console.log(`  English-looking lemmas: ${before[0].englishLemmas}`);
console.log(`  PT-character lemmas: ${before[0].ptLemmas}`);

// Mixed utterance: should produce 2 PT rows (praia, pão) and zero new EN rows in PT table
const utterance = 'I went to the praia and ate pão';
const context = 'User is learning Portuguese. Pre-A1 level.';

const result = await runProcessor(userId, utterance, context, {
  useGemini: false,
  llmUrl: 'http://localhost:8094/v1',
  llmModel: 'gemma4-12b-it-qat',
});

console.log(`\nProcessor result: ${result.analysis?.lexemes?.length || 0} lexemes analyzed`);
console.log(`SRS updates: ${result.srsUpdates?.length || 0}`);

// Verify tracking status is returned parallel to lexemes
const trackingArr: string[] = (result.analysis as any)?.tracking || [];
console.log(`\nTracking status (per lexeme):`);
for (let i = 0; i < (result.analysis?.lexemes || []).length; i++) {
  const lex = result.analysis!.lexemes[i]!;
  console.log(`  [${i}] ${lex.lemma.padEnd(10)} pos=${lex.pos.padEnd(5)} lang=${(lex.language || '?').padEnd(3)} perf=${lex.performance.padEnd(20)} tracking=${trackingArr[i]}`);
}

// Snapshot AFTER
const after = await db
  .select({
    total: count(),
    englishLemmas: sql<number>`COUNT(*) FILTER (WHERE ${lexemes.lemma} ~ '^[A-Za-z\\-\\. '']+$' AND length(${lexemes.lemma}) > 1)::int`,
    ptLemmas: sql<number>`COUNT(*) FILTER (WHERE ${lexemes.lemma} ~ '[à-ÿÀ-ŸáéíóúçãõâêôÁÉÍÓÚÇÃÕÂÊÔ]')::int`,
  })
  .from(userVocabulary)
  .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
  .where(and(eq(userVocabulary.userId, userId), eq(lexemes.language, 'pt')));

console.log('\nAFTER:');
console.log(`  PT table rows: ${after[0].total}  (delta: ${(after[0].total as number) - (before[0].total as number)})`);
console.log(`  English-looking lemmas: ${after[0].englishLemmas}  (delta: ${(after[0].englishLemmas as number) - (before[0].englishLemmas as number)})`);
console.log(`  PT-character lemmas: ${after[0].ptLemmas}  (delta: ${(after[0].ptLemmas as number) - (before[0].ptLemmas as number)})`);

// Show the new rows added
const newRows = await db
  .select({
    lemma: lexemes.lemma,
    translation: lexemes.translation,
    nativeLemma: lexemes.nativeLemma,
    state: userVocabulary.state,
  })
  .from(userVocabulary)
  .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
  .where(and(eq(userVocabulary.userId, userId), eq(lexemes.language, 'pt')))
  .orderBy(sql`${userVocabulary.id} DESC`)
  .limit(8);

console.log('\nNewest 8 PT rows:');
for (const r of newRows) {
  const isEng = /^[A-Za-z\-\. ']+$/.test(r.lemma) && r.lemma.length > 1;
  console.log(`  ${isEng ? '🟠 EN' : '🟢 PT'}  ${r.lemma.padEnd(15)} → ${r.translation || '(no translation)'}  [nativeLemma=${r.nativeLemma || 'null'}]`);
}

process.exit(0);
