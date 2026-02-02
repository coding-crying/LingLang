#!/usr/bin/env tsx
/**
 * Database Flow Test
 *
 * Tests the full supervisor → database pipeline:
 * 1. Analyze an utterance
 * 2. Update SRS levels
 * 3. Check goal updates
 * 4. Verify database writes
 */

import { runSupervisor } from './src/tools/supervisor-functions.js';
import { ContextManager } from './src/lib/context.js';
import { db } from './src/db/index.js';
import { users, lexemes, learningProgress, activeGoals } from './src/db/schema.js';
import { eq, and } from 'drizzle-orm';

const TEST_USER_ID = 'test-db-flow-user';

async function setupTestUser() {
  console.log('\n🔧 Setting up test user...');

  // Delete existing test data
  await db.delete(learningProgress).where(eq(learningProgress.userId, TEST_USER_ID));
  await db.delete(activeGoals).where(eq(activeGoals.userId, TEST_USER_ID));
  await db.delete(users).where(eq(users.id, TEST_USER_ID));

  // Create fresh test user
  await db.insert(users).values({
    id: TEST_USER_ID,
    createdAt: Date.now(),
    targetLanguage: 'ru',
    nativeLanguage: 'en',
    proficiencyLevel: 'beginner',
  });

  console.log('✅ Test user created');
}

async function testSupervisisorAnalysis() {
  console.log('\n📊 Testing supervisor analysis...');

  const utterance = 'Я хочу воду';
  const context = 'User is practicing Russian basics';

  const result = await runSupervisor(TEST_USER_ID, utterance, context, {
    useGemini: false,  // Use local LLM only
    llmUrl: 'http://localhost:11434/v1',
  });

  console.log('\nAnalysis Result:');
  console.log('  Lexemes found:', result.analysis?.lexemes?.length || 0);
  console.log('  SRS updates:', result.srsUpdates.length);
  console.log('  Goal update:', result.goalUpdate ? 'YES' : 'NO');
  console.log('  Errors:', result.errors.length);

  if (result.analysis) {
    console.log('\nDetected lexemes:');
    for (const lex of result.analysis.lexemes) {
      console.log(`  - ${lex.lemma} (${lex.pos}): ${lex.performance}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('\n⚠️  Errors:', result.errors);
  }

  return result;
}

async function verifyDatabaseWrites(userId: string) {
  console.log('\n🔍 Verifying database writes...');

  // Check learning progress
  const progress = await db.query.learningProgress.findMany({
    where: eq(learningProgress.userId, userId),
    with: { lexeme: true }
  });

  console.log(`\nLearning Progress (${progress.length} entries):`);
  for (const p of progress) {
    console.log(`  - ${p.lexeme.lemma}: SRS ${p.srsLevel}, encounters: ${p.encounters}, correct: ${p.correctUses}`);
  }

  // Check active goals
  const goals = await db.query.activeGoals.findMany({
    where: eq(activeGoals.userId, userId),
  });

  console.log(`\nActive Goals (${goals.length} entries):`);
  for (const g of goals) {
    console.log(`  - ${g.type}: target ${g.targetId}, status: ${g.status}`);
  }

  return { progress, goals };
}

async function testGoalCycle() {
  console.log('\n🎯 Testing goal cycle...');

  const goal = await ContextManager.getDynamicGoal(TEST_USER_ID);

  if (goal) {
    console.log('\nGoal Generated:');
    console.log(goal);
  } else {
    console.log('\n No goal generated (expected if no curriculum data)');
  }

  return goal;
}

async function testMultipleUtterances() {
  console.log('\n🔄 Testing multiple utterances...');

  const utterances = [
    'Я говорю по-русски',
    'Мне нравится учиться',
    'Привет! Как дела?',
  ];

  for (let i = 0; i < utterances.length; i++) {
    console.log(`\n[Turn ${i + 1}] Processing: "${utterances[i]}"`);

    const result = await runSupervisor(TEST_USER_ID, utterances[i], '', {
      useGemini: false,
    });

    console.log(`  ✓ ${result.srsUpdates.length} SRS updates`);

    // Wait a bit between utterances (simulate real conversation)
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function checkCurriculumData() {
  console.log('\n📚 Checking curriculum data...');

  const allLexemes = await db.query.lexemes.findMany({
    where: eq(lexemes.language, 'ru'),
    limit: 10
  });

  console.log(`\nRussian lexemes in database: ${allLexemes.length}`);
  if (allLexemes.length > 0) {
    console.log('Sample lexemes:');
    for (const lex of allLexemes.slice(0, 5)) {
      console.log(`  - ${lex.lemma} (${lex.pos}): ${lex.translation}`);
    }
  } else {
    console.log('⚠️  No Russian lexemes found! Database may be empty.');
    console.log('   Run Duolingo import or seed data first.');
  }

  return allLexemes.length;
}

// Main test sequence
async function main() {
  console.log('═'.repeat(60));
  console.log('DATABASE FLOW TEST');
  console.log('═'.repeat(60));

  try {
    // 1. Setup
    await setupTestUser();

    // 2. Check if we have curriculum data
    const lexemeCount = await checkCurriculumData();

    if (lexemeCount === 0) {
      console.log('\n⚠️  Skipping analysis tests - no curriculum data');
      console.log('   Import Duolingo data first:');
      console.log('   npx tsx src/scripts/sync-duolingo.ts <user_id> --jwt <token> --username <name> --lang ru');
    } else {
      // 3. Test single utterance analysis
      const result = await testSupervisisorAnalysis();

      // 4. Verify database writes
      await verifyDatabaseWrites(TEST_USER_ID);

      // 5. Test goal cycle
      await testGoalCycle();

      // 6. Test multiple utterances
      await testMultipleUtterances();

      // 7. Final verification
      console.log('\n' + '═'.repeat(60));
      console.log('FINAL DATABASE STATE');
      console.log('═'.repeat(60));
      await verifyDatabaseWrites(TEST_USER_ID);
    }

    console.log('\n✅ Test complete!');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

main();
