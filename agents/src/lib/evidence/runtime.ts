// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { packetSchema } from './contract.js';
import type { EvidencePacket } from './contract.js';

export function evidenceMode(value = process.env.LINGLANG_EVIDENCE_MODE): 'off' | 'shadow' {
  return value === 'shadow' ? 'shadow' : 'off';
}
export function buildEvidencePacket(input: {
  userId: string;
  sessionId: string;
  turnId: string;
  language: string;
  text: string;
  occurredAt: string;
  turns: { role: 'user' | 'assistant'; content: string }[];
  measurements?: EvidencePacket['measurements'];
}): EvidencePacket | null {
  if (!input.text.trim() || /^\[audio key=/.test(input.text.trim())) return null;
  const context = input.turns
    .slice(0, -1)
    .slice(-10)
    .flatMap((t, i) => {
      const text = t.content.replace(/^\[audio key=[^\]]*\]\s*/, '').trim();
      return text
        ? [
            {
              id: `context-${i}`,
              role: t.role === 'assistant' ? ('tutor' as const) : ('learner' as const),
              text,
            },
          ]
        : [];
    });
  const parsed = packetSchema.safeParse({
    userId: input.userId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    language: input.language,
    occurredAt: input.occurredAt,
    source: 'transcript',
    measurements: input.measurements,
    turns: [...context, { id: input.turnId, role: 'learner', text: input.text.trim() }],
  });
  return parsed.success ? parsed.data : null;
}
