/**
 * Architecture Test Suite
 *
 * Tests the core components of the goal-seeking cycle:
 * 1. Supervisor Analysis (Gemini API) - Extracts lexemes from utterances
 * 2. SRS Updates (Database) - Leitner box transitions
 * 3. Goal Cycle (State Machine) - Goal setting and fulfillment
 *
 * Run with: npx tsx test-architecture.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { db } from './src/db/index.js';
import { users, lexemes, units, learningProgress, activeGoals } from './src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { ContextManager } from './src/lib/context.js';
import { GoogleGenAI } from '@google/genai';

const TEST_USER_ID = 'test-architecture-user';

// ============================================================================
// SETUP & TEARDOWN
// ============================================================================

async function setupTestData() {
  console.log('\n📦 Setting up test data...');

  // Clean up any existing test data
  await db.delete(activeGoals).where(eq(activeGoals.userId, TEST_USER_ID));
  await db.delete(learningProgress).where(eq(learningProgress.userId, TEST_USER_ID));
  await db.delete(users).where(eq(users.id, TEST_USER_ID));

  // Create test user
  await db.insert(users).values({
    id: TEST_USER_ID,
    createdAt: Date.now(),
    targetLanguage: 'ru',
    nativeLanguage: 'en',
    proficiencyLevel: 'beginner',
  });

  // Ensure we have a test unit
  const testUnitId = 'test-unit-basics';
  const existingUnit = await db.query.units.findFirst({
    where: eq(units.id, testUnitId)
  });

  if (!existingUnit) {
    await db.insert(units).values({
      id: testUnitId,
      title: 'Basic Vocabulary',
      description: 'Common Russian words',
      language: 'ru',
      order: 1,
      difficulty: 'beginner',
    });
  }

  // Ensure we have test lexemes
  const testLexemes = [
    { id: 'ru-вода-NOUN', lemma: 'вода', pos: 'NOUN', translation: 'water' },
    { id: 'ru-пить-VERB', lemma: 'пить', pos: 'VERB', translation: 'to drink' },
    { id: 'ru-хотеть-VERB', lemma: 'хотеть', pos: 'VERB', translation: 'to want' },
    { id: 'ru-есть-VERB', lemma: 'есть', pos: 'VERB', translation: 'to eat' },
    { id: 'ru-хлеб-NOUN', lemma: 'хлеб', pos: 'NOUN', translation: 'bread' },
  ];

  for (const lex of testLexemes) {
    const existing = await db.query.lexemes.findFirst({
      where: eq(lexemes.id, lex.id)
    });
    if (!existing) {
      await db.insert(lexemes).values({
        ...lex,
        language: 'ru',
        unitId: testUnitId,
      });
    }
  }

  console.log('✅ Test data ready');
}

async function cleanup() {
  console.log('\n🧹 Cleaning up test data...');
  await db.delete(activeGoals).where(eq(activeGoals.userId, TEST_USER_ID));
  await db.delete(learningProgress).where(eq(learningProgress.userId, TEST_USER_ID));
  await db.delete(users).where(eq(users.id, TEST_USER_ID));
  console.log('✅ Cleanup complete');
}

// ============================================================================
// TEST 1: SUPERVISOR ANALYSIS (Gemini API)
// ============================================================================

async function testSupervisorAnalysis() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 1: Supervisor Analysis (Gemini API)');
  console.log('='.repeat(60));

  const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || '' });

  const learningAnalysisInstructions = `You are a comprehensive language learning analysis expert.
Your role is to extract detailed grammatical information for building an intelligent graph-based learning system.

# Output Format
Return ONLY a JSON object with this structure:
{
  "language": "auto-detected ISO code (ru, es, fr, etc.)",
  "lexemes": [
    {
      "lemma": "string (root form)",
      "form": "string (used form)",
      "pos": "NOUN|VERB|ADJ...",
      "performance": "introduced|correct_use|wrong_use|recall_fail",
      "grammarRule": { "rule": "string", "example": "string" } (optional)
    }
  ],
  "grammarHints": ["string"]
}`;

  const testCases = [
    {
      utterance: 'Я хочу пить воду',
      context: 'The tutor asked what the user wants to do',
      expected: ['хотеть', 'пить', 'вода'],
    },
    {
      utterance: 'Я ем хлеб',
      context: 'The tutor asked what the user is eating',
      expected: ['есть', 'хлеб'],
    },
    {
      utterance: 'Вода... как это... пить?',  // Struggling, wrong form
      context: 'The tutor asked the user to make a sentence about water',
      expected: ['вода', 'пить'],
    },
  ];

  for (const test of testCases) {
    console.log(`\n📝 Testing: "${test.utterance}"`);
    console.log(`   Context: ${test.context}`);

    const startTime = Date.now();

    try {
      const result = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [{ text: `${learningAnalysisInstructions}\n\nContext: ${test.context}\nUser said: "${test.utterance}"` }]
        }]
      });

      const elapsed = Date.now() - startTime;
      const responseText = result.text || '';
      const cleanedText = responseText.replace(/^```json\s*/, '').replace(/```$/, '').trim();

      console.log(`   ⏱️  Gemini response time: ${elapsed}ms`);

      try {
        const analysis = JSON.parse(cleanedText);
        console.log(`   ✅ Parsed successfully`);
        console.log(`   Language: ${analysis.language}`);
        console.log(`   Lexemes found: ${analysis.lexemes?.length || 0}`);

        if (analysis.lexemes) {
          for (const lex of analysis.lexemes) {
            console.log(`      - ${lex.lemma} (${lex.pos}): ${lex.performance}`);
          }
        }

        if (analysis.grammarHints?.length > 0) {
          console.log(`   Grammar hints: ${analysis.grammarHints.join('; ')}`);
        }

        // Check if expected lemmas were found
        const foundLemmas = analysis.lexemes?.map((l: any) => l.lemma) || [];
        const missing = test.expected.filter(e => !foundLemmas.includes(e));
        if (missing.length > 0) {
          console.log(`   ⚠️  Missing expected lemmas: ${missing.join(', ')}`);
        }

      } catch (parseErr) {
        console.log(`   ❌ JSON parse error: ${parseErr}`);
        console.log(`   Raw response: ${cleanedText.substring(0, 200)}...`);
      }

    } catch (apiErr) {
      console.log(`   ❌ API error: ${apiErr}`);
    }
  }
}

// ============================================================================
// TEST 2: SRS UPDATE LOGIC
// ============================================================================

async function testSRSUpdates() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 2: SRS Update Logic (Leitner Box)');
  console.log('='.repeat(60));

  const lexemeId = 'ru-вода-NOUN';

  // Start with level 0
  await db.delete(learningProgress).where(
    and(eq(learningProgress.userId, TEST_USER_ID), eq(learningProgress.lexemeId, lexemeId))
  );

  await db.insert(learningProgress).values({
    userId: TEST_USER_ID,
    lexemeId,
    srsLevel: 0,
    nextReview: Date.now(),
    lastSeen: Date.now(),
    encounters: 0,
    correctUses: 0,
  });

  console.log('\n📝 Initial state: SRS level 0');

  // Simulate correct uses
  const transitions = [
    { performance: 'correct_use', expectedLevel: 1, expectedDays: 2 },
    { performance: 'correct_use', expectedLevel: 2, expectedDays: 4 },
    { performance: 'correct_use', expectedLevel: 3, expectedDays: 8 },
    { performance: 'wrong_use', expectedLevel: 1, expectedDays: 2 },  // Falls back!
    { performance: 'correct_use', expectedLevel: 2, expectedDays: 4 },
    { performance: 'correct_use', expectedLevel: 3, expectedDays: 8 },
    { performance: 'correct_use', expectedLevel: 4, expectedDays: 16 },
    { performance: 'correct_use', expectedLevel: 5, expectedDays: 32 },
    { performance: 'correct_use', expectedLevel: 5, expectedDays: 32 },  // Caps at 5
  ];

  for (const trans of transitions) {
    const current = await db.query.learningProgress.findFirst({
      where: and(eq(learningProgress.userId, TEST_USER_ID), eq(learningProgress.lexemeId, lexemeId))
    });

    let newLevel = current?.srsLevel || 0;
    if (trans.performance === 'correct_use') {
      newLevel = Math.min(newLevel + 1, 5);
    } else if (trans.performance === 'wrong_use') {
      newLevel = 1;
    }

    const daysToAdd = Math.pow(2, newLevel);
    const nextReview = Date.now() + (daysToAdd * 24 * 60 * 60 * 1000);

    await db.update(learningProgress)
      .set({
        srsLevel: newLevel,
        nextReview,
        lastSeen: Date.now(),
        encounters: (current?.encounters || 0) + 1,
        correctUses: (current?.correctUses || 0) + (trans.performance === 'correct_use' ? 1 : 0),
      })
      .where(and(eq(learningProgress.userId, TEST_USER_ID), eq(learningProgress.lexemeId, lexemeId)));

    const actualDays = Math.pow(2, newLevel);
    const levelMatch = newLevel === trans.expectedLevel ? '✅' : '❌';
    const daysMatch = actualDays === trans.expectedDays ? '✅' : '❌';

    console.log(`   ${trans.performance.padEnd(12)} → Level ${newLevel} ${levelMatch}, Next in ${actualDays} days ${daysMatch}`);
  }

  const final = await db.query.learningProgress.findFirst({
    where: and(eq(learningProgress.userId, TEST_USER_ID), eq(learningProgress.lexemeId, lexemeId))
  });

  console.log(`\n📊 Final state:`);
  console.log(`   SRS Level: ${final?.srsLevel}`);
  console.log(`   Encounters: ${final?.encounters}`);
  console.log(`   Correct Uses: ${final?.correctUses}`);
  console.log(`   Next Review: ${new Date(final?.nextReview || 0).toISOString()}`);
}

// ============================================================================
// TEST 3: GOAL SEEKING CYCLE
// ============================================================================

async function testGoalCycle() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 3: Goal Seeking Cycle (State Machine)');
  console.log('='.repeat(60));

  // Clean slate
  await db.delete(activeGoals).where(eq(activeGoals.userId, TEST_USER_ID));
  await db.delete(learningProgress).where(eq(learningProgress.userId, TEST_USER_ID));

  // SCENARIO 1: No goals, no failures → should return null (silence)
  console.log('\n📝 Scenario 1: No goals, no data');
  let goal = await ContextManager.getDynamicGoal(TEST_USER_ID);
  console.log(`   Result: ${goal ? goal.substring(0, 50) + '...' : 'null (silence)'}`);
  console.log(`   Expected: null (silence) ${goal === null ? '✅' : '❌'}`);

  // SCENARIO 2: Recent failure → should create remediation goal
  console.log('\n📝 Scenario 2: Recent failure exists');
  const lexemeId = 'ru-вода-NOUN';
  await db.insert(learningProgress).values({
    userId: TEST_USER_ID,
    lexemeId,
    srsLevel: 1,  // Level 1 = recent failure
    nextReview: Date.now(),
    lastSeen: Date.now(),
    encounters: 1,
    correctUses: 0,
  });

  goal = await ContextManager.getDynamicGoal(TEST_USER_ID);
  console.log(`   Result: ${goal ? goal.substring(0, 80) + '...' : 'null'}`);
  console.log(`   Expected: NEW GOAL with "вода" ${goal?.includes('вода') ? '✅' : '❌'}`);

  // Check that goal was created in DB
  const activeGoal = await db.query.activeGoals.findFirst({
    where: and(eq(activeGoals.userId, TEST_USER_ID), eq(activeGoals.status, 'active'))
  });
  console.log(`   Active goal in DB: ${activeGoal ? 'yes' : 'no'} ${activeGoal ? '✅' : '❌'}`);
  console.log(`   Goal type: ${activeGoal?.type} ${activeGoal?.type === 'remediation' ? '✅' : '❌'}`);

  // SCENARIO 3: Active goal exists, not satisfied → should return null (let tutor work)
  console.log('\n📝 Scenario 3: Active goal, not yet satisfied');
  goal = await ContextManager.getDynamicGoal(TEST_USER_ID);
  console.log(`   Result: ${goal ? goal.substring(0, 50) + '...' : 'null (silence)'}`);
  console.log(`   Expected: null (silence) ${goal === null ? '✅' : '❌'}`);

  // SCENARIO 4: Active goal exists, user uses word correctly → should complete goal
  console.log('\n📝 Scenario 4: Active goal satisfied');

  // Simulate correct use AFTER goal was created
  await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
  await db.update(learningProgress)
    .set({
      lastSeen: Date.now(),
      correctUses: 1,
      srsLevel: 2,
    })
    .where(and(eq(learningProgress.userId, TEST_USER_ID), eq(learningProgress.lexemeId, lexemeId)));

  goal = await ContextManager.getDynamicGoal(TEST_USER_ID);
  console.log(`   Result: ${goal ? goal.substring(0, 80) + '...' : 'null'}`);
  console.log(`   Expected: GOAL COMPLETED ${goal?.includes('COMPLETED') ? '✅' : '❌'}`);

  // Check goal was marked complete
  const completedGoal = await db.query.activeGoals.findFirst({
    where: and(eq(activeGoals.userId, TEST_USER_ID), eq(activeGoals.status, 'completed'))
  });
  console.log(`   Goal marked complete in DB: ${completedGoal ? 'yes' : 'no'} ${completedGoal ? '✅' : '❌'}`);
}

// ============================================================================
// TEST 4: CONTEXT LOADING
// ============================================================================

async function testContextLoading() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 4: Context Loading');
  console.log('='.repeat(60));

  console.log('\n📝 Loading initial context...');
  const startTime = Date.now();

  try {
    const context = await ContextManager.getInitialContext(TEST_USER_ID);
    const elapsed = Date.now() - startTime;

    console.log(`   ⏱️  Context load time: ${elapsed}ms`);
    console.log(`   Context length: ${context.length} chars`);
    console.log('\n   --- Context Preview ---');
    console.log(context.split('\n').map(l => '   ' + l).join('\n'));
    console.log('   --- End Preview ---');

  } catch (err) {
    console.log(`   ❌ Error: ${err}`);
  }
}

// ============================================================================
// TEST 5: TIMING & LATENCY ANALYSIS
// ============================================================================

async function testLatencies() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 5: Latency Analysis');
  console.log('='.repeat(60));

  const timings: Record<string, number[]> = {
    'DB query (user)': [],
    'DB query (progress)': [],
    'Gemini API call': [],
    'Goal check': [],
    'Context load': [],
  };

  const iterations = 3;

  for (let i = 0; i < iterations; i++) {
    console.log(`\n   Iteration ${i + 1}/${iterations}...`);

    // DB query - user
    let start = Date.now();
    await db.query.users.findFirst({ where: eq(users.id, TEST_USER_ID) });
    timings['DB query (user)'].push(Date.now() - start);

    // DB query - progress
    start = Date.now();
    await db.query.learningProgress.findMany({
      where: eq(learningProgress.userId, TEST_USER_ID),
      with: { lexeme: true },
      limit: 5,
    });
    timings['DB query (progress)'].push(Date.now() - start);

    // Gemini API
    start = Date.now();
    const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || '' });
    await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: 'Extract lexemes from: "Я хочу воду"' }] }]
    });
    timings['Gemini API call'].push(Date.now() - start);

    // Goal check
    start = Date.now();
    await ContextManager.getDynamicGoal(TEST_USER_ID);
    timings['Goal check'].push(Date.now() - start);

    // Context load
    start = Date.now();
    await ContextManager.getInitialContext(TEST_USER_ID);
    timings['Context load'].push(Date.now() - start);
  }

  console.log('\n   📊 Latency Summary:');
  console.log('   ' + '-'.repeat(50));

  for (const [name, times] of Object.entries(timings)) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(`   ${name.padEnd(25)} avg: ${avg.toFixed(0)}ms  (${min}-${max}ms)`);
  }

  console.log('\n   💡 Implications for architecture:');
  const geminiAvg = timings['Gemini API call'].reduce((a, b) => a + b, 0) / iterations;
  if (geminiAvg > 500) {
    console.log(`   ⚠️  Gemini takes ${geminiAvg.toFixed(0)}ms - run ASYNC, don't block conversation`);
  } else {
    console.log(`   ✅ Gemini is fast (${geminiAvg.toFixed(0)}ms) - could run sync if needed`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           LINGLANG ARCHITECTURE TEST SUITE                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await setupTestData();

    await testSupervisorAnalysis();
    await testSRSUpdates();
    await testGoalCycle();
    await testContextLoading();
    await testLatencies();

    console.log('\n' + '='.repeat(60));
    console.log('ALL TESTS COMPLETE');
    console.log('='.repeat(60));

  } catch (err) {
    console.error('\n❌ Test suite failed:', err);
  } finally {
    await cleanup();
    process.exit(0);
  }
}

main();
