import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../tutor-event-driven.ts', import.meta.url), 'utf8');
assert.ok(source.includes('rtAudioTap.peakIn(rtAudioEvidenceStart, evidenceEnd)'), 'capture evidence spans since the preceding final, not the text-arrival window');
import { UserAudioTap } from './user-audio-tap.js';
import { AudioFrame } from '@livekit/rtc-node';
const tap = new UserAudioTap({} as any);
const oldNow = Date.now;
try {
  const push = (at: number, sample: number) => {
    Date.now = () => at;
    (tap as any).push(new AudioFrame(new Int16Array(320).fill(sample), 16000, 1, 320));
  };
  for (let t = 1000; t <= 2000; t += 20) push(t, 0);
  assert.equal(tap.peakIn(0, 2000), null, 'partial silent buffer is not evidence about earlier speech');
  assert.equal(tap.peakIn(1000, 2000), 0, 'fully covered digital silence remains detectable');
  assert.equal(tap.peakIn(1000, 3000), null, 'stalled audio stream is unknown');
  push(4000, 0);
  assert.equal(tap.peakIn(1000, 4000), null, 'a capture gap is not digital silence');
  push(4020, 100);
  for (let t = 4040; t <= 10000; t += 20) push(t, 0);
  assert.ok(tap.peakIn(2000, 10000)! > 0, 'late transcript evidence retains earlier quiet PCM');
  console.log('audio evidence: 5 assertions passed (real PCM, controlled clock)');
} finally { Date.now = oldNow; tap.stop(); }
