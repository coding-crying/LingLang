// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import postgres from 'postgres';
import { CONTRACT_VERSION, PROMPT_VERSION } from './contract.js';
import type { EvidencePacket } from './contract.js';
import { EXAMPLE_VERSION, observe } from './observer.js';
import type { ObserverEndpoint, ObserverResult } from './observer.js';
import { capabilityDecision, endpointFingerprint } from './policy.js';
import { embedEpisode, rankEpisodes } from './retrieval.js';
import { evidenceMode } from './runtime.js';
import { EvidenceStore } from './store.js';

let store: EvidenceStore | undefined;
export function getEvidenceStore(): EvidenceStore {
  if (!store) {
    if (!process.env.DATABASE_URL) throw new Error('Evidence database is not configured');
    store = new EvidenceStore(
      postgres(process.env.DATABASE_URL, {
        max: 2,
        idle_timeout: 20,
        connect_timeout: 3,
        connection: { statement_timeout: 5000 },
      }),
    );
  }
  return store;
}
let inFlight = 0;
export async function runShadow(
  packet: EvidencePacket,
  endpoint: ObserverEndpoint,
  options: { mode?: string; store?: EvidenceStore } = {},
) {
  if (evidenceMode(options.mode) !== 'shadow') return { status: 'off' as const };
  const db = options.store ?? getEvidenceStore();
  const identity = {
    fingerprint: endpointFingerprint(endpoint.url),
    model: endpoint.model,
    language: packet.language,
  };
  let history = [
    ...(await db.history(
      packet.userId,
      packet.language,
      packet.turns.at(-1)!.text,
      packet.occurredAt,
    )),
  ];
  const vector =
    process.env.LINGLANG_EVIDENCE_RETRIEVAL === 'vector' ? await embedEpisode(packet) : null;
  if (vector) {
    try {
      const candidates = await db.vectorCandidates(
        packet.userId,
        packet.language,
        vector.model,
        packet.occurredAt,
      );
      const ranked = rankEpisodes(
        vector.vector,
        {
          userId: packet.userId,
          language: packet.language,
          model: vector.model,
          before: packet.occurredAt,
        },
        candidates,
      );
      const seen = new Set<string>();
      history = [
        ...history.slice(0, 2),
        ...ranked.map((r) => ({ id: r.id, packet: r.packet })),
        ...history.slice(2),
      ].filter((r) => {
        const id = String((r as { id: string }).id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    } catch {
      console.warn('[Evidence] Vector retrieval unavailable; exact history retained');
    }
  }
  let historyChars = 0;
  history = history
    .filter((r) => {
      const size = JSON.stringify(r).length;
      if (historyChars + size > 6000) return false;
      historyChars += size;
      return true;
    })
    .slice(0, 4);
  const claim = await db.claim(packet, identity, [...history]);
  if (!claim.claimed) return { status: 'reused' as const, id: claim.id };
  if (vector)
    await db
      .saveVector(claim.id, vector.model, vector.vector)
      .catch(() => console.warn('[Evidence] Vector cache write failed; assessment continues'));
  let result: ObserverResult;
  if (inFlight >= 2) {
    result = {
      status: 'error',
      observations: [],
      ...identity,
      promptVersion: PROMPT_VERSION,
      contractVersion: CONTRACT_VERSION,
      exampleVersion: EXAMPLE_VERSION,
      elapsedMs: 0,
      error: 'Observer capacity exhausted; event retained for retry',
    };
  } else {
    inFlight++;
    try {
      result = await observe(packet, endpoint, { history: claim.history });
    } finally {
      inFlight--;
    }
  }
  const profile = await db.capability(identity);
  const projections = result.observations.map((o) => {
    const authority = capabilityDecision(o, identity, profile);
    return {
      lemma: o.lemma,
      candidateGrade: authority.candidateGrade,
      grade: authority.authorized ? authority.candidateGrade : null,
      reason: authority.reason,
      authority,
      applied: false,
    };
  });
  const saved = await db.complete(claim.id, result, projections, claim.token);
  return {
    status: saved ? result.status : 'lease-lost',
    id: claim.id,
    observations: result.observations.length,
  };
}
