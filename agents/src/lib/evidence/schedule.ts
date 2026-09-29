// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createEmptyCard, fsrs } from 'ts-fsrs';
import type { Card } from 'ts-fsrs';
import type { Observation } from './contract.js';
import { candidateGrade } from './policy.js';

export interface TrajectoryEvent {
  id: string;
  userId: string;
  language: string;
  occurredAt: string;
  observations: Observation[];
}
/** Offline counterfactual only. Default reference parameters are NOT a production policy. */
export function candidateTrajectory(events: TrajectoryEvent[]) {
  const scheduler = fsrs({ enable_fuzz: false });
  const cards = new Map<
    string,
    { userId: string; language: string; lemma: string; card: Card; eventIds: string[] }
  >();
  const seen = new Set<string>();
  let skippedObservations = 0;
  for (const event of [...events].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
  )) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const time = new Date(event.occurredAt);
    if (!Number.isFinite(time.getTime())) throw new Error('Invalid event time');
    for (const o of event.observations) {
      const grade = candidateGrade(o);
      if (grade === null || o.language !== event.language) {
        skippedObservations++;
        continue;
      }
      const key = JSON.stringify([
        event.userId,
        event.language,
        o.lemma.normalize('NFKC').toLocaleLowerCase(),
      ]);
      const previous = cards.get(key);
      const card = scheduler.next(previous?.card ?? createEmptyCard(time), time, grade).card;
      cards.set(key, {
        userId: event.userId,
        language: event.language,
        lemma: o.lemma,
        card,
        eventIds: [...(previous?.eventIds ?? []), event.id],
      });
    }
  }
  return {
    kind: 'unverified-counterfactual' as const,
    reference: 'ts-fsrs@5.4.2 defaults, fuzz disabled',
    appliedToProduction: false as const,
    skippedObservations,
    cards: [...cards.values()],
  };
}
