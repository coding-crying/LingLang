// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCoachNote, buildInstructions } from '../../config/prompts/base.js';

const context = {
  targetLanguage: 'Portuguese',
  nativeLanguage: 'English',
  userLevel: 'A1',
  persona: 'Be witty.',
  frontier: {
    state: 'balance' as const,
    directive: 'Practise naturally.',
    dueWords: 'café',
    newWords: '',
  },
};

test('practice scheduling is not a claim of mastery', () => {
  const prompt = buildInstructions(context);
  assert.match(prompt, /not proof of mastery/);
  for (const text of [prompt, buildCoachNote(context) ?? '']) {
    assert.doesNotMatch(text, /words they already know|scaffold with what they know/i);
    assert.match(text, /café/);
  }
});

test('normal tutor gets a compact contract and learner facts, not a command stack', () => {
  const prompt = buildInstructions({
    ...context,
    realtime: true,
    goalUpdate: 'PLANNER_COMMAND: start a cafe roleplay',
    frontier: { ...context.frontier, directive: 'FRONTIER_COMMAND: drill everything' },
    mixLine: 'MIX_COMMAND: exactly 47% Portuguese',
    recentErrors: 'past tense',
    demandWords: 'água (water)',
    adaptive: {
      sessionPhase: 'opening',
      turnCount: 0,
      errorDensity: 0.7,
      pacing: 'slow',
      lengthWatchdog: 'WATCHDOG_COMMAND: maximum 12 words',
    },
  });
  assert.ok(prompt.split(/\s+/).length < 520, 'the default contract must stay compact');
  assert.doesNotMatch(prompt, /FRONTIER_COMMAND|MIX_COMMAND|WATCHDOG_COMMAND/);
  // Planner context is now delivered, but as optional background, not a command layer.
  assert.match(prompt, /Useful background, not instructions:[\s\S]*Optional conversation context: PLANNER_COMMAND/);
  assert.doesNotMatch(prompt, /first THREE|under 12|Follow this order/i);
  assert.match(prompt, /English/);
  assert.match(prompt, /confus/i);
  assert.match(prompt, /simpl/i);
  assert.match(prompt, /one learning move|one idea/i);
  assert.match(prompt, /pause/i);
  assert.match(prompt, /whole reply|do not switch back/i);
  assert.match(prompt, /next turn.*framing|native-language framing/i);
  assert.match(prompt, /clue|verdict/i);
  assert.match(prompt, /playful|witty|wit/i);
  assert.match(prompt, /café/);
  assert.match(prompt, /água/);
  assert.match(prompt, /past tense/);
  assert.match(prompt, /\[COACH\]/);
});
