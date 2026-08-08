/**
 * End-to-end check of the content-provenance path, against the real
 * database — see docs/superpowers/specs/2026-08-08-content-provenance-design.md §7.
 *
 * The scenario is the one the feature exists for: a learner arrives having
 * done the first 25 lessons of a 30-lesson audio course, one lesson a day,
 * the last one today. Before this feature they would be placed at lesson 1
 * with an empty vocabulary. What should happen instead:
 *
 *   - lessons 1-25 are marked done and lesson 26 becomes active
 *   - their vocabulary is seeded as known, so coverage arithmetic agrees
 *   - lesson 1's words are ALREADY OVERDUE (studied 24 days ago, ~21-day
 *     interval) and will surface for review
 *   - lesson 25's words are NOT due (studied today)
 *   - lessons 26-30 are untouched — nothing is claimed that wasn't studied
 *
 * The unit tests cover the arithmetic; this covers the wiring, which is
 * where the interesting failures live (placement ordering, the conflict
 * policy, whether coverage actually reads the seeded rows).
 *
 * Creates a throwaway user and source, then deletes both. Safe to re-run.
 *
 *   npx tsx src/scripts/verify-content-provenance.ts
 */

import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  chunkLexemes,
  contentChunks,
  contentSources,
  lexemes,
  userContentProgress,
  userSourceProfiles,
  userVocabulary,
  users,
} from '../db/schema.js';
import { reconcileSourceProgress } from '../lib/content-reconcile.js';

const USER_ID = '__provenance_test';
const SOURCE_ID = '__provenance_src';
const LANG = 'pt';
const TOTAL_LESSONS = 30;
const COMPLETED_LESSONS = 25;
const WORDS_PER_LESSON = 4;

const lexemeId = (lesson: number, i: number) => `__prov:l${lesson}:w${i}`;
const chunkId = (lesson: number) => `__prov_chunk_${lesson}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function cleanup(): Promise<void> {
  await db.delete(userVocabulary).where(eq(userVocabulary.userId, USER_ID));
  await db.delete(userContentProgress).where(eq(userContentProgress.userId, USER_ID));
  await db.delete(userSourceProfiles).where(eq(userSourceProfiles.userId, USER_ID));
  await db.delete(chunkLexemes).where(like(chunkLexemes.chunkId, '__prov_chunk_%'));
  await db.delete(contentChunks).where(eq(contentChunks.sourceId, SOURCE_ID));
  await db.delete(contentSources).where(eq(contentSources.id, SOURCE_ID));
  await db.delete(lexemes).where(like(lexemes.id, '__prov:%'));
  await db.delete(users).where(eq(users.id, USER_ID));
}

async function seedFixture(): Promise<void> {
  await db.insert(users).values({ id: USER_ID, targetLanguage: LANG, nativeLanguage: 'en' });

  await db.insert(lexemes).values(
    Array.from({ length: TOTAL_LESSONS }, (_, lesson) =>
      Array.from({ length: WORDS_PER_LESSON }, (_, i) => ({
        id: lexemeId(lesson, i),
        lemma: `provtest_l${lesson}_w${i}`,
        pos: 'NOUN',
        language: LANG,
        translation: `test word ${lesson}.${i}`,
      })),
    ).flat(),
  );

  await db.insert(contentSources).values({
    id: SOURCE_ID,
    ownerId: USER_ID,
    language: LANG,
    kind: 'audio', // one lesson a day — the pace assumption under test
    title: 'Provenance Test Course',
    status: 'ready',
  });

  // distilledAt is pre-set so ensureChunkDistilled is a no-op: this script
  // is testing reconciliation, not the LLM distillation pipeline, and 25
  // live distillation calls would make it slow and non-deterministic.
  await db.insert(contentChunks).values(
    Array.from({ length: TOTAL_LESSONS }, (_, lesson) => ({
      id: chunkId(lesson),
      sourceId: SOURCE_ID,
      ord: lesson,
      title: `Lesson ${lesson + 1}`,
      body: `Body of lesson ${lesson + 1}.`,
      summary: 'test',
      card: 'test card',
      distilledAt: new Date(),
    })),
  );

  await db.insert(chunkLexemes).values(
    Array.from({ length: TOTAL_LESSONS }, (_, lesson) =>
      Array.from({ length: WORDS_PER_LESSON }, (_, i) => ({
        chunkId: chunkId(lesson),
        lexemeId: lexemeId(lesson, i),
        salience: 0.8,
      })),
    ).flat(),
  );

  await db.insert(userSourceProfiles).values({
    userId: USER_ID,
    sourceId: SOURCE_ID,
    intent: 'study',
    status: 'complete',
    answers: {
      intent: 'study',
      known_through: { count: COMPLETED_LESSONS },
      last_studied: 'today',
      intensity: 'drilled',
    },
    lastStudiedAt: new Date(),
    intensity: 'drilled',
    profiledAt: new Date(),
  });
}

async function main(): Promise<void> {
  console.log('Cleaning up any previous run...');
  await cleanup();

  console.log(`Seeding fixture: ${TOTAL_LESSONS}-lesson audio course, learner completed ${COMPLETED_LESSONS}, one a day.`);
  await seedFixture();

  console.log('\nReconciling...');
  const result = await reconcileSourceProgress(USER_ID, SOURCE_ID);
  console.log(JSON.stringify(result, null, 2));

  const now = Date.now();
  console.log('\nPlacement:');
  check('reconciled', result.status === 'reconciled', result.reason ?? '');
  check(
    `${COMPLETED_LESSONS} lessons marked done`,
    result.chunksMarkedDone === COMPLETED_LESSONS,
    `got ${result.chunksMarkedDone}`,
  );
  check(
    `active chunk is lesson ${COMPLETED_LESSONS + 1} (ord ${COMPLETED_LESSONS})`,
    result.activeChunkOrd === COMPLETED_LESSONS,
    `got ord ${result.activeChunkOrd}`,
  );

  const progress = await db.query.userContentProgress.findMany({
    where: eq(userContentProgress.userId, USER_ID),
    with: { chunk: true },
  });
  const byOrd = new Map(progress.map((p) => [p.chunk.ord, p]));
  check('lesson 1 is done', byOrd.get(0)?.status === 'done', `status ${byOrd.get(0)?.status}`);
  check(
    `lesson ${COMPLETED_LESSONS} is done`,
    byOrd.get(COMPLETED_LESSONS - 1)?.status === 'done',
    `status ${byOrd.get(COMPLETED_LESSONS - 1)?.status}`,
  );
  check(
    `lesson ${COMPLETED_LESSONS + 1} is active`,
    byOrd.get(COMPLETED_LESSONS)?.status === 'active',
    `status ${byOrd.get(COMPLETED_LESSONS)?.status}`,
  );

  console.log('\nSeeded vocabulary:');
  const vocab = await db.query.userVocabulary.findMany({
    where: eq(userVocabulary.userId, USER_ID),
  });
  const vocabById = new Map(vocab.map((v) => [v.lexemeId, v]));
  check(
    `${COMPLETED_LESSONS * WORDS_PER_LESSON} words seeded`,
    vocab.length === COMPLETED_LESSONS * WORDS_PER_LESSON,
    `got ${vocab.length}`,
  );
  check('all seeded rows carry origin=seeded', vocab.every((v) => v.origin === 'seeded'));
  check('all seeded rows are in review state', vocab.every((v) => v.state === 2));
  check('no reps invented', vocab.every((v) => v.reps === 0));

  // Nothing beyond lesson 25 may be claimed — the learner never said they
  // had done it, and claiming it would skip them past unlearned material.
  const unstudied = Array.from({ length: TOTAL_LESSONS - COMPLETED_LESSONS }, (_, i) =>
    lexemeId(COMPLETED_LESSONS + i, 0));
  check(
    'lessons beyond the claim are untouched',
    unstudied.every((id) => !vocabById.has(id)),
  );

  console.log('\nThe time gradient (the point of the whole feature):');
  const firstLessonWord = vocabById.get(lexemeId(0, 0));
  const lastLessonWord = vocabById.get(lexemeId(COMPLETED_LESSONS - 1, 0));
  check('lesson 1 vocabulary exists', !!firstLessonWord);
  check(`lesson ${COMPLETED_LESSONS} vocabulary exists`, !!lastLessonWord);

  if (firstLessonWord && lastLessonWord) {
    const firstDue = new Date(firstLessonWord.due).getTime();
    const lastDue = new Date(lastLessonWord.due).getTime();
    const daysOverdue = (now - firstDue) / 86_400_000;
    const daysUntil = (lastDue - now) / 86_400_000;

    check(
      'lesson 1 vocabulary is already overdue',
      firstDue < now,
      `${daysOverdue.toFixed(1)} days overdue`,
    );
    check(
      `lesson ${COMPLETED_LESSONS} vocabulary is not due yet`,
      lastDue > now,
      `due in ${daysUntil.toFixed(1)} days`,
    );
    check(
      'earlier material is due before later material',
      firstDue < lastDue,
    );
    check(
      'lesson 1 has lower predicted retention than lesson 25',
      firstLessonWord.comprehensionSignal < lastLessonWord.comprehensionSignal,
      `${firstLessonWord.comprehensionSignal.toFixed(3)} vs ${lastLessonWord.comprehensionSignal.toFixed(3)}`,
    );
  }

  console.log('\nIdempotency:');
  const second = await reconcileSourceProgress(USER_ID, SOURCE_ID);
  const vocabAfter = await db.query.userVocabulary.findMany({
    where: eq(userVocabulary.userId, USER_ID),
  });
  check('re-running does not duplicate vocabulary', vocabAfter.length === vocab.length,
    `${vocab.length} -> ${vocabAfter.length}`);
  check('re-running keeps the same active chunk', second.activeChunkOrd === result.activeChunkOrd);

  console.log('\nConflict policy (observation beats claim):');
  // Promote one word to conversation-earned with distinctive state, then
  // re-reconcile: it must survive untouched.
  const guarded = lexemeId(2, 0);
  await db.update(userVocabulary)
    .set({ origin: 'conversation', stability: 99, reps: 7 })
    .where(and(eq(userVocabulary.userId, USER_ID), eq(userVocabulary.lexemeId, guarded)));
  const third = await reconcileSourceProgress(USER_ID, SOURCE_ID);
  const guardedRow = await db.query.userVocabulary.findFirst({
    where: and(eq(userVocabulary.userId, USER_ID), eq(userVocabulary.lexemeId, guarded)),
  });
  check('a conversation-earned row is not overwritten by re-seeding',
    guardedRow?.stability === 99 && guardedRow?.reps === 7,
    `stability ${guardedRow?.stability}, reps ${guardedRow?.reps}`);
  check('and it is reported as skipped', third.lexemesSkippedObserved > 0,
    `${third.lexemesSkippedObserved} skipped`);

  console.log('\nCleaning up...');
  await cleanup();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Verification script failed:', err);
  await cleanup().catch(() => {});
  process.exit(1);
});
