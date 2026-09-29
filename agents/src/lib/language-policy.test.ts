// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCoachNote,
  buildInstructions,
  buildOnboardingInstructions,
} from '../config/prompts/base.js';
import { buildMixLine, computeTargetShare, targetShareForLevel } from './language-mix.js';

for (const level of ['b1', 'B2', 'c1', 'c2']) {
  test(`${level}: missing review history does not erase the selected level`, () => {
    const share = computeTargetShare({ userLevel: level, recentSuccess: null, throttleNotches: 0 });
    assert.equal(share, targetShareForLevel(level));
    const prompt = buildInstructions({
      targetLanguage: 'Spanish',
      nativeLanguage: 'English',
      userLevel: level,
      persona: 'Be an attentive tutor.',
      realtime: true,
      frontier: { state: 'consolidate', directive: '', dueWords: '', newWords: '' },
      mixLine: buildMixLine({
        targetShare: share,
        lastMeasuredShare: null,
        targetLanguage: 'Spanish',
        nativeLanguage: 'English',
      }),
    });
    assert.match(prompt, /Start and continue in Spanish/);
    assert.match(prompt, /explicit.*Spanish.only.*outranks.*language.*(?:anchor|mix)/i);
    assert.match(prompt, /until they ask to switch/i);
    assert.doesNotMatch(
      prompt,
      /keep English framing|Keep the conversation in English|Use the learner's native language for framing/,
    );
  });
}

for (const level of ['pre_a1', 'a1', 'a2', '']) {
  test(`${level || 'unknown'}: beginners retain English scaffolding`, () => {
    const share = computeTargetShare({ userLevel: level, recentSuccess: null, throttleNotches: 0 });
    assert.ok(share <= 0.3);
    const prompt = buildInstructions({
      targetLanguage: 'Spanish',
      nativeLanguage: 'English',
      userLevel: level,
      persona: 'Be an attentive tutor.',
      realtime: true,
      frontier: { state: 'consolidate', directive: '', dueWords: '', newWords: '' },
      mixLine: buildMixLine({
        targetShare: share,
        lastMeasuredShare: null,
        targetLanguage: 'Spanish',
        nativeLanguage: 'English',
      }),
    });
    assert.match(prompt, /Speak English by default/);
    assert.match(prompt, /keep English framing unless asked/);
    assert.match(prompt, /For the whole reply, use English/);
    assert.doesNotMatch(prompt, /Start and continue in Spanish/);
  });
}

test('B2 target-only preference outranks later rescue anchors without disabling requested help', () => {
  const mixLine = buildMixLine({
    targetShare: computeTargetShare({ userLevel: 'b2', recentSuccess: null, throttleNotches: 2 }),
    lastMeasuredShare: 1,
    targetLanguage: 'Spanish',
    nativeLanguage: 'English',
  });
  const context = {
    targetLanguage: 'Spanish',
    nativeLanguage: 'English',
    userLevel: 'b2',
    persona: 'Be an attentive tutor.',
    realtime: true,
    mixLine,
    frontier: { state: 'consolidate' as const, directive: '', dueWords: '', newWords: '' },
  };
  assert.match(buildCoachNote(context)!, /This turn, speak English/);
  const prompt = buildInstructions(context);
  assert.match(
    prompt,
    /Spanish-only outranks language anchors, mix defaults, automatic native-language rescue, and \[COACH\] suggestions/,
  );
  assert.match(prompt, /Always honor an explicit request for English help/);
  assert.match(prompt, /Simplify or explain in Spanish instead/);
});

test('onboarding uses a supplied level for language policy, not proficiency scoring', () => {
  const context = { targetLanguage: 'Spanish', nativeLanguage: 'English', nativeName: 'Español' };
  const high = buildOnboardingInstructions({ ...context, existingData: { selfRatedLevel: 'b2' } });
  assert.match(high, /Start and continue in Spanish/);
  assert.doesNotMatch(high, /If they are confused, use English/);
  assert.match(high, /Do not invent a level from confidence or self-report/);
  const low = buildOnboardingInstructions(context);
  assert.match(low, /keep English framing unless asked/);
});
