import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import * as schema from './schema.js';
import path from 'path';

const dbPath = path.resolve('tutor.db');
const sqlite = new Database(dbPath);
const db = drizzle(sqlite, { schema });

// Russian Vocabulary Data
const russianUnits = [
  {
    id: 'ru-unit-1',
    title: 'Basics & Greetings (Russian)',
    description: 'Basic greetings, introductions, and simple phrases in Russian',
    language: 'ru',
    order: 1,
    difficulty: 'beginner',
    prerequisites: [],
    lexemes: [
      { lemma: 'привет', pos: 'INTJ', translation: 'hello' },
      { lemma: 'да', pos: 'PART', translation: 'yes' },
      { lemma: 'нет', pos: 'PART', translation: 'no' },
      { lemma: 'спасибо', pos: 'NOUN', translation: 'thank you', gender: 'neuter' },
      { lemma: 'пожалуйста', pos: 'ADV', translation: 'please' },
      { lemma: 'как', pos: 'ADV', translation: 'how' },
      { lemma: 'дела', pos: 'NOUN', translation: 'affairs', gender: 'neuter' },
    ]
  }
];

// English Power Vocabulary (SAT/GRE)
// Keep this small and high-signal for the demo.
const englishUnits = [
  {
    id: 'en-unit-1',
    title: 'Argument & Precision (English)',
    description: 'Words you use to sound sharp when analyzing claims and evidence',
    language: 'en',
    order: 1,
    difficulty: 'advanced',
    prerequisites: [],
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
  console.log('Seeding database...');

  // 1. Create Units & Lexemes
  for (const unit of [...russianUnits, ...englishUnits]) {
    console.log(`Creating unit: ${unit.title}`);
    await db.insert(schema.units).values({
      id: unit.id,
      title: unit.title,
      description: unit.description,
      language: unit.language,
      order: unit.order,
      difficulty: unit.difficulty,
      prerequisites: unit.prerequisites
    }).onConflictDoUpdate({ target: schema.units.id, set: { title: unit.title } });

    for (const lex of unit.lexemes) {
      const id = `${lex.lemma}-${lex.pos}`;
      await db.insert(schema.lexemes).values({
        id,
        lemma: lex.lemma,
        pos: lex.pos,
        language: unit.language,
        translation: lex.translation,
        gender: lex.gender || null,
        unitId: unit.id
      }).onConflictDoNothing();
    }
  }
  
  // 2. Create a Test User
  await db.insert(schema.users).values({
    id: 'test-user',
    createdAt: Date.now()
  }).onConflictDoNothing();

  console.log('Seeding complete!');
}

seed().catch(console.error);
