// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { EvidencePacket } from './contract.js';
import { endpointFingerprint } from './policy.js';

export const EPISODE_FORMAT = 'episode-v1';
export interface VectorEpisode {
  id: string;
  userId: string;
  language: string;
  model: string;
  format: string;
  occurredAt: string;
  vector: number[];
  packet: unknown;
}
export function episodeText(p: EvidencePacket): string {
  return JSON.stringify({
    format: EPISODE_FORMAT,
    language: p.language,
    turns: p.turns.map((t) => ({ role: t.role, text: t.text })),
  });
}
export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (
    !a.length ||
    a.length !== b.length ||
    a.some((x) => !Number.isFinite(x)) ||
    b.some((x) => !Number.isFinite(x))
  )
    return null;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  if (aa === 0 || bb === 0) return null;
  return dot / Math.sqrt(aa * bb);
}
export function rankEpisodes(
  query: number[],
  scope: { userId: string; language: string; model: string; before: string },
  rows: VectorEpisode[],
): VectorEpisode[] {
  return rows
    .filter(
      (r) =>
        r.userId === scope.userId &&
        r.language === scope.language &&
        r.model === scope.model &&
        r.format === EPISODE_FORMAT &&
        Date.parse(r.occurredAt) < Date.parse(scope.before),
    )
    .map((r) => ({ row: r, score: cosineSimilarity(query, r.vector) }))
    .filter((r): r is { row: VectorEpisode; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
    .slice(0, 2)
    .map((r) => r.row);
}
export async function embedEpisode(
  packet: EvidencePacket,
): Promise<{ model: string; vector: number[] } | null> {
  const url = process.env.EMBED_URL || 'http://localhost:8091/v1/embeddings';
  const model = process.env.EMBED_MODEL || 'BAAI/bge-m3';
  // Episode text is more sensitive than a vocabulary list. No implicit remote upload.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) return null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(2500),
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.EMBED_KEY ? { Authorization: `Bearer ${process.env.EMBED_KEY}` } : {}),
      },
      body: JSON.stringify({ model, input: [episodeText(packet)] }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { data?: { embedding?: number[] }[] };
    const vector = data.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length > 4096 || cosineSimilarity(vector, vector) === null)
      return null;
    return { model: `${model}:${endpointFingerprint(url)}`, vector };
  } catch {
    return null;
  }
}
