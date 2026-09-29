// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { certifyEvaluation, summarizeEvaluation } from './evaluation.js';

test('evaluation reports abstention, false recall credit and repeated disagreement separately', () => {
  const r = summarizeEvaluation([
    {
      caseId: 'copy',
      expected: 'copy',
      actual: 'recall',
      expectedGrade: null,
      actualGrade: 3,
      status: 'accepted',
      elapsedMs: 20,
    },
    {
      caseId: 'copy',
      expected: 'copy',
      actual: null,
      expectedGrade: null,
      actualGrade: null,
      status: 'rejected',
      elapsedMs: 40,
    },
    {
      caseId: 'recall',
      expected: 'recall',
      actual: 'recall',
      expectedGrade: 3,
      actualGrade: 3,
      status: 'accepted',
      elapsedMs: 30,
    },
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.exactMatches, 1);
  assert.equal(r.falseRecallCredits, 1);
  assert.equal(r.rejectedOrErrors, 1);
  assert.equal(r.disagreeingCases, 1);
  assert.equal(r.certified, false);
});

test('certification requires the complete repeated suite and rejects unsafe credits', () => {
  const rows = Array.from({ length: 3 }, (_, repeat) =>
    Array.from({ length: 12 }, (_, index) => ({
      caseId: `case-${index}`,
      expected: index === 0 ? 'production|answer_supplied|succeeded' : 'production|none|succeeded',
      actual: index === 0 ? 'production|answer_supplied|succeeded' : 'production|none|succeeded',
      expectedGrade: index === 0 ? null : 3,
      actualGrade: index === 0 ? null : 3,
      status: 'accepted',
      elapsedMs: repeat + index,
    })),
  ).flat();

  const certified = certifyEvaluation(rows);
  assert.equal(certified.certified, true);
  assert.deepEqual(certified.capabilities, ['production', 'assistance']);
  assert.equal(certified.repeats, 3);

  rows[0].actualGrade = 3;
  const unsafe = certifyEvaluation(rows);
  assert.equal(unsafe.certified, false);
  assert.deepEqual(unsafe.capabilities, []);
});

test('a single diagnostic run is recorded as unapproved evidence', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    caseId: `case-${index}`,
    expected: 'empty',
    actual: 'empty',
    expectedGrade: null,
    actualGrade: null,
    status: 'accepted',
    elapsedMs: 1,
  }));
  const result = certifyEvaluation(rows);
  assert.equal(result.certified, false);
  assert.match(result.reason, /at least 3 times/);
});
