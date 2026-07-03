/**
 * Frontier mechanic — success-gated introduction budget.
 *
 * Replaces the old frozen known/new word-count ratio (parsed once from
 * initialContext at session start, never refreshed) with a pure function
 * of live DB state: recent grading success and the size of the due
 * backlog. Recomputed on every prompt build, so clearing the due queue
 * mid-session changes tutor behavior within a turn.
 *
 * See docs/superpowers/specs/2026-07-02-adaptive-loop-redesign-design.md §2.
 */

import { formatWordList, type WordRef } from './learner-view.js';
import type { FrontierInfo } from '../config/prompts/base.js';

// Thresholds — tune here, nowhere else.
const CONSOLIDATE_SUCCESS_THRESHOLD = 0.6;
const EXPAND_SUCCESS_THRESHOLD = 0.8;
const CONSOLIDATE_BACKLOG_THRESHOLD = 15;
const EXPAND_BACKLOG_THRESHOLD = 5;

export type FrontierState = 'consolidate' | 'balance' | 'expand';

export interface FrontierBudget {
  state: FrontierState;
  /** How many new words the tutor may reach for this turn. 0 in consolidate. */
  newWordBudget: number;
  directive: string;
}

function newWordHeadroom(dueBacklog: number): number {
  return Math.min(3, Math.max(1, 15 - dueBacklog));
}

/**
 * @param dueBacklog Count of currently-due user_vocabulary rows.
 * @param recentSuccess Fraction of grades >= Good over the last 20
 *   review_logs, or null if fewer than 5 logs exist (insufficient data).
 */
export function computeFrontierBudget(dueBacklog: number, recentSuccess: number | null): FrontierBudget {
  // Fewer than 5 logs: treat as balance unless the backlog itself is
  // already large enough to force consolidation.
  const success = recentSuccess ?? 1; // neutral: never trips consolidate/expand on success alone

  if (success < CONSOLIDATE_SUCCESS_THRESHOLD || dueBacklog > CONSOLIDATE_BACKLOG_THRESHOLD) {
    return {
      state: 'consolidate',
      newWordBudget: 0,
      directive: 'Work only with known/review words. Introduce nothing new.',
    };
  }

  if (recentSuccess !== null && success >= EXPAND_SUCCESS_THRESHOLD && dueBacklog < EXPAND_BACKLOG_THRESHOLD) {
    return {
      state: 'expand',
      newWordBudget: newWordHeadroom(dueBacklog),
      directive: 'Lead with new words — they have earned it.',
    };
  }

  const budget = newWordHeadroom(dueBacklog);
  return {
    state: 'balance',
    newWordBudget: budget,
    directive: `Introduce up to ${budget} new word${budget === 1 ? '' : 's'}, each scaffolded by known words in the same sentence.`,
  };
}

/**
 * Compose the prompt-ready FrontierInfo from live word candidates + the
 * budget. This is the single place all callers go to, so the directive
 * text and the word-list tail lines can never drift apart — a fresh user
 * with zero seeded vocab (dueBacklog=0, no candidates) would otherwise get
 * a "balance" directive that budgets new words while the actual word list
 * renders empty, a dangling reference the model will visibly get confused
 * by (it did, in testing — narrated the contradiction as its reply).
 */
export function buildFrontierInfo(dueWords: WordRef[], newWords: WordRef[], dueBacklog: number, recentSuccess: number | null): FrontierInfo {
  const budget = computeFrontierBudget(dueBacklog, recentSuccess);
  const dueWordsStr = formatWordList(dueWords);
  const newWordsStr = budget.newWordBudget > 0 ? formatWordList(newWords) : '';

  if (!dueWordsStr && !newWordsStr) {
    return {
      state: budget.state,
      directive: 'No due/new vocabulary yet — just react to what they said and get a feel for their level.',
      dueWords: '',
      newWords: '',
    };
  }

  return { state: budget.state, directive: budget.directive, dueWords: dueWordsStr, newWords: newWordsStr };
}
