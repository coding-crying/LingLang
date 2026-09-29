// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceLabel } from './evidence-labels.js';

test('evidence labels distinguish help and uncertainty without claiming mastery', () => {
  assert.equal(
    evidenceLabel({ kind: 'production', assistance: 'answer_supplied', outcome: 'succeeded' }),
    'Practised with the answer supplied',
  );
  assert.equal(
    evidenceLabel({ kind: 'production', assistance: 'none', outcome: 'succeeded' }),
    'Possible independent use — unverified',
  );
  assert.equal(
    evidenceLabel({ kind: 'mention', assistance: 'none', outcome: 'indeterminate' }),
    'Mentioned, not demonstrated',
  );
  assert.equal(
    evidenceLabel({ kind: 'production', assistance: 'unknown', outcome: 'indeterminate' }),
    'Not enough evidence',
  );
});
