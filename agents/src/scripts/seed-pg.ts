/**
 * Seed the PostgreSQL database with initial vocabulary data.
 *
 * Usage:
 *   DATABASE_URL="postgresql://linglang:linglang_dev@localhost:5433/linglang" \
 *   npx tsx src/scripts/seed-pg.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

// Russian Vocabulary Data
const russianUnits = [
  {
    id: 'ru-unit-1',
    title: 'Basics & Greetings (Russian)',
    description: 'Basic greetings, introductions, and simple phrases in Russian',
    language: 'ru',
    order: 1,
    difficulty: 'beginner',
    prerequisites: [] as string[],
    lexemes: [
      { lemma: 'привет', pos: 'INTJ', translation: 'hello' },
      { lemma: 'да', pos: 'PART', translation: 'yes' },
      { lemma: 'нет', pos: 'PART', translation: 'no' },
      { lemma: 'спасибо', pos: 'NOUN', translation: 'thank you' },
      { lemma: 'пожалуйста', pos: 'ADV', translation: 'please; you are welcome' },
      { lemma: 'как', pos: 'ADV', translation: 'how' },
      { lemma: 'дела', pos: 'NOUN', translation: 'affairs; things' },
    ]
  }
];

// English Power Vocabulary (SAT/GRE style)
const englishUnits = [
  {
    id: 'en-unit-1',
    title: 'Argument & Precision (English)',
    description: 'Words you use to sound sharp when analyzing claims and evidence',
    language: 'en',
    order: 1,
    difficulty: 'advanced',
    prerequisites: [] as string[],
    lexemes: [
      { lemma: 'equivocal', pos: 'ADJ', translation: 'ambiguous; intentionally unclear' },
      { lemma: 'specious', pos: 'ADJ', translation: 'seems plausible but is actually wrong' },
      { lemma: 'cogent', pos: 'ADJ', translation: 'clear, logical, and convincing' },
      { lemma: 'ameliorate', pos: 'VERB', translation: 'to make better; improve' },
      { lemma: 'obviate', pos: 'VERB', translation: 'to remove the need for; make unnecessary' },
      { lemma: 'inimical', pos: 'ADJ', translation: 'harmful; hostile to' },
    ]
  },
  {
    id: 'en-unit-2',
    title: 'Tone & Character (English)',
    description: 'Words for subtle attitudes, motives, and behavior',
    language: 'en',
    order: 2,
    difficulty: 'advanced',
    prerequisites: ['en-unit-1'],
    lexemes: [
      { lemma: 'sardonic', pos: 'ADJ', translation: 'grimly mocking; cynical' },
      { lemma: 'obsequious', pos: 'ADJ', translation: 'excessively flattering; servile' },
      { lemma: 'fastidious', pos: 'ADJ', translation: 'very attentive to detail; hard to please' },
      { lemma: 'magnanimous', pos: 'ADJ', translation: 'generous and forgiving' },
      { lemma: 'capricious', pos: 'ADJ', translation: 'impulsive; unpredictable' },
    ]
  }
];

async function seed() {
  console.log('Seeding PostgreSQL database...\n');

  // 1. Create test user
  console.log('[Seed] Creating user text-test-user...');
  await db.insert(schema.users).values({
    id: 'text-test-user',
    targetLanguage: 'ru',
    nativeLanguage: 'en',
    proficiencyLevel: 'beginner',
  }).onConflictDoNothing();

  // 2. Insert units and lexemes
  for (const unit of [...russianUnits, ...englishUnits]) {
    console.log(`[Seed] Creating unit: ${unit.title}`);
    await db.insert(schema.units).values({
      id: unit.id,
      title: unit.title,
      description: unit.description,
      language: unit.language,
      order: unit.order,
      difficulty: unit.difficulty,
      prerequisites: unit.prerequisites,
    }).onConflictDoNothing();

    for (const lex of unit.lexemes) {
      const id = `${unit.language}:${lex.lemma.toLowerCase()}:${lex.pos}`;
      console.log(`  → ${lex.lemma} (${lex.pos}): ${lex.translation}`);
      await db.insert(schema.lexemes).values({
        id,
        lemma: lex.lemma,
        pos: lex.pos,
        language: unit.language,
        translation: lex.translation,
        gender: null,
        morphFeatures: null,
        unitId: unit.id,
      }).onConflictDoNothing();
    }
  }

  // 3. Verify
  const lexemeCount = await db.select({ id: schema.lexemes.id }).from(schema.lexemes);
  const unitCount = await db.select({ id: schema.units.id }).from(schema.units);
  const userCount = await db.select({ id: schema.users.id }).from(schema.users);

  console.log(`\n[Seed] Done!`);
  console.log(`  Units: ${unitCount.length}`);
  console.log(`  Lexemes: ${lexemeCount.length}`);
  console.log(`  Users: ${userCount.length}`);
  console.log(`\nNext: Run embed-lexemes.ts to add BGE-M3 vectors to the lexemes.`);
}

seed().catch(err => {
  console.error('[Seed] Error:', err);
  process.exit(1);
});