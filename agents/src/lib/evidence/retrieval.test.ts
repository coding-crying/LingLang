// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packetSchema } from './contract.js';
import { cosineSimilarity, episodeText, rankEpisodes } from './retrieval.js';

test('vectors retrieve context only within tenant, language, model, format and past-time boundaries', () => {
  const base = {
    id: 'a',
    userId: 'u',
    language: 'pt',
    model: 'bge',
    format: 'episode-v1',
    occurredAt: '2026-01-01T00:00:00Z',
    vector: [1, 0],
    packet: {},
  };
  const candidates = [
    base,
    ...[
      { id: 'other', userId: 'v' },
      { id: 'future', occurredAt: '2027-01-01T00:00:00Z' },
      { id: 'lang', language: 'ru' },
      { id: 'model', model: 'other' },
      { id: 'format', format: 'sentence-v0' },
      { id: 'dimension', vector: [1] },
    ].map((c) => ({ ...base, ...c })),
  ];
  assert.deepEqual(
    rankEpisodes(
      [1, 0],
      { userId: 'u', language: 'pt', model: 'bge', before: '2026-06-01T00:00:00Z' },
      candidates,
    ).map((c) => c.id),
    ['a'],
  );
  assert.equal(cosineSimilarity([0, 0], [1, 0]), null);
  assert.equal(cosineSimilarity([NaN, 0], [1, 0]), null);
  const p = packetSchema.parse({
    userId: 'u',
    sessionId: 's',
    turnId: 'l',
    language: 'pt',
    source: 'typed',
    occurredAt: '2026-01-01T00:00:00Z',
    turns: [
      { id: 't', role: 'tutor', text: 'Say café.' },
      { id: 'l', role: 'learner', text: 'café' },
    ],
  });
  assert.match(episodeText(p), /tutor/);
  assert.match(episodeText(p), /learner/);
  assert.match(episodeText(p), /episode-v1/);
});
