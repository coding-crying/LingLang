// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationSettings } from './ConversationSettings';

test('profile exposes preferences, model calibration and retained conversations', () => {
  const html = renderToStaticMarkup(
    React.createElement(ConversationSettings, { userId: 'fixture', language: 'pt', mode: 'cloud' }),
  );
  for (const label of ['Conversation preferences', 'Model behavior', 'Saved conversations'])
    assert.ok(html.includes(label));
  assert.ok(html.includes('next session'));
});
