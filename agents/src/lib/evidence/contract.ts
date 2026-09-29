// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CONTRACT_VERSION = 'evidence-v1';
export const PROMPT_VERSION = 'observer-text-v2';
export const PROJECTION_VERSION = 'independent-production-v1';
const id = z.string().min(1).max(200);
export const packetSchema = z
  .object({
    userId: id,
    sessionId: id,
    turnId: id,
    language: z.string().regex(/^[a-z]{2,3}$/),
    occurredAt: z.string().datetime(),
    source: z.enum(['typed', 'transcript']),
    measurements: z
      .object({
        source: z.literal('realtime-event-span'),
        responseLatencyMs: z.number().finite().nullable(),
        speechDurationMs: z.number().finite().nonnegative().nullable(),
      })
      .strict()
      .optional(),
    turns: z
      .array(
        z
          .object({ id, role: z.enum(['tutor', 'learner']), text: z.string().min(1).max(8000) })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      new Set(p.turns.map((t) => t.id)).size !== p.turns.length ||
      p.turns.at(-1)?.id !== p.turnId ||
      p.turns.at(-1)?.role !== 'learner' ||
      p.turns.reduce((n, t) => n + t.text.length, 0) > 24000
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Packet must end in its unique learner turn and fit the context budget',
      });
    }
  });
export type EvidencePacket = z.infer<typeof packetSchema>;
export const observationSchema = z
  .object({
    lemma: z.string().min(1).max(120),
    form: z.string().min(1).max(200),
    language: z.string().regex(/^[a-z]{2,3}$/),
    kind: z.enum(['production', 'comprehension', 'exposure', 'mention']),
    assistance: z.enum(['answer_supplied', 'partial_cue', 'none', 'unknown']),
    outcome: z.enum(['succeeded', 'failed', 'indeterminate']),
    errorDomain: z.enum(['none', 'grammar', 'pronunciation', 'uncertain']),
    fluency: z.enum(['unavailable', 'fluent', 'struggled']),
    ambiguity: z.string().max(500).nullable(),
    evidence: z
      .array(z.object({ turnId: id, quote: z.string().min(1).max(1000) }).strict())
      .min(1)
      .max(6),
  })
  .strict();
export const resultSchema = z.object({ observations: z.array(observationSchema).max(80) }).strict();
export type Observation = z.infer<typeof observationSchema>;
export type ObservationResult = z.infer<typeof resultSchema>;
export function packetHash(packet: EvidencePacket): string {
  return createHash('sha256')
    .update(JSON.stringify(packetSchema.parse(packet)))
    .digest('hex');
}
export function containsForm(text: string, form: string): boolean {
  const escaped = form.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(
    text.normalize('NFKC'),
  );
}
export function validateObservations(packet: EvidencePacket, result: unknown): ObservationResult {
  const p = packetSchema.parse(packet);
  const parsed = resultSchema.parse(result);
  const turns = new Map(p.turns.map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (const o of parsed.observations) {
    const key = o.lemma.normalize('NFKC').toLowerCase().trim();
    if (seen.has(key)) throw new Error('Duplicate lexical observation');
    seen.add(key);
    if (o.language !== p.language) throw new Error('Observation language does not match packet');
    if (o.fluency !== 'unavailable' || o.errorDomain === 'pronunciation')
      throw new Error('Text observer cannot assess unavailable audio');
    for (const ref of o.evidence) {
      if (!turns.get(ref.turnId)?.text.includes(ref.quote))
        throw new Error('Evidence quote is not in referenced turn');
    }
    if (!o.evidence.some((e) => e.turnId === p.turnId))
      throw new Error('Current learner evidence required');
    if (o.assistance === 'none' && !o.evidence.some((e) => turns.get(e.turnId)?.role === 'tutor'))
      throw new Error(
        'Independent interpretation requires tutor context; otherwise assistance is unknown',
      );
    if (o.kind === 'production' && o.outcome === 'succeeded') {
      if (!containsForm(p.turns.at(-1)!.text, o.form))
        throw new Error('Produced form not present in current learner text');
    }
    if ((o.outcome === 'indeterminate' || o.assistance === 'unknown') && !o.ambiguity?.trim())
      throw new Error('Uncertain observations need an ambiguity reason');
  }
  return parsed;
}
