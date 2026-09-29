// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferenceOptions } from './observer.js';

test('analysis disables reasoning only through compatible endpoint options', () => {
  assert.deepEqual(inferenceOptions('https://openrouter.ai/api/v1'), {
    reasoning: { enabled: false },
  });
  assert.deepEqual(inferenceOptions('http://localhost:8889/v1'), {
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.deepEqual(inferenceOptions('https://api.openai.com/v1'), {});
});
