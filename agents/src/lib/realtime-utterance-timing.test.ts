import assert from 'node:assert/strict';
import { RealtimeUtteranceTracker, type RealtimeUtterance } from './realtime-utterances.js';
const output: RealtimeUtterance[] = [];
const tracker = new RealtimeUtteranceTracker({onUtterance: u => output.push(u)});
const oldNow = Date.now;
let now = 1000;
Date.now = () => now;
try {
  tracker.onUserState('speaking');
  now = 2000;
  tracker.onUserState('listening');
  now = 8000; // transcription trails the physical speech by six seconds
  tracker.onTranscription('g1', 'Bom dia', true);
  assert.equal(output[0]?.startedAt, 1000, 'new generation must retain observed speech onset');
  now = 9000;
  tracker.onUserState('speaking');
  tracker.onTranscription('g1', 'Bom dia Como vai', false);
  assert.equal(tracker.currentItemId, 'g1#1', 'partial bubble must use the next final utterance ID');
  tracker.onTranscription('g1', 'Bom dia Como vai', true);
  assert.equal(output[1]?.itemId, 'g1#1');
  console.log('utterance timing/identity: 3 assertions passed');
} finally { Date.now = oldNow; tracker.stop(); }
