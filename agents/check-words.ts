import { db } from './src/db/index.js';
import { lexemes } from './src/db/schema.js';
import { eq, like, sql } from 'drizzle-orm';

async function checkWords() {
  // Search for exact matches
  const words = ['я', 'хочу', 'привет', 'есть'];

  console.log('=== Exact matches for common words ===\n');

  for (const word of words) {
    const found = await db.query.lexemes.findMany({
      where: eq(lexemes.lemma, word)
    });
    console.log(`'${word}': ${found.length} exact matches`);
    found.forEach(l => console.log(`  - ${l.id}: lemma="${l.lemma}" pos="${l.pos}"`));
  }

  console.log('\n=== Partial matches (containing substring) ===\n');

  const wordsPartial = ['я', 'хочу'];
  for (const word of wordsPartial) {
    const found = await db.query.lexemes.findMany({
      where: like(lexemes.lemma, `%${word}%`),
      limit: 5
    });
    console.log(`'${word}': ${found.length} partial matches`);
    found.forEach(l => console.log(`  - ${l.id}: ${l.lemma} (${l.pos})`));
  }

  // Count total by language
  console.log('\n=== Total lexemes by language ===');
  const result = await db.select({
    language: lexemes.language,
    count: sql<number>`count(*)`.as('count')
  })
  .from(lexemes)
  .groupBy(lexemes.language);

  console.log(result);

  // Sample Russian lexemes
  console.log('\n=== Sample Russian lexemes (first 20) ===');
  const samples = await db.query.lexemes.findMany({
    where: eq(lexemes.language, 'ru'),
    limit: 20
  });
  samples.forEach(l => console.log(`${l.lemma} (${l.pos}) - ${l.translation}`));
}

checkWords().catch(console.error);
