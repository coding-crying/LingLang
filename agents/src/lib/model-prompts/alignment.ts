// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { type PromptContext, buildInstructions } from '../../config/prompts/base.js';
import { validateGuidance } from './profile.js';

export interface Exchange {
  input: string;
  text: string;
  durationMs: number;
  firstOutputMs: number | null;
  audioBytes: number;
}
export type Dialogue = (
  system: string,
  turns: string[],
  signal: AbortSignal,
) => Promise<Exchange[]>;
export interface Trial {
  variant: string;
  split: string;
  repeat: number;
  promptHash: string;
  exchanges: Exchange[];
  flags: string[];
}
export interface AlignmentReport {
  candidates: Array<{ id: string; guidance: string }>;
  trials: Trial[];
  automaticallyApplied: false;
  notice: string;
}
const development = [
  "I'm a beginner. I like cooking, but please keep your replies brief.",
  "I didn't understand that. In my native language please, just one thing.",
];
const heldOut = [
  'Can we talk about my trip instead? I need time to think before I answer.',
  'Actually, explain that one phrase a little more, then let me try.',
];
export async function runAlignment(
  context: PromptContext,
  baseline: string,
  dialogue: Dialogue,
  signal: AbortSignal,
  progress: (report: AlignmentReport) => Promise<void> = async () => {},
) {
  signal.throwIfAborted();
  const rewrite = await dialogue(
    'Rewrite ONLY the optional model guidance for a language tutor. Goal: reciprocal, natural conversation; match rhythm, interests and comprehension. Try deleting or rewriting instructions before adding any. Leave the fixed privacy/comprehension contract and explicit user preferences alone. Return guidance only, under 900 characters, no commentary.',
    [`Current optional guidance: ${baseline}\nDevelopment example: ${development.join(' / ')}`],
    signal,
  );
  const guidance = validateGuidance(rewrite[0]?.text ?? '');
  if (!guidance) throw new Error('Alignment returned no candidate');
  const report: AlignmentReport = {
    candidates: [
      { id: 'baseline', guidance: baseline },
      { id: 'minimal', guidance: '' },
      { id: 'rewrite', guidance },
    ],
    trials: [],
    automaticallyApplied: false,
    notice:
      'Synthetic multi-turn screening, not proof of learning or conversational quality. Two repetitions; held-out cases were not used to propose the rewrite. Length and latency are observations, not scores. Review comprehension, reciprocity, clarity and privacy; try a real voice conversation before keeping a change.',
  };
  for (let repeat = 0; repeat < 2; repeat++) {
    // Rotate order on repeat to reduce warm-cache/provider-order bias.
    const candidates = repeat ? [...report.candidates].reverse() : report.candidates;
    for (const candidate of candidates) {
      for (const [split, turns] of [
        ['development', development],
        ['held-out', heldOut],
      ] as const) {
        signal.throwIfAborted();
        const system = buildInstructions({ ...context, modelGuidance: candidate.guidance });
        const exchanges = await dialogue(system, [...turns], signal);
        if (exchanges.length !== turns.length || exchanges.some((e) => !e.text.trim()))
          throw new Error('Incomplete alignment exchange');
        const flags = exchanges.flatMap((e, i) =>
          /\[COACH\]|get_coach_context|submit_onboarding_verdict|"tool_calls"/.test(e.text)
            ? [`turn ${i + 1}: possible private-context leakage`]
            : [],
        );
        if (context.realtime)
          exchanges.forEach((e, i) => {
            if (!e.audioBytes)
              flags.push(`turn ${i + 1}: realtime provider returned text without audio`);
          });
        report.trials.push({
          variant: candidate.id,
          split,
          repeat,
          promptHash: createHash('sha256').update(system).digest('hex'),
          exchanges,
          flags,
        });
        await progress(report);
      }
    }
  }
  return report;
}
