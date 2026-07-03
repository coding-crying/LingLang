/**
 * Pure calculation helpers backing GET /api/users/:userId/summary and
 * GET /api/users/:userId/vocab-history.
 *
 * Deliberately split out of server.ts: server.ts calls `app.listen(...)` at
 * import time, so importing it from a test would boot a real Express
 * server. These functions take plain data in and return plain data out —
 * no DB, no Express — so they can be unit tested directly.
 */

export interface ReviewLogRow {
  userVocabularyId: string;
  reviewDate: Date;
  state: number;
}

/** Format a Date as a server-local YYYY-MM-DD calendar-date string. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Whole-day difference between two YYYY-MM-DD strings (a - b), DST-safe. */
function dayDiff(a: string, b: string): number {
  const da = new Date(`${a}T12:00:00`);
  const dbb = new Date(`${b}T12:00:00`);
  return Math.round((da.getTime() - dbb.getTime()) / 86_400_000);
}

/**
 * Current consecutive-day practice streak, server-local timezone.
 *
 * Semantics (per the plan brief's "common practice-app convention"): a
 * streak survives one day without practice. If the most recent practice
 * date is today OR yesterday, the streak is the length of the consecutive
 * run of calendar days ending on that most recent date. If the most recent
 * practice date is neither today nor yesterday (a real gap), the streak is
 * 0 — practice needs to resume before a new streak starts counting.
 *
 * `reviewDates` need not be sorted or deduplicated; duplicates within the
 * same calendar day collapse to one.
 */
export function computeStreak(reviewDates: Date[], now: Date = new Date()): number {
  if (reviewDates.length === 0) return 0;

  const uniqueDesc = Array.from(new Set(reviewDates.map(localDateKey))).sort().reverse();
  const todayKey = localDateKey(now);
  const yesterdayKey = localDateKey(new Date(now.getTime() - 86_400_000));

  const mostRecent = uniqueDesc[0];
  if (mostRecent !== todayKey && mostRecent !== yesterdayKey) return 0;

  let streak = 1;
  for (let i = 1; i < uniqueDesc.length; i++) {
    const later = uniqueDesc[i - 1]!;
    const earlier = uniqueDesc[i]!;
    if (dayDiff(later, earlier) === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/** Monday-start ISO week label, e.g. "2026-W27". */
function isoWeekLabel(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Monday 00:00 server-local of the week containing `d`. */
function mondayOf(d: Date): Date {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Layer/state mapping (documented choice — the brief leaves the exact
// mapping to us). This is a straight ordinal mapping from FSRS state
// (0=New, 1=Learning, 2=Review, 3=Relearning) onto the design's four
// labels: 0 New -> "New", 1 Learning -> "Learning", 2 Review -> "Known"
// (the bulk of established, spaced-out vocab sits in the Review state),
// 3 Relearning -> "Fluent". The last mapping is an approximation — a
// "Relearning" row technically means the item just lapsed, not that it's
// mastered — but reviewLogs.state only gives us 4 discrete buckets, and a
// straight 1:1 ordinal mapping is the simplest option that keeps each of
// the 4 chart layers backed by exactly one FSRS state without inventing
// extra bucket-merging logic on approximate historical data.
export const VOCAB_HISTORY_LAYER_LABELS = ['New', 'Learning', 'Known', 'Fluent'] as const;

export interface VocabHistoryResult {
  weeks: string[];
  layers: { label: string; counts: number[] }[];
}

/**
 * Bucket a user's review history into weekly cumulative FSRS-state
 * snapshots, shaped for a stacked-area "vocab growth" chart.
 *
 * `userVocabulary` only stores the CURRENT state per lexeme — it isn't
 * versioned — so there's no direct way to know what state a word was in
 * N weeks ago. This approximates it: for each week boundary, take the
 * latest `reviewLogs.state` seen so far (as of that week's end) for each
 * distinct vocab item (`userVocabularyId`), and count how many land in
 * each of the 4 FSRS states. `reviewLogs.state` is the state snapshot *at
 * the time of that review* (see the review_logs comment in schema.ts), so
 * scanning review history in order reconstructs a plausible per-item
 * state trajectory over time without needing real versioning.
 */
export function bucketVocabHistory(
  logs: ReviewLogRow[],
  weeks: number,
  now: Date = new Date(),
): VocabHistoryResult {
  const currentMonday = mondayOf(now);
  const weekBoundaries: { label: string; cutoff: number }[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekMonday = new Date(currentMonday);
    weekMonday.setDate(weekMonday.getDate() - i * 7);
    const cutoff = new Date(weekMonday);
    cutoff.setDate(cutoff.getDate() + 7); // exclusive upper bound = start of next week
    weekBoundaries.push({ label: isoWeekLabel(weekMonday), cutoff: cutoff.getTime() });
  }

  const sorted = [...logs].sort((a, b) => a.reviewDate.getTime() - b.reviewDate.getTime());

  const latestState = new Map<string, number>();
  let ptr = 0;
  const countsPerWeek: number[][] = []; // [weekIdx][stateIdx]

  for (const { cutoff } of weekBoundaries) {
    while (ptr < sorted.length && sorted[ptr]!.reviewDate.getTime() < cutoff) {
      const row = sorted[ptr]!;
      latestState.set(row.userVocabularyId, row.state);
      ptr++;
    }
    const counts: number[] = [0, 0, 0, 0];
    for (const state of latestState.values()) {
      if (state >= 0 && state <= 3) counts[state] = (counts[state] ?? 0) + 1;
    }
    countsPerWeek.push(counts);
  }

  const layers = VOCAB_HISTORY_LAYER_LABELS.map((label, stateIdx) => ({
    label,
    counts: countsPerWeek.map(c => c[stateIdx] ?? 0),
  }));

  return {
    weeks: weekBoundaries.map(w => w.label),
    layers,
  };
}
