import type { PromptContext } from '../config/prompts/base.js';
import type { LearnerView } from './learner-view.js';

/** Shared transport-neutral composition. Inputs are resolved by the Node core,
 * never supplied by the browser or inferred by the media adapter. No DB writes.
 * Preserve the compact lesson card (not raw transcript) in the tutor prompt.
 */
export function buildLearnerPromptContext(
  view: Pick<LearnerView,'demandWords'|'activeChunk'>,
  context: Omit<PromptContext,'demandWords'|'lessonCard'>,
): PromptContext {
  return {
    ...context,
    demandWords: view.demandWords.map(w => `${w.lemma} (${w.translation})`).join(', '),
    lessonCard: view.activeChunk?.card ?? undefined,
  };
}
