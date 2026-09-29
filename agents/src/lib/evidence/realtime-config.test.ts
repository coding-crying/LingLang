// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('Gemini transcription setup does not send unsupported model selectors', async () => {
  const source = await readFile(new URL('../../services/factory.ts', import.meta.url), 'utf8');
  assert.match(source, /inputAudioTranscription:\s*\{\s*\}/);
  assert.match(source, /outputAudioTranscription:\s*\{\s*\}/);
  assert.doesNotMatch(source, /(?:input|output)AudioTranscription:\s*\{\s*model:/);
});
