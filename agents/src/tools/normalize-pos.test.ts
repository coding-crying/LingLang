/**
 * Unit tests for normalizePos().
 *
 * Plain assertion script, matching the repo convention (test-architecture.ts,
 * AppState.test.ts — no test framework configured). Run from `agents/`:
 *
 *   npx tsx src/tools/normalize-pos.test.ts
 *
 * The cases below are not invented: every "messy" input is a value that was
 * actually sitting in the lexemes.pos column of the live database, produced
 * by the processor's LLM over normal use.
 */

import assert from 'node:assert';
import { normalizePos } from './supervisor-functions.js';

// Canonical tags pass through untouched — the common case must not churn ids.
for (const t of ['NOUN', 'VERB', 'ADJ', 'ADV', 'PRON', 'INTJ', 'PREP', 'DET', 'NUM']) {
  assert.strictEqual(normalizePos(t), t, `${t} should be unchanged`);
}

// Case drift: `noun` (31 live rows) and `verb` (9) must not fork a second
// lexeme id from the uppercase form.
assert.strictEqual(normalizePos('noun'), 'NOUN');
assert.strictEqual(normalizePos('verb'), 'VERB');
assert.strictEqual(normalizePos('Noun'), 'NOUN');

// Spelled-out names the model sometimes prefers.
assert.strictEqual(normalizePos('adverb'), 'ADV');
assert.strictEqual(normalizePos('adjective'), 'ADJ');
assert.strictEqual(normalizePos('numeral'), 'NUM');
assert.strictEqual(normalizePos('pronoun'), 'PRON');

// Competing tag schemes for the same category. INTERJ→INTJ additionally
// fixes function-word detection: FUNCTION_WORD_POS contains INTJ but not
// INTERJ, so interjections tagged the long way were being treated as
// content words and getting native substitutions they should never get.
assert.strictEqual(normalizePos('INTERJ'), 'INTJ');
assert.strictEqual(normalizePos('interjection'), 'INTJ');
assert.strictEqual(normalizePos('ADP'), 'PREP');

// Separators normalize before alias lookup.
assert.strictEqual(normalizePos('proper noun'), 'PROPN');
assert.strictEqual(normalizePos('proper-noun'), 'PROPN');

// Empty/missing → the same placeholder the old code used.
assert.strictEqual(normalizePos(''), 'GENERAL');
assert.strictEqual(normalizePos('   '), 'GENERAL');
assert.strictEqual(normalizePos(null), 'GENERAL');
assert.strictEqual(normalizePos(undefined), 'GENERAL');

// Unknown tags are kept (uppercased), not flattened to GENERAL. `trợ_verb`
// is a real live value — the model answered in Vietnamese. Collapsing every
// unrecognized tag would merge genuinely distinct words, which is worse than
// carrying an odd one.
assert.strictEqual(normalizePos('trợ_verb'), 'TRỢ_VERB');
assert.strictEqual(normalizePos('CONTR'), 'CONTR');

// The property that actually matters: anything that should be one lexeme
// must produce one id.
for (const [a, b] of [['noun', 'NOUN'], ['INTERJ', 'intj'], ['ADP', 'prep'], ['adjective', 'ADJ']]) {
  assert.strictEqual(
    normalizePos(a), normalizePos(b),
    `${a} and ${b} must collapse to one lexeme id`,
  );
}

console.log('normalize-pos.test.ts: all assertions passed');

// Explicit: importing supervisor-functions.js opens the shared DB pool as a
// side effect, which leaves the event loop alive and makes the process exit
// non-zero even when every assertion passed. Exit on our own terms so the
// status code means "tests passed", not "pool shut down tidily".
process.exit(0);
