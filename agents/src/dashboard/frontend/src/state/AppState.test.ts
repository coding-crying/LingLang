/**
 * Unit tests for AppState's theme-resolution priority logic
 * (localStorage → prefers-color-scheme → default 'dark').
 *
 * Plain assertion script (matches the repo's existing test-architecture.ts /
 * useConversationStream.test.ts convention — no test framework is configured
 * for this frontend package). Run with:
 *
 *   npx tsx src/dashboard/frontend/src/state/AppState.test.ts
 *
 * (from the `agents/` directory)
 *
 * Excluded from `tsc --noEmit -p .` by agents/tsconfig.json's
 * `src/**\/*.test.ts` exclude pattern, same as every other *.test.ts.
 */

import assert from 'node:assert';
import { resolveInitialTheme } from './AppState';

function fakeStorage(value: string | null): Pick<Storage, 'getItem'> {
  return { getItem: () => value };
}

function fakeMatchMedia(darkMatches: boolean, lightMatches: boolean) {
  return (query: string) => ({
    matches: query.includes('dark') ? darkMatches : lightMatches,
  });
}

// 1. localStorage has a valid value → wins over everything else.
assert.strictEqual(
  resolveInitialTheme(fakeStorage('light'), fakeMatchMedia(true, false)),
  'light',
  'localStorage light should win even if matchMedia prefers dark',
);
assert.strictEqual(
  resolveInitialTheme(fakeStorage('dark'), fakeMatchMedia(false, true)),
  'dark',
  'localStorage dark should win even if matchMedia prefers light',
);

// 2. localStorage absent/garbage → falls through to prefers-color-scheme.
assert.strictEqual(
  resolveInitialTheme(fakeStorage(null), fakeMatchMedia(true, false)),
  'dark',
  'no stored value + matchMedia dark → dark',
);
assert.strictEqual(
  resolveInitialTheme(fakeStorage(null), fakeMatchMedia(false, true)),
  'light',
  'no stored value + matchMedia light → light',
);
assert.strictEqual(
  resolveInitialTheme(fakeStorage('nonsense'), fakeMatchMedia(true, false)),
  'dark',
  'invalid stored value is ignored, falls through to matchMedia',
);

// 3. Neither localStorage nor matchMedia resolves anything → default 'dark'.
assert.strictEqual(
  resolveInitialTheme(fakeStorage(null), fakeMatchMedia(false, false)),
  'dark',
  'no stored value + no matchMedia match → default dark',
);
assert.strictEqual(
  resolveInitialTheme(null, null),
  'dark',
  'no storage/matchMedia available at all (SSR-like) → default dark',
);
assert.strictEqual(
  resolveInitialTheme(fakeStorage(null), null),
  'dark',
  'storage present but empty, matchMedia unavailable → default dark',
);

console.log('AppState.test.ts: all assertions passed');
