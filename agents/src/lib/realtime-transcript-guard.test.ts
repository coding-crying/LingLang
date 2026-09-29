/**
 * Unit tests for assessRealtimeTranscript (phantom learner-turn gate).
 *
 * Plain assertion script, same convention as src/lib/stray-generation-guard.test.ts.
 * Run with:
 *
 *   npx tsx src/lib/realtime-transcript-guard.test.ts
 */

import {
  assessRealtimeTranscript,
  overlapRatio,
  tokenize,
} from './realtime-transcript-guard.js';

let failures = 0;
let passes = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) passes++;
  else {
    failures++;
    console.error(`✗ FAIL: ${msg}`);
  }
}

// The tutor's greeting as Gemini actually emitted it (two stray generations),
// from the gritz session in /tmp/tutor-live.log ~15:57.
const TUTOR_GREETING =
  "how's it going today? Is it *muy* cold *afuera* where you are, very cold outside?";

// What Gemini reported as the LEARNER saying, from a 0.20s digital-silence clip.
const PHANTOM_TURN =
  "Hey, so, how's it going today? Is it muy cold? Afuera? Where are you? Very cold outside?";

// ============================================================================
// Test 1: the live bug — silent span, tap healthy, text is the tutor's own words
// ============================================================================
{
  const v = assessRealtimeTranscript({
    text: PHANTOM_TURN,
    tutorText: TUTOR_GREETING,
    nearbyPeak: 0.0, // [GemmaAudioSTT] rms=0.000, peak=0.000
    tapHealthy: true,
    spanSec: 0.3,
  });
  assert(!v.accept, 'phantom turn on a silent span is rejected');
  assert(v.reason === 'silent-span', `reason is silent-span (got ${v.reason})`);
  assert(v.detail.includes('0.0000'), 'detail carries the measured peak');
}

// ============================================================================
// Test 2: real beginner turns from the same session — must always survive
// ============================================================================
for (const [text, peak] of [
  ['Mis nectarinas', 0.18],
  ['Sí, ensalada de frutas', 0.22],
  ['La cama', 0.11],
  ['Hay un libro en la mesa', 0.31],
] as const) {
  const v = assessRealtimeTranscript({
    text,
    tutorText: TUTOR_GREETING,
    nearbyPeak: peak,
    tapHealthy: true,
    spanSec: 2.4,
  });
  assert(v.accept, `real turn accepted: "${text}"`);
}

// ============================================================================
// Test 3: beginner repeating the tutor WITH a live mic is real practice
// ============================================================================
{
  const v = assessRealtimeTranscript({
    text: "Is it very cold outside?",
    tutorText: TUTOR_GREETING,
    nearbyPeak: 0.25,
    tapHealthy: true,
    spanSec: 1.8,
  });
  assert(v.accept, 'verbatim echo over a clearly audible mic is kept');
}

// ============================================================================
// Test 4: tap unavailable/deaf — the echo rule is the only backstop
// ============================================================================
{
  const v = assessRealtimeTranscript({
    text: "Hey, so, how's it going today?",
    tutorText: TUTOR_GREETING,
    nearbyPeak: null, // tap off: no energy data
    tapHealthy: undefined,
    spanSec: 0.3,
  });
  assert(v.accept, 'missing audio cannot distinguish legitimate repetition from echo');
  assert(v.reason === null, 'unknown capture does not assert fabrication');
}

// ============================================================================
// Test 5: tap off + a normal short answer must NOT be rejected
// ============================================================================
{
  for (const text of ['Buenos días', 'Muy bien, gracias', 'No, hace calor hoy']) {
    const v = assessRealtimeTranscript({
      text,
      tutorText: TUTOR_GREETING,
      nearbyPeak: null,
      tapHealthy: undefined,
      spanSec: 1.5,
    });
    assert(v.accept, `tap-off turn accepted: "${text}"`);
  }
}

// ============================================================================
// Test 6: one-word echo over a live mic is standard practice (the silence rule
// is what protects it — reported words must be backed by audio at all)
// ============================================================================
{
  const v = assessRealtimeTranscript({
    text: 'afuera',
    tutorText: TUTOR_GREETING,
    nearbyPeak: 0.15,
    tapHealthy: true,
    spanSec: 0.9,
  });
  assert(v.accept, 'single-word echo accepted when the learner actually spoke');
  const silent = assessRealtimeTranscript({
    text: 'afuera',
    tutorText: TUTOR_GREETING,
    nearbyPeak: 0.0, // nobody touched the mic; the word cannot be the learner's
    tapHealthy: true,
    spanSec: 0.3,
  });
  assert(!silent.accept && silent.reason === 'silent-span', 'same word on a silent span is fabricated');
}

// ============================================================================
// Test 7: silent span with a short fabrication is still a fabrication
// ============================================================================
{
  const v = assessRealtimeTranscript({
    text: 'Sí, muy frío',
    tutorText: TUTOR_GREETING,
    nearbyPeak: 0.0,
    tapHealthy: true,
    spanSec: 0.3,
  });
  assert(!v.accept, 'silent span fabricated text rejected regardless of overlap');
}

// ============================================================================
// Test 8: deaf tap (never saw energy) must not trigger the silence rule
// ============================================================================
{
  const v = assessRealtimeTranscript({
    text: 'Hace mucho frío aquí',
    tutorText: TUTOR_GREETING,
    nearbyPeak: 0.0,
    tapHealthy: false, // tap attached but has never heard this mic
    spanSec: 2.0,
  });
  assert(v.accept, 'silence rule is disabled when the tap has never heard speech');
}

// ============================================================================
// Test 9: unknown peak ⇒ text-only rules, no false rejection
// ============================================================================
{
  const v = assessRealtimeTranscript({
    text: 'Mi comida favorita es la ensalada de frutas',
    tutorText: TUTOR_GREETING,
    nearbyPeak: null,
    tapHealthy: true,
    spanSec: 3.1,
  });
  assert(v.accept, 'unknown peak falls through to text rules');
}

// ============================================================================
// Test 10: collapsed span (text arrived after the speech) stays accepted
// ============================================================================
{
  const v = assessRealtimeTranscript({
    text: 'Hay una película sobre la ventana y la puerta oscura',
    tutorText: TUTOR_GREETING,
    nearbyPeak: 0.4, // mic was loud nearby, even though spanSec looks tiny
    tapHealthy: true,
    spanSec: 0.3,
  });
  assert(v.accept, 'implausible rate is a diagnostic, not a rejection');
  assert(v.detail.includes('implausible-rate'), 'rate anomaly is surfaced in the detail');
}

// ============================================================================
// Test 11: tokenizer / overlap edge cases
// ============================================================================
{
  assert(overlapRatio('¿Cómo estás?', 'cómo estás tú') === 1, 'accents and punctuation folded');
  assert(overlapRatio('MARGARET', 'margaret') === 1, 'case folded');
  assert(overlapRatio('', 'anything') === 0, 'empty candidate scores 0');
  assert(tokenize('a b cd ef').length === 2, 'single-letter tokens dropped');
  assert(tokenize('+').length === 0, 'bare "+" noise token yields nothing');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
