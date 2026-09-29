import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  estimateFromIndependentEvidence,
  summarizeIndependentEvidence,
} from './level-estimator.js';

const record = (eventId: string, sessionId: string, lemma: string, grade: 1 | 3 = 3) => ({
  eventId,
  sessionId,
  lemma,
  grade,
});

test('no independent evidence stays below A1', () => {
  const summary = summarizeIndependentEvidence([]);
  const estimate = estimateFromIndependentEvidence(summary);
  assert.equal(estimate.level, 'pre_a1');
  assert.equal(estimate.confidence, 0);
  assert.equal(estimate.basis, 'no_independent_evidence');
});

test('legacy-looking vocabulary volume cannot create proficiency', () => {
  const records = Array.from({ length: 200 }, (_, i) =>
    record(`e${i}`, 'one-session', `word-${i}`),
  );
  const estimate = estimateFromIndependentEvidence(summarizeIndependentEvidence(records));
  assert.equal(estimate.level, 'a1');
  assert.ok(estimate.confidence < 0.85);
});

test('independent beginner evidence can reach A2 but never B-level from lexemes alone', () => {
  const records = Array.from({ length: 12 }, (_, i) =>
    record(`e${i}`, `s${Math.floor(i / 3)}`, `word-${i}`),
  );
  const estimate = estimateFromIndependentEvidence(summarizeIndependentEvidence(records));
  assert.equal(estimate.level, 'a2');
  assert.ok(estimate.confidence <= 0.85);
});

test('failures and duplicate optimistic observations are handled conservatively', () => {
  const records = [
    record('e1', 's1', 'cafe', 3),
    record('e1', 's1', 'cafe', 1),
    record('e2', 's2', 'pao', 3),
    record('e3', 's3', 'agua', 1),
  ];
  const summary = summarizeIndependentEvidence(records);
  assert.equal(summary.observations, 3);
  assert.equal(summary.successes, 1);
  assert.equal(summary.failures, 2);
  assert.equal(summary.uniqueLexemes, 3);
  assert.equal(estimateFromIndependentEvidence(summary).level, 'pre_a1');
});

test('a single session cannot satisfy A2 breadth even with many words', () => {
  const records = Array.from({ length: 30 }, (_, i) => record(`e${i}`, 's1', `word-${i}`));
  const summary = summarizeIndependentEvidence(records);
  assert.equal(summary.independentSessions, 1);
  assert.equal(estimateFromIndependentEvidence(summary).level, 'a1');
});
