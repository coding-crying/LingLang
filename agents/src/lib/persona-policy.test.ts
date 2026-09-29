// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseSupervisorPersona,
  resolvePersonaLayers,
  validatePersonaPatch,
} from './persona-policy.js';

test('validates preference patches and preserves comma-rich inferred instructions', () => {
  assert.throws(() => validatePersonaPatch({ tone: 'banana' }), /tone/);
  assert.throws(
    () => validatePersonaPatch({ extraInstructions: 'x'.repeat(2001) }),
    /extraInstructions/,
  );
  assert.deepEqual(
    parseSupervisorPersona('tone=warm, extraInstructions=Brief, patient, no speeches.'),
    { tone: 'warm', extraInstructions: 'Brief, patient, no speeches.' },
  );
  assert.deepEqual(
    parseSupervisorPersona('{"tone":"formal","extraInstructions":"No slang, please."}'),
    { tone: 'formal', extraInstructions: 'No slang, please.' },
  );
});

test('explicit global settings beat inferred language style; explicit language null suppresses both', () => {
  const global = {
    explicit: { tone: 'formal', extraInstructions: 'Keep it brief.' },
    inferred: {},
  };
  const specific = {
    explicit: {},
    inferred: { tone: 'roast', extraInstructions: 'Explain everything.' },
  };
  assert.deepEqual(resolvePersonaLayers(global, specific), {
    tone: 'formal',
    extraInstructions: 'Keep it brief.',
  });
  assert.equal(resolvePersonaLayers(global, { ...specific, explicit: { tone: null } }).tone, null);
});
