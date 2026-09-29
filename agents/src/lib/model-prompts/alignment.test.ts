// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAlignment } from './alignment.js';

const context = {
  targetLanguage: 'Spanish',
  nativeLanguage: 'English',
  userLevel: 'A1',
  persona: 'Keep it brief.',
  frontier: { state: 'balance' as const, directive: '', dueWords: '', newWords: '' },
};
test('bounded alignment compares baseline, deletion and rewrite with repeated held-out exchanges', async () => {
  const inputs: string[] = [];
  const report = await runAlignment(
    context,
    'baseline guidance',
    async (system, turns) => {
      inputs.push(system);
      return turns.map((text) => ({
        input: text,
        text: system.includes('Rewrite') ? 'Follow their lead.' : 'One small step.',
        durationMs: 12,
        firstOutputMs: 4,
        audioBytes: 0,
      }));
    },
    new AbortController().signal,
  );
  assert.equal(report.trials.length, 12);
  assert.equal(inputs.length, 13);
  assert.equal(report.candidates[1]?.guidance, '');
  assert.equal(report.trials.filter((t) => t.split === 'held-out').length, 6);
  assert.equal(report.automaticallyApplied, false);
  assert.ok(report.trials.every((t) => t.exchanges.length === 2));
});
test('cancelled alignment makes no further provider calls', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runAlignment(
      context,
      '',
      async () => {
        throw new Error('must not call');
      },
      controller.signal,
    ),
    /abort/i,
  );
});
