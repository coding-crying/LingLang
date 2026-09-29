import assert from 'node:assert/strict';
import { assessRealtimeTranscript } from './realtime-transcript-guard.js';
const text = 'Could you please bring some cold water';
for (const peak of [0.004, 0.02, null]) {
  assert.equal(assessRealtimeTranscript({text, tutorText: text, nearbyPeak: peak, tapHealthy: true}).accept,
    true, `quiet/repeated words are not proof of fabrication (peak=${peak})`);
}
assert.equal(assessRealtimeTranscript({text, tutorText: text, nearbyPeak: null,
  spanSec: 0.2, tapHealthy: true}).accept, true,
  'unknown capture with delayed short text-arrival span remains accepted');
console.log('quiet/repetition regression: 4 assertions passed');
