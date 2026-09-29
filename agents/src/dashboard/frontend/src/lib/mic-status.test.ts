/**
 * Unit tests for the pure mic-status helpers.
 *
 * Run from `agents/src/dashboard/frontend`:
 *   npx tsx --test src/lib/mic-status.test.ts
 *
 * The important property here is HONESTY: the status line must reflect the
 * real mic state it is given. These tests are what stops a future edit from
 * rendering "Mic live" over a muted microphone (or the reverse).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentStateLabel,
  barScale,
  clamp01,
  inputLevelPercent,
  micStatusText,
  micStatusTone,
  type MicStatusInput,
} from './mic-status.js';

const base: MicStatusInput = {
  mode: 'ptt',
  micEnabled: false,
  holding: false,
  cancelling: false,
  agentState: 'listening',
};

test('PTT idle reports the microphone as muted', () => {
  assert.equal(micStatusText(base), 'Mic muted · hold to talk');
  assert.equal(micStatusTone(base), 'idle');
});

test('PTT held reports live only after the microphone is enabled', () => {
  assert.equal(micStatusText({ ...base, holding: true, micEnabled: true }), 'Mic live · release to send');
  assert.equal(micStatusText({ ...base, holding: true, micEnabled: true, cancelling: true }), 'Mic live · release to cancel');
  assert.equal(micStatusTone({ ...base, holding: true, micEnabled: true }), 'live');
  assert.doesNotMatch(micStatusText({ ...base, holding: true }), /live/i);
  assert.doesNotMatch(micStatusText({ ...base, holding: true, cancelling: true }), /live/i);
  assert.equal(micStatusTone({ ...base, holding: true }), 'warn');
});

test('PTT idle never claims the mic is muted when LiveKit says it is on', () => {
  const text = micStatusText({ ...base, micEnabled: true });
  assert.match(text, /live/i);
  assert.doesNotMatch(text, /muted/i);
  assert.equal(micStatusTone({ ...base, micEnabled: true }), 'warn');
});

test('hands-free reports live only when the mic is actually enabled', () => {
  assert.equal(
    micStatusText({ ...base, mode: 'handsFree', micEnabled: true, agentState: 'listening' }),
    'Mic live · listening',
  );
  assert.equal(
    micStatusText({ ...base, mode: 'handsFree', micEnabled: true, agentState: 'thinking' }),
    'Mic live · thinking…',
  );
  assert.equal(micStatusTone({ ...base, mode: 'handsFree', micEnabled: true }), 'live');
});

test('hands-free with a dead microphone says so instead of pretending to listen', () => {
  const text = micStatusText({ ...base, mode: 'handsFree', micEnabled: false });
  assert.match(text, /mic is off/i);
  assert.doesNotMatch(text, /live/i);
  assert.equal(micStatusTone({ ...base, mode: 'handsFree', micEnabled: false }), 'warn');
});

test('agent state labels cover every state useVoiceAssistant emits', () => {
  for (const state of [
    'disconnected',
    'connecting',
    'pre-connect-buffering',
    'initializing',
    'idle',
    'listening',
    'thinking',
    'speaking',
    'failed',
  ]) {
    assert.ok(agentStateLabel(state).length > 0, `no label for ${state}`);
  }
  assert.equal(agentStateLabel('listening'), 'listening');
  assert.equal(agentStateLabel('some-future-state'), 'some-future-state');
});

test('input level percent is clamped and rounded', () => {
  assert.equal(inputLevelPercent(0), 0);
  assert.equal(inputLevelPercent(0.62), 62);
  assert.equal(inputLevelPercent(1), 100);
  assert.equal(inputLevelPercent(4), 100);
  assert.equal(inputLevelPercent(-3), 0);
  assert.equal(inputLevelPercent(Number.NaN), 0);
  assert.equal(clamp01(2), 1);
});

test('PTT meter bars track the real level and rest low when the mic is silent', () => {
  const count = 3;
  // Silent input: resting height, not a fake animation.
  for (let i = 0; i < count; i++) assert.equal(barScale(0, i, count), 0.18);
  // Louder input raises every bar, and the centre bar is the tallest.
  const quiet = [0, 1, 2].map((i) => barScale(0.3, i, count));
  const loud = [0, 1, 2].map((i) => barScale(0.9, i, count));
  for (let i = 0; i < count; i++) assert.ok(loud[i] > quiet[i], 'louder input must raise the bar');
  assert.ok(loud[1] > loud[0] && loud[1] > loud[2], 'centre bar should be tallest');
  assert.ok(loud[1] <= 1 && quiet[0] >= 0.18);
});