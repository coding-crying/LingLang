/**
 * Test Processor/Supervisor optimization
 * Simulates conversation without LiveKit/TTS/STT
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupervisor } from './src/tools/supervisor-functions.js';
import { ContextManager } from './src/lib/context.js';
import { db } from './src/db/index.js';
import { users } from './src/db/schema.js';
import { eq } from 'drizzle-orm';

// Simulate conversation state
let turnCounter = 0;
let goalNeedsCheck = true;
const PROCESSOR_INTERVAL = 5;

// Test user utterances (mix of English and Russian)
const testUtterances = [
  "Hello",
  "Привет",
  "Я хочу воду",
  "I want water",
  "Спасибо",
  "Thank you",
  "Да, я хочу",
  "Yes I want",
  "Вода хорошая",
  "The water is good"
];

async function simulateTurn(userId: string, utterance: string) {
  turnCounter++;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Turn ${turnCounter}: "${utterance}"`);
  console.log('='.repeat(60));

  const shouldRunProcessor = turnCounter % PROCESSOR_INTERVAL === 0;

  // Check if we should queue analysis
  if (shouldRunProcessor || goalNeedsCheck) {
    console.log(`✓ Analysis queued (processor: ${shouldRunProcessor}, goal: ${goalNeedsCheck})`);

    // Simulate "agent finishes speaking" - run analysis
    let srsUpdates: any[] = [];

    // PROCESSOR: Analyze + update SRS (only every N turns)
    if (shouldRunProcessor) {
      console.log('\n[PROCESSOR] Running analysis...');
      const startTime = Date.now();

      const result = await runSupervisor(userId, utterance, '', {
        useGemini: false,
        llmUrl: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
      });

      const elapsed = Date.now() - startTime;
      srsUpdates = result.srsUpdates;

      console.log(`[PROCESSOR] Complete in ${elapsed}ms:`);
      console.log(`  - SRS updates: ${result.srsUpdates.length}`);
      console.log(`  - Errors: ${result.errors.length}`);

      if (result.errors.length > 0) {
        console.warn('  - Error details:', result.errors);
      }

      // If we updated SRS, goal might have changed
      if (srsUpdates.length > 0) {
        goalNeedsCheck = true;
        console.log('[PROCESSOR] SRS updated - marking goal for recheck');
      }
    }

    // SUPERVISOR: Check goals (only when dirty flag is set)
    if (goalNeedsCheck) {
      console.log('\n[SUPERVISOR] Checking goal status...');
      const startTime = Date.now();

      const goalUpdate = await ContextManager.getDynamicGoal(userId);
      goalNeedsCheck = false; // Reset flag

      const elapsed = Date.now() - startTime;
      console.log(`[SUPERVISOR] Complete in ${elapsed}ms`);

      if (goalUpdate) {
        console.log(`[SUPERVISOR] ✓ Goal update detected:`);
        console.log(`  "${goalUpdate.substring(0, 100)}..."`);

        // Check what type of goal update
        if (goalUpdate.includes('COMPLETED')) {
          console.log('[SUPERVISOR] → Goal completed! Need to check for new goal');
          goalNeedsCheck = true;
        } else if (goalUpdate.includes('NEW GOAL')) {
          console.log('[SUPERVISOR] → New goal set');
        }
      } else {
        console.log('[SUPERVISOR] No goal changes');
      }
    }
  } else {
    console.log(`✗ Skipping analysis (turn ${turnCounter}/${PROCESSOR_INTERVAL})`);
  }
}

async function main() {
  console.log('Testing Processor/Supervisor Optimization');
  console.log('==========================================\n');

  // Get or create test user
  const testUserId = 'test-user-' + Date.now();

  await db.insert(users).values({
    id: testUserId,
    nativeLanguage: 'en',
    targetLanguage: 'ru',
    currentUnitId: 'basics',
    createdAt: Date.now(),
  });

  console.log(`Created test user: ${testUserId}\n`);
  console.log(`Configuration:`);
  console.log(`  - Processor interval: Every ${PROCESSOR_INTERVAL} turns`);
  console.log(`  - Supervisor: Only when dirty flag is set`);
  console.log(`  - Initial dirty flag: ${goalNeedsCheck}\n`);

  // Simulate conversation
  for (const utterance of testUtterances) {
    await simulateTurn(testUserId, utterance);

    // Small delay to make it easier to read
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log(`Total turns: ${turnCounter}`);
  console.log(`Processor runs: ${Math.ceil(turnCounter / PROCESSOR_INTERVAL)}`);
  console.log(`Reduction: ${Math.round((1 - Math.ceil(turnCounter / PROCESSOR_INTERVAL) / turnCounter) * 100)}%`);

  process.exit(0);
}

main().catch(console.error);
