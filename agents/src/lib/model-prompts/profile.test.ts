// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileIdentity, resolveConversationRoute, validateGuidance } from './profile.js';

test('actual realtime identity bypasses cascaded BYO and excludes credentials', () => {
  const route = resolveConversationRoute('gemini', {
    realtimeEnabled: true,
    llm: { baseUrl: 'http://localhost:9999/v1', model: 'ignored', apiKey: 'secret' },
  });
  assert.equal(route.transport, 'google-live');
  assert.notEqual(route.model, 'ignored');
  const identity = profileIdentity(route, 'pt');
  assert.doesNotMatch(JSON.stringify(identity), /secret|apiKey/);
  assert.notEqual(identity.key, profileIdentity(route, 'ru').key);
});
test('subtraction is valid but unbounded or non-text guidance is rejected', () => {
  assert.equal(validateGuidance(''), '');
  assert.throws(() => validateGuidance('x'.repeat(2001)), /2000/);
  assert.throws(() => validateGuidance({}), /text/);
});
