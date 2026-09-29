// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rating, createEmptyCard, fsrs } from 'ts-fsrs';
import type { Observation } from './contract.js';
import { candidateTrajectory } from './schedule.js';

const o: Observation = {
  lemma: 'café',
  form: 'café',
  language: 'pt',
  kind: 'production',
  assistance: 'none',
  outcome: 'succeeded',
  errorDomain: 'none',
  fluency: 'unavailable',
  ambiguity: null,
  evidence: [{ turnId: 'l', quote: 'café' }],
};
test('shadow trajectory uses pinned reference FSRS, ignores assistance and deduplicates events', () => {
  const e = {
    id: 'e',
    userId: 'u',
    language: 'pt',
    occurredAt: '2026-01-01T00:00:00Z',
    observations: [o],
  };
  const result = candidateTrajectory([
    e,
    e,
    { ...e, id: 'copy', observations: [{ ...o, assistance: 'answer_provided' }] },
  ]);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0]!.card.reps, 1);
  assert.equal(result.appliedToProduction, false);
  assert.deepEqual(
    result.cards[0]!.card,
    fsrs({ enable_fuzz: false }).next(
      createEmptyCard(new Date(e.occurredAt)),
      new Date(e.occurredAt),
      Rating.Good,
    ).card,
  );
  assert.equal(
    candidateTrajectory([{ ...e, observations: [{ ...o, kind: 'mention' }] }]).cards.length,
    0,
  );
});
