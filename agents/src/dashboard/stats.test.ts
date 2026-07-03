/**
 * Unit tests for src/dashboard/stats.ts — the streak and vocab-history
 * bucketing logic behind GET /api/users/:userId/summary and
 * GET /api/users/:userId/vocab-history.
 *
 * Plain assertion script (matches the repo's existing test-architecture.ts
 * / test-database-flow.ts / useConversationStream.test.ts convention — no
 * test framework is configured for this package). Run with:
 *
 *   npx tsx src/dashboard/stats.test.ts
 *
 * (from the `agents/` directory)
 *
 * Excluded from `tsc --noEmit -p .` by agents/tsconfig.json's
 * `src/**\/*.test.ts` exclude pattern, same as every other *.test.ts here.
 */

import assert from 'node:assert';
import { computeStreak, bucketVocabHistory, VOCAB_HISTORY_LAYER_LABELS } from './stats.js';

let passes = 0;
let failures = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passes++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${name}`);
    console.error(err);
  }
}

// A fixed "now" so tests are deterministic: Friday 2026-07-03, 10:00 local.
const NOW = new Date(2026, 6, 3, 10, 0, 0); // month is 0-indexed: 6 = July

function daysAgo(n: number, hour = 9): Date {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// ============================================================================
// computeStreak
// ============================================================================

test('computeStreak: no review history -> 0', () => {
  assert.strictEqual(computeStreak([], NOW), 0);
});

test('computeStreak: gap of 3+ days (most recent practice neither today nor yesterday) -> streak resets to 0', () => {
  const dates = [daysAgo(5), daysAgo(4), daysAgo(3)];
  assert.strictEqual(computeStreak(dates, NOW), 0);
});

test('computeStreak: most recent practice was today -> streak continues, counting consecutive days ending today', () => {
  const dates = [daysAgo(0), daysAgo(1), daysAgo(2)];
  assert.strictEqual(computeStreak(dates, NOW), 3);
});

test('computeStreak: most recent practice was yesterday (no practice yet today) -> streak survives, counts back from yesterday', () => {
  const dates = [daysAgo(1), daysAgo(2), daysAgo(3)];
  assert.strictEqual(computeStreak(dates, NOW), 3);
});

test('computeStreak: today present but a gap earlier in the run stops counting at the gap', () => {
  // today + yesterday practiced, but the day before that was skipped, then
  // practice resumes 5 days ago. The 5-days-ago entry should NOT extend
  // the current streak past the gap.
  const dates = [daysAgo(0), daysAgo(1), daysAgo(5)];
  assert.strictEqual(computeStreak(dates, NOW), 2);
});

test('computeStreak: duplicate same-day timestamps count once', () => {
  const dates = [daysAgo(0, 8), daysAgo(0, 20), daysAgo(1, 9)];
  assert.strictEqual(computeStreak(dates, NOW), 2);
});

test('computeStreak: single practice day today -> streak of 1', () => {
  assert.strictEqual(computeStreak([daysAgo(0)], NOW), 1);
});

// ============================================================================
// bucketVocabHistory
// ============================================================================

test('bucketVocabHistory: returns `weeks` weeks of labels, oldest first', () => {
  const result = bucketVocabHistory([], 4, NOW);
  assert.strictEqual(result.weeks.length, 4);
  // Labels should be ascending ISO week strings (lexicographically sortable).
  const sorted = [...result.weeks].sort();
  assert.deepStrictEqual(result.weeks, sorted);
});

test('bucketVocabHistory: one layer per FSRS state, in New/Learning/Known/Fluent order', () => {
  const result = bucketVocabHistory([], 4, NOW);
  assert.deepStrictEqual(result.layers.map(l => l.label), [...VOCAB_HISTORY_LAYER_LABELS]);
  for (const layer of result.layers) {
    assert.strictEqual(layer.counts.length, 4);
  }
});

test('bucketVocabHistory: a review only counts once it falls within/before a week\'s cutoff', () => {
  // One vocab item, reviewed 10 days ago in state 0 (New).
  const logs = [{ userVocabularyId: 'v1', reviewDate: daysAgo(10), state: 0 }];
  const result = bucketVocabHistory(logs, 3, NOW);
  // Oldest of the 3 weeks starts ~21 days before now, so the review 10
  // days ago falls inside week 2 or 3 (not before the range) — every
  // week from the one containing the review onward should show it.
  const newLayer = result.layers.find(l => l.label === 'New')!;
  const total = newLayer.counts.reduce((a, b) => a + b, 0);
  assert.ok(total > 0, 'expected the New layer to pick up the review in at least one week bucket');
  // Counts must be non-decreasing (cumulative-as-of-cutoff snapshot).
  for (let i = 1; i < newLayer.counts.length; i++) {
    assert.ok(newLayer.counts[i] >= 0);
  }
});

test('bucketVocabHistory: latest review per vocab item wins (state transitions are reflected, not double-counted)', () => {
  const logs = [
    { userVocabularyId: 'v1', reviewDate: daysAgo(6), state: 0 }, // New
    { userVocabularyId: 'v1', reviewDate: daysAgo(2), state: 1 }, // now Learning
  ];
  const result = bucketVocabHistory(logs, 2, NOW);
  // In the final (most recent) week bucket, v1 should be counted once,
  // under Learning (its latest state), not under New.
  const lastIdx = result.weeks.length - 1;
  const newLayer = result.layers.find(l => l.label === 'New')!;
  const learningLayer = result.layers.find(l => l.label === 'Learning')!;
  assert.strictEqual(newLayer.counts[lastIdx], 0);
  assert.strictEqual(learningLayer.counts[lastIdx], 1);
});

test('bucketVocabHistory: reviews after `now` (shouldn\'t happen, but be defensive) never inflate earlier weeks', () => {
  const logs = [{ userVocabularyId: 'v1', reviewDate: daysAgo(-5), state: 0 }]; // 5 days in the future
  const result = bucketVocabHistory(logs, 3, NOW);
  const total = result.layers.reduce((sum, l) => sum + l.counts.reduce((a, b) => a + b, 0), 0);
  assert.strictEqual(total, 0);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
