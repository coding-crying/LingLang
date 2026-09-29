/**
 * Unit tests for StrayGenerationGuard (realtime S2S double-speak suppression).
 *
 * Plain assertion script, same convention as src/lib/realtime-utterances.test.ts.
 * Run with:
 *
 *   npx tsx src/lib/stray-generation-guard.test.ts
 */

import {
  StrayGenerationGuard,
  STRAY_GENERATION_WINDOW_MS,
  TOOL_REPLY_GRACE_MS,
} from './stray-generation-guard.js';

let failures = 0;
let passes = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) passes++;
  else {
    failures++;
    console.error(`✗ FAIL: ${msg}`);
  }
}

// ============================================================================
// Test 1: the live bug — greeting, then a stray second generation
//
// 2026-09-09 15:57 gritz session: gen A "Hey, so," ends, 0.6s later gen B
// "how's it going today?" starts with no learner speech. Must cancel B.
// ============================================================================
function testGreetingSplitIsCancelled(): void {
  const g = new StrayGenerationGuard();
  const t0 = 1_000_000;

  assert(g.onGenerationStart(t0) === false, 'first generation (greeting) is never cancelled');
  g.noteAgentTurnEnded(t0 + 600);
  assert(g.onGenerationStart(t0 + 1200) === true, 'second generation with no learner speech is cancelled');
}

// ============================================================================
// Test 2: a normal reply is never cancelled
// ============================================================================
function testNormalReplySurvives(): void {
  const g = new StrayGenerationGuard();
  const t0 = 2_000_000;

  g.onGenerationStart(t0); // opening greeting
  g.noteAgentTurnEnded(t0 + 500);
  g.noteLearnerSpeech();
  assert(g.onGenerationStart(t0 + 3000) === false, 'generation after learner speech plays');
}

// ============================================================================
// Test 3: barge-in — learner speaks again during the agent's turn
// ============================================================================
function testBargeInReplySurvives(): void {
  const g = new StrayGenerationGuard();
  const t0 = 3_000_000;

  g.onGenerationStart(t0);            // greeting
  g.noteAgentTurnEnded(t0 + 400);
  g.noteLearnerSpeech();
  g.onGenerationStart(t0 + 2000);     // reply A — allowed, consumes the turn
  g.noteLearnerSpeech();              // learner barges in
  g.noteAgentTurnEnded(t0 + 2500);
  assert(g.onGenerationStart(t0 + 3000) === false, 'reply B after barge-in plays');
}

// ============================================================================
// Test 4: tool-call follow-up generation plays
// ============================================================================
function testToolReplySurvives(): void {
  const t0 = 4_000_000;

  // Control: identical timeline with no tool executed → the follow-up
  // generation is (correctly) a stray. This proves the tool grace, not the
  // 8s window, is what saves the real tool reply below.
  const control = new StrayGenerationGuard();
  control.onGenerationStart(t0);
  control.noteAgentTurnEnded(t0 + 400);
  control.noteLearnerSpeech();
  control.onGenerationStart(t0 + 1000);   // tool-call generation
  control.noteAgentTurnEnded(t0 + 1200);
  assert(control.onGenerationStart(t0 + 1500) === true, 'control: no tool grace → stray');

  const g = new StrayGenerationGuard();
  g.onGenerationStart(t0);
  g.noteAgentTurnEnded(t0 + 400);
  g.noteLearnerSpeech();
  g.onGenerationStart(t0 + 1000);         // tool-call generation
  g.noteToolExecuted(t0 + 1100);
  g.noteAgentTurnEnded(t0 + 1200);
  assert(g.onGenerationStart(t0 + 1500) === false, 'generation after a tool call plays');
  assert(TOOL_REPLY_GRACE_MS > STRAY_GENERATION_WINDOW_MS, 'grace covers a slow tool reply');
}

// ============================================================================
// Test 5: a prompt after a long silence is legitimate tutor behaviour
// ============================================================================
function testLongSilencePromptSurvives(): void {
  const g = new StrayGenerationGuard();
  const t0 = 5_000_000;

  g.onGenerationStart(t0);
  g.noteAgentTurnEnded(t0 + 500);
  assert(
    g.onGenerationStart(t0 + 500 + STRAY_GENERATION_WINDOW_MS + 1) === false,
    'generation after >8s of silence is left alone',
  );
}

// ============================================================================
// Test 6: the learner's turn is consumed — a second stray after a reply is
// still cancelled
// ============================================================================
function testLearnerFlagIsConsumed(): void {
  const g = new StrayGenerationGuard();
  const t0 = 6_000_000;

  g.onGenerationStart(t0);
  g.noteAgentTurnEnded(t0 + 300);
  g.noteLearnerSpeech();
  g.onGenerationStart(t0 + 1000);     // real reply
  g.noteAgentTurnEnded(t0 + 2000);
  assert(g.onGenerationStart(t0 + 2200) === true, 'stray after the real reply is cancelled');
}

// ============================================================================
// Test 7: with no previous agent turn there is nothing to be a stray of
// ============================================================================
function testNoPreviousTurn(): void {
  const g = new StrayGenerationGuard();
  assert(g.onGenerationStart(7_000_000) === false, 'first generation plays');
  assert(g.onGenerationStart(7_000_100) === false, 'no recorded turn end → not cancelled');
}

// ============================================================================
// Run
// ============================================================================

testGreetingSplitIsCancelled();
testNormalReplySurvives();
testBargeInReplySurvives();
testToolReplySurvives();
testLongSilencePromptSurvives();
testLearnerFlagIsConsumed();
testNoPreviousTurn();

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
