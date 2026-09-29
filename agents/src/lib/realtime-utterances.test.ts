/**
 * Unit tests for RealtimeUtteranceTracker (realtime S2S turn segmentation).
 *
 * Plain assertion script, same convention as
 * src/dashboard/frontend/src/hooks/useConversationStream.test.ts. Run with:
 *
 *   npx tsx src/lib/realtime-utterances.test.ts
 *
 * The tracker deliberately has no runtime dependency on @livekit/rtc-node
 * (type-only imports), so this runs without a room or a model.
 */

import { RealtimeUtteranceTracker, type RealtimeUtterance } from './realtime-utterances.js';
import type { AudioFrame } from '@livekit/rtc-node';

let failures = 0;
let passes = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) passes++;
  else {
    failures++;
    console.error(`✗ FAIL: ${msg}`);
  }
}

function makeTracker(overrides: {
  registerAudio?: ((frames: AudioFrame[]) => { audioId: string; durationSec: number } | null) | null;
  audioTap?: { start(): void; stop(): void; slice(s: number, e: number): { frames: AudioFrame[]; durationSec: number } | null } | null;
  graceMs?: number;
} = {}) {
  const out: RealtimeUtterance[] = [];
  const tracker = new RealtimeUtteranceTracker({
    onUtterance: (u) => out.push(u),
    audioTap: (overrides.audioTap ?? null) as any,
    registerAudio: overrides.registerAudio ?? null,
    flushGraceMs: overrides.graceMs ?? 5,
  });
  return { tracker, out };
}

// ============================================================================
// Test 1: one generation, two speech spans → two utterances
//
// This is the live bug: the learner answered, the model started replying, the
// learner barged in and spoke again — all inside one generation, so the
// plugin's cumulative transcript merged both into a single blob.
// ============================================================================

function testTwoSpansInOneGeneration() {
  const { tracker, out } = makeTracker();

  tracker.onUserState('speaking');
  tracker.onTranscription('gen-1', 'No, I thought it was', false);
  tracker.onUserState('listening');
  // Second span starts before the grace flush would have fired.
  tracker.onUserState('speaking');
  tracker.onTranscription('gen-1', 'No, I thought it was Wait, wait, wait.', false);
  tracker.onUserState('listening');
  tracker.onTranscription('gen-1', 'No, I thought it was Wait, wait, wait. Slow down.', true);

  assert(out.length === 2, `expected 2 utterances, got ${out.length}: ${JSON.stringify(out.map((u) => u.text))}`);
  assert(out[0]?.text === 'No, I thought it was', `utterance 1 text: "${out[0]?.text}"`);
  assert(out[1]?.text === 'Wait, wait, wait. Slow down.', `utterance 2 text: "${out[1]?.text}"`);
  assert(out[0]?.reason === 'speech-restart', `utterance 1 should flush on speech-restart, got ${out[0]?.reason}`);
  assert(out[1]?.reason === 'final', `utterance 2 should flush on final, got ${out[1]?.reason}`);
  // The frontend drops a duplicate itemId, so two spans in one generation
  // must not share one. First keeps the raw generation id (so the live
  // partial bubble is replaced, not duplicated); the rest are suffixed.
  assert(out[0]?.itemId === 'gen-1', `utterance 1 itemId: ${out[0]?.itemId}`);
  assert(out[1]?.itemId === 'gen-1#1', `utterance 2 itemId: ${out[1]?.itemId}`);
}

// ============================================================================
// Test 2: cumulative deltas are diffed, not concatenated
// ============================================================================

function testCumulativeDiffing() {
  const { tracker, out } = makeTracker();
  tracker.onUserState('speaking');
  tracker.onTranscription('gen-1', 'Estou', false);
  tracker.onTranscription('gen-1', 'Estou um', false);
  tracker.onTranscription('gen-1', 'Estou um pouco', false);
  tracker.onTranscription('gen-1', 'Estou um pouco mal', true);

  assert(out.length === 1, `expected 1 utterance, got ${out.length}`);
  assert(out[0]?.text === 'Estou um pouco mal', `expected full text once, got "${out[0]?.text}"`);
}

// ============================================================================
// Test 2b: currentText exposes the in-flight span for the live UI
// ============================================================================

function testCurrentText() {
  const { tracker } = makeTracker();
  tracker.onUserState('speaking');
  tracker.onTranscription('gen-1', 'Estou', false);
  assert(tracker.currentText === 'Estou', `currentText mid-stream: "${tracker.currentText}"`);
  tracker.onTranscription('gen-1', 'Estou um pouco', false);
  assert(tracker.currentText === 'Estou um pouco', `currentText grows: "${tracker.currentText}"`);
  tracker.onTranscription('gen-1', 'Estou um pouco mal', true);
  assert(tracker.currentText === '', `currentText clears after flush: "${tracker.currentText}"`);
}

// ============================================================================
// Test 3: latency = time from the tutor's last audio to the learner's start
// ============================================================================

function testLatency() {
  const { tracker, out } = makeTracker();
  const t0 = Date.now();
  tracker.onAgentState('speaking');
  tracker.onAgentState('listening'); // tutor stopped talking
  tracker.onUserState('speaking'); // learner starts immediately after
  tracker.onTranscription('gen-1', 'Bom dia', true);

  const u = out[0];
  assert(u !== undefined, 'expected one utterance');
  const expected = (u!.startedAt - t0) / 1000;
  assert(
    u!.latencySec !== null && Math.abs(u!.latencySec - expected) < 0.5,
    `latency should be ~${expected.toFixed(2)}s, got ${u!.latencySec}`,
  );
}

// ============================================================================
// Test 4: barge-in (learner talks over the tutor) reports no latency
// ============================================================================

function testBargeInNoLatency() {
  const { tracker, out } = makeTracker();
  tracker.onAgentState('speaking'); // tutor still talking
  tracker.onUserState('speaking');
  tracker.onTranscription('gen-1', 'Espera', true);

  assert(out.length === 1, `expected 1 utterance, got ${out.length}`);
  assert(out[0]?.latencySec === null, `barge-in should report null latency, got ${out[0]?.latencySec}`);
}

// ============================================================================
// Test 5: the audio tap's PCM for the span is registered and attached
// ============================================================================

function testAudioRegistration() {
  const sliced: { start: number; end: number }[] = [];
  const fakeTap = {
    start() {},
    stop() {},
    slice(start: number, end: number) {
      sliced.push({ start, end });
      return { frames: [] as AudioFrame[], durationSec: 1.4 };
    },
  };
  const { tracker, out } = makeTracker({
    audioTap: fakeTap,
    registerAudio: () => ({ audioId: 'a1b2c3', durationSec: 1.4 }),
  });

  tracker.onUserState('speaking');
  tracker.onTranscription('gen-1', 'Bom dia', true);

  assert(sliced.length === 1, `expected one tap slice, got ${sliced.length}`);
  assert(
    out[0]?.audio?.audioId === 'a1b2c3',
    `expected the registered audio to ride along, got ${JSON.stringify(out[0]?.audio)}`,
  );
  assert(out[0]?.durationSec !== undefined, 'utterance should carry a duration');
}

// ============================================================================
// Test 6: a new generation id flushes the previous one's trailing text
// ============================================================================

function testGenerationRollover() {
  const { tracker, out } = makeTracker();
  tracker.onUserState('speaking');
  tracker.onTranscription('gen-1', 'Então', false);
  // Model rolled to a new generation without a final event for the old text.
  tracker.onTranscription('gen-2', 'Bom dia', true);

  assert(out.length === 2, `expected 2 utterances across the rollover, got ${out.length}`);
  assert(out[0]?.text === 'Então', `first text: "${out[0]?.text}"`);
  assert(out[0]?.reason === 'generation-rollover', `first reason: ${out[0]?.reason}`);
  assert(out[1]?.text === 'Bom dia', `second text: "${out[1]?.text}"`);
}

// ============================================================================
// Run
// ============================================================================

testTwoSpansInOneGeneration();
testCumulativeDiffing();
testCurrentText();
testLatency();
testBargeInNoLatency();
testAudioRegistration();
testGenerationRollover();

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
