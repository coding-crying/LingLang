/**
 * wordChips — performance -> chip-class / color mapping for rendered
 * transcript words.
 *
 * Extracted verbatim (Task 4b) from VoiceRoom.tsx's `perfColors` /
 * `getChipClass`, which is the sole logic change we're allowed to make
 * here: none — this is a straight move, only the import path for the
 * shared `LexemeChip`/`SrsUpdate` types changed. Those types used to be
 * declared locally in VoiceRoom.tsx; Task 4a already re-declared identical
 * copies as the canonical, exported versions in `useConversationStream.ts`,
 * so we import from there instead of re-declaring a third copy that could
 * drift out of sync.
 */

// NOTE: this file is a plain `.ts` (not `.tsx`) file, so it gets swept into
// the backend/root `tsconfig.json`'s `src/**/*.ts` include glob and checked
// under that config's `moduleResolution: NodeNext`, which requires the
// `.js` extension on relative imports even though the target is a `.ts`
// file — same reason `useConversationStream.test.ts` already does this.
// Vite/esbuild (which the frontend actually builds with, under its own
// `moduleResolution: bundler` tsconfig) understand and rewrite this
// convention correctly, so it works in both places.
import type { LexemeChip, SrsUpdate } from '../hooks/useConversationStream.js';

export type { LexemeChip, SrsUpdate };

// ─── Performance → Color mapping ───

export const perfColors: Record<string, { bg: string; text: string; label: string }> = {
  correct:          { bg: '#1a5334', text: '#4ade80', label: '✓ correct' },
  correct_instant:  { bg: '#1a5334', text: '#4ade80', label: '✓✓ fluent' },
  correct_struggled:{ bg: '#1a3a5a', text: '#60a5fa', label: '~ struggled' },
  correct_use:      { bg: '#1a5334', text: '#4ade80', label: '✓ correct' }, // legacy
  wrong_use:        { bg: '#5a1a1a', text: '#f87171', label: '✗ wrong' },
  recall_fail:      { bg: '#5a3a1a', text: '#fbbf24', label: '? forgot' },
  scaffolded:       { bg: '#1a3a5a', text: '#60a5fa', label: '↻ scaffolded' }, // legacy
  native_substitution: { bg: '#5a4a1a', text: '#facc15', label: '⚠ native' },
  wrong_tone:       { bg: '#5a1a1a', text: '#f87171', label: '♪ wrong tone' },
};

// SRS state colors for mastered vs new
export function getChipClass(lex: LexemeChip, srsUpdates: SrsUpdate[]): string {
  const srs = srsUpdates.find(u => u.lexemeId.includes(lex.lemma) || u.lexemeId.includes(lex.form));
  const isNew = !srs || srs.newState <= 1;
  const isMastered = srs && srs.newState === 2 && srs.grade >= 3;

  if (lex.performance === 'correct' || lex.performance === 'correct_instant' || lex.performance === 'correct_use') {
    // --new (amber) for not-yet-mastered words used correctly, default/no
    // color for mastered ones.
    return isMastered ? 'chip-mastered' : 'chip-new';
  }
  if (lex.performance === 'correct_struggled') return 'chip-scaffolded'; // reuse blue "effortful" styling
  return `chip-${lex.performance}`;
}

/**
 * NEW (Task 4b, not present in VoiceRoom.tsx): resolve a stable id for a
 * lexeme chip so tapping a colored word can open
 * `openSheet({ kind: 'wordDetail', wordId })`. Reuses the same
 * lexemeId-matching heuristic getChipClass() uses internally (the SRS
 * update list is the only place a real lexeme id is available on this
 * event), falling back to a synthetic `lemma:pos` key when no matching SRS
 * update is present (e.g. a word with no SRS-visible update this turn).
 */
export function resolveWordId(lex: LexemeChip, srsUpdates: SrsUpdate[]): string {
  const srs = srsUpdates.find(u => u.lexemeId.includes(lex.lemma) || u.lexemeId.includes(lex.form));
  return srs?.lexemeId ?? `${lex.lemma}:${lex.pos}`;
}

/**
 * NEW (Task 4b): is this chip class "neutral" (fully correct AND mastered,
 * no error, scaffolding, or new-word signal)? Neutral words are rendered
 * inert — no pointer cursor, no tap handler, no `openSheet` call. Every
 * other chip class (newly-introduced correct word, scaffolded/struggled,
 * wrong use, recall failure, native substitution) is considered
 * non-neutral and tappable — a newly-introduced word is exactly the kind
 * of word a learner would want to tap into for more detail.
 */
export function isNeutralChip(chipClass: string): boolean {
  return chipClass === 'chip-mastered';
}
