import assert from 'node:assert/strict';
import { type PromptContext, buildCoachNote, buildInstructions } from './base.js';

const context: PromptContext = {
  targetLanguage: 'Portuguese',
  nativeLanguage: 'English',
  userLevel: 'a1',
  persona: 'Be warm and witty.',
  frontier: {
    state: 'consolidate',
    directive: 'Recycle familiar words when natural.',
    dueWords: '',
    newWords: '',
  },
  mixLine:
    'Speak English by default. Use at most one short Portuguese word or phrase this turn, and give its English meaning immediately.',
  demandWords: 'manteiga (butter)',
  adaptive: {
    sessionPhase: 'flow',
    turnCount: 4,
    errorDensity: 0,
    pacing: 'medium',
  },
  realtime: true,
};

const instructions = buildInstructions(context);
assert.match(
  instructions,
  /Portuguese input is practice; keep English framing unless asked/i,
  "the immutable contract must not mirror the learner's language automatically",
);
assert.match(
  instructions,
  /Speak English by default.*one short Portuguese word or phrase/i,
  'the computed language anchor must reach the connect-time prompt',
);

const note = buildCoachNote(context);
assert.match(
  note!,
  /^\[COACH\] Language anchor: Speak English by default\. Use at most one short Portuguese word or phrase this turn, and give its English meaning immediately\./,
  'language guidance must outrank vocabulary context in the live packet',
);
assert.equal(
  buildCoachNote(context, note),
  null,
  'unchanged language guidance must be deduplicated',
);

console.log('language anchor prompt: 4 assertions passed');
