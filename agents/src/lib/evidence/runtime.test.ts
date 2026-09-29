// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvidencePacket, evidenceMode } from './runtime.js';

test('retains tagged measurements without turning them into fluency claims', () => {
  const measurements = {
    source: 'realtime-event-span' as const,
    responseLatencyMs: 1200,
    speechDurationMs: 3100,
  };
  const p = buildEvidencePacket({
    userId: 'u',
    sessionId: 's',
    turnId: '1',
    language: 'pt',
    text: 'café',
    occurredAt: '2026-09-10T12:00:00Z',
    turns: [],
    measurements,
  });
  assert.deepEqual(p?.measurements, measurements);
});
test('runtime captures immutable role-separated context, never grades placeholders, and fails closed on mode', () => {
  const turns = [
    { role: 'assistant' as const, content: 'Say café.' },
    { role: 'user' as const, content: '[audio key=a] café' },
  ];
  const input = {
    userId: 'u',
    sessionId: 's',
    turnId: 'l',
    language: 'pt',
    text: 'café',
    turns,
    occurredAt: '2026-09-10T00:00:00Z',
  };
  const p = buildEvidencePacket(input)!;
  assert.equal(p.turns.at(-1)?.text, 'café');
  assert.equal(p.turns[0]?.role, 'tutor');
  turns[0]!.content = 'changed';
  assert.equal(p.turns[0]?.text, 'Say café.');
  assert.equal(buildEvidencePacket({ ...input, text: '[audio key=a]' }), null);
  assert.equal(evidenceMode('shadow'), 'shadow');
  assert.equal(evidenceMode('active'), 'off');
  assert.equal(evidenceMode(undefined), 'off');
});
