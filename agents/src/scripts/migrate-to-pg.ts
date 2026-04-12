/**
 * One-shot migration: Copy will.y.um's data from SQLite to PostgreSQL.
 *
 * Reads directly from the SQLite file using better-sqlite3 (still available
 * at runtime for this script only), then writes to PostgreSQL via Drizzle.
 *
 * Usage:
 *   DATABASE_URL="postgresql://linglang:linglang_dev@localhost:5433/linglang" \
 *   npx tsx src/scripts/migrate-to-pg.ts
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_PATH = path.resolve(__dirname, '../../tutor.db');

const WILL_USER_ID = 'will.y.um';

async function main() {
  console.log('[Migration] Opening SQLite database at:', SQLITE_PATH);
  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  // 1. Copy units (all - reference data)
  console.log('[Migration] Copying units...');
  const units = sqlite.prepare('SELECT * FROM units').all();
  for (const unit of units) {
    await db.insert(schema.units).values({
      id: unit.id,
      title: unit.title,
      description: unit.description,
      language: unit.language,
      order: unit.order,
      difficulty: unit.difficulty,
      estimatedHours: unit.estimated_hours,
      prerequisites: unit.prerequisites ? JSON.parse(unit.prerequisites) : null,
    }).onConflictDoNothing();
  }
  console.log(`[Migration] Copied ${units.length} units`);

  // 2. Copy user will.y.um
  console.log('[Migration] Copying user will.y.um...');
  const willUser = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(WILL_USER_ID);
  if (!willUser) {
    throw new Error(`User ${WILL_USER_ID} not found in SQLite`);
  }
  await db.insert(schema.users).values({
    id: willUser.id,
    createdAt: new Date(willUser.created_at * 1000),
    targetLanguage: willUser.target_language || 'ru',
    nativeLanguage: willUser.native_language || 'en',
    proficiencyLevel: willUser.proficiency_level || 'beginner',
  }).onConflictDoNothing();

  // 3. Copy ALL lexemes (reference data, not just will's)
  console.log('[Migration] Copying lexemes...');
  const allLexemes = sqlite.prepare('SELECT * FROM lexemes').all();
  let lexCount = 0;
  for (const lex of allLexemes) {
    let morphFeatures = null;
    if (lex.morph_features) {
      try { morphFeatures = JSON.parse(lex.morph_features); } catch { morphFeatures = lex.morph_features; }
    }
    await db.insert(schema.lexemes).values({
      id: lex.id,
      lemma: lex.lemma,
      pos: lex.pos,
      language: lex.language,
      translation: lex.translation,
      gender: lex.gender,
      morphFeatures,
      unitId: lex.unit_id,
      embedding: null, // Filled by embed-lexemes.ts
    }).onConflictDoNothing();
    lexCount++;
  }
  console.log(`[Migration] Copied ${lexCount} lexemes`);

  // 4. Copy grammar rules
  console.log('[Migration] Copying grammar rules...');
  const rules = sqlite.prepare('SELECT * FROM grammar_rules').all();
  for (const rule of rules) {
    await db.insert(schema.grammarRules).values({
      id: rule.id,
      rule: rule.rule,
      description: rule.description,
      example: rule.example,
      unitId: rule.unit_id,
      embedding: null,
    }).onConflictDoNothing();
  }
  console.log(`[Migration] Copied ${rules.length} grammar rules`);

  // 5. Convert will's learning_progress → user_vocabulary (FSRS)
  console.log('[Migration] Converting learning_progress to user_vocabulary...');
  const progress = sqlite.prepare('SELECT * FROM learning_progress WHERE user_id = ?').all(WILL_USER_ID);

  let vocabCount = 0;
  for (const p of progress) {
    const { state, stability, difficulty, scheduledDays } = leitnerToFSRS(p.srs_level);
    const dueDate = new Date(p.next_review * 1000);
    const lastReviewDate = new Date(p.last_seen * 1000);
    const elapsedDays = Math.max(0, Math.floor((Date.now() / 1000 - p.last_seen) / 86400));

    await db.insert(schema.userVocabulary).values({
      userId: WILL_USER_ID,
      lexemeId: p.lexeme_id,
      state,
      due: dueDate,
      stability,
      difficulty,
      elapsedDays,
      scheduledDays,
      reps: p.encounters || 0,
      lapses: Math.max(0, (p.encounters || 0) - (p.correct_uses || 0)),
      lastReview: lastReviewDate,
      avgPronunciationScore: null,
    }).onConflictDoNothing();
    vocabCount++;
  }
  console.log(`[Migration] Converted ${vocabCount} progress records → user_vocabulary`);

  // 6. Copy duolingo metadata
  console.log('[Migration] Copying duolingo metadata...');
  const duoMeta = sqlite.prepare('SELECT * FROM duolingo_metadata WHERE user_id = ?').all(WILL_USER_ID);
  for (const dm of duoMeta) {
    await db.insert(schema.duolingoMetadata).values({
      userId: dm.user_id,
      duolingoUsername: dm.duolingo_username,
      duolingoPassword: dm.duolingo_password,
      duolingoJWT: dm.duolingo_jwt,
      lastSyncTimestamp: dm.last_sync_timestamp ? new Date(dm.last_sync_timestamp * 1000) : null,
      syncStatus: dm.sync_status || 'pending',
      syncError: dm.sync_error,
      duolingoUserId: dm.duolingo_user_id,
      learningLanguage: dm.learning_language,
      createdAt: new Date(dm.created_at * 1000),
      updatedAt: new Date(dm.updated_at * 1000),
    }).onConflictDoNothing();
  }
  console.log(`[Migration] Copied ${duoMeta.length} duolingo metadata records`);

  console.log('[Migration] Done!');
  sqlite.close();
  process.exit(0);
}

/**
 * Convert Leitner box level (0-5) to approximate FSRS initial state.
 * These are reasonable starting approximations — FSRS will refine them
 * as the user continues reviewing.
 */
function leitnerToFSRS(level: number): { state: number; stability: number; difficulty: number; scheduledDays: number } {
  switch (level) {
    case 0: return { state: 0, stability: 0, difficulty: 0, scheduledDays: 0 };
    case 1: return { state: 1, stability: 1, difficulty: 5, scheduledDays: 1 };
    case 2: return { state: 2, stability: 3.5, difficulty: 4.5, scheduledDays: 3 };
    case 3: return { state: 2, stability: 7, difficulty: 4, scheduledDays: 7 };
    case 4: return { state: 2, stability: 15, difficulty: 3.5, scheduledDays: 15 };
    case 5: return { state: 2, stability: 30, difficulty: 3, scheduledDays: 30 };
    default: return { state: 0, stability: 0, difficulty: 0, scheduledDays: 0 };
  }
}

main().catch(err => {
  console.error('[Migration] Error:', err);
  process.exit(1);
});