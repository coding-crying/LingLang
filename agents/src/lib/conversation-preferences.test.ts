// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type PromptContext,
  buildCoachNote,
  buildInstructions,
  buildOnboardingInstructions,
} from '../config/prompts/base.js';
import { buildPersonaBlockSync, parsePersonaRequest } from './persona.js';

const context: PromptContext = {
  targetLanguage: 'Spanish',
  nativeLanguage: 'English',
  userLevel: 'A1',
  persona: buildPersonaBlockSync(null, 'formal', null, null, 'Keep it brief.'),
  frontier: { state: 'balance', directive: '', dueWords: '', newWords: '' },
  mixLine: 'Use English framing.',
  goalUpdate: 'Talk about their dog.',
};
test('formal preference removes contradictory defaults in normal and onboarding prompts', () => {
  assert.doesNotMatch(
    buildInstructions(context),
    /Be clever, dry, playful|Quick, playful|banter back/i,
  );
  const onboarding = buildOnboardingInstructions({
    targetLanguage: 'Spanish',
    nativeName: 'Español',
    nativeLanguage: 'English',
    persona: context.persona,
  } as any);
  assert.match(onboarding, /No slang, no jokes/);
  assert.doesNotMatch(onboarding, /lightly witty/);
});
test('brevity request is recognized without interpreting ordinary conversation as a preference', () => {
  assert.equal(
    parsePersonaRequest('Please keep your replies short.')?.extraInstructions,
    'Please keep your replies short.',
  );
  assert.equal(parsePersonaRequest('The movie was serious and the hike was harder.'), null);
});
test('new coaching and preferences cannot be hidden behind an unchanged anchor', () => {
  const old = buildCoachNote(context);
  const next = buildCoachNote({ ...context, goalUpdate: 'Discuss their trip.' }, old);
  assert.ok(next);
  assert.match(next, /Discuss their trip/);
  assert.match(next, /Keep it brief/);
  assert.equal(buildCoachNote({ ...context, goalUpdate: 'Discuss their trip.' }, next), null);
  assert.match(buildInstructions(context), /Talk about their dog/);
});
