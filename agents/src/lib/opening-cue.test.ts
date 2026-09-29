import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('connected learner opening resumes context instead of teaching a basic greeting', () => {
  const source = readFileSync(new URL('../tutor-event-driven.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const returningOpeningContext');
  const end = source.indexOf("console.log('[Tutor-ED] Sending initial greeting", start);
  const cue = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the real startup cue must be present');
  assert.match(cue, /returningOpeningContext/);
  assert.match(cue, /returning learner/);
  assert.match(cue, /do not teach or test a basic greeting/);
  assert.match(cue, /resume the actual work/);
  assert.match(cue, /stop and listen/);
});

test('Gemini opening is realtime input, not clientContent history', () => {
  const source = readFileSync(new URL('../tutor-event-driven.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const seedOpeningTurn');
  const end = source.indexOf('if (isGemini && !canGenerateReply)', start);
  assert.ok(start >= 0 && end > start);
  const seed = source.slice(start, end);
  assert.match(seed, /type: 'realtime_input'/);
  assert.match(seed, /value: \{ text: openingInput \}/);
  assert.doesNotMatch(seed, /turnComplete/);
});
