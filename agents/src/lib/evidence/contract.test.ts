// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packetHash, packetSchema, validateObservations } from './contract.js';

export const packet = {
  userId: 'test-user',
  sessionId: 'session',
  turnId: 'turn',
  language: 'pt',
  occurredAt: '2026-09-10T12:00:00.000Z',
  source: 'typed',
  turns: [
    { id: 'tutor-1', role: 'tutor', text: 'What would you order?' },
    { id: 'turn', role: 'learner', text: 'Eu quero café.' },
  ],
};
export const observation = {
  lemma: 'café',
  form: 'café',
  language: 'pt',
  kind: 'production',
  assistance: 'none',
  outcome: 'succeeded',
  errorDomain: 'none',
  fluency: 'unavailable',
  ambiguity: null,
  evidence: [
    { turnId: 'turn', quote: 'café' },
    { turnId: 'tutor-1', quote: 'What would you order?' },
  ],
};
test('validates a grounded independent production packet with stable identity', () => {
  assert.equal(packetSchema.parse(packet).language, 'pt');
  assert.deepEqual(
    validateObservations(packetSchema.parse(packet), { observations: [observation] }).observations,
    [observation],
  );
  assert.equal(
    packetHash(packetSchema.parse(packet)),
    packetHash(packetSchema.parse(JSON.parse(JSON.stringify(packet)))),
  );
});
test('rejects unsupported evidence instead of converting it into a grade', () => {
  const p = packetSchema.parse(packet);
  for (const change of [
    { evidence: [{ turnId: 'turn', quote: 'invented words' }] },
    { evidence: [{ turnId: 'absent', quote: 'café' }] },
    { language: 'ru' },
    { form: 'banana' },
    { fluency: 'fluent' },
    { evidence: [{ turnId: 'tutor-1', quote: 'What would you order?' }] },
  ])
    assert.throws(() => validateObservations(p, { observations: [{ ...observation, ...change }] }));
  assert.throws(() => validateObservations(p, { observations: [observation, observation] }));
  assert.throws(() => packetSchema.parse({ ...packet, turns: [packet.turns[0], packet.turns[0]] }));
});
