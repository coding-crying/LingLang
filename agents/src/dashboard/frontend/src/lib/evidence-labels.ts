// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export function evidenceLabel(o: { kind: string; assistance: string; outcome: string }): string {
  if (o.kind === 'mention') return 'Mentioned, not demonstrated';
  if (o.kind === 'exposure') return 'Encountered in conversation';
  if (o.outcome === 'indeterminate' || o.assistance === 'unknown') return 'Not enough evidence';
  if (o.assistance === 'answer_supplied') return 'Practised with the answer supplied';
  if (o.assistance === 'partial_cue') return 'Practised with a hint';
  if (o.kind === 'comprehension') return 'Possible understanding — unverified';
  return o.outcome === 'succeeded'
    ? 'Possible independent use — unverified'
    : 'Possible retrieval difficulty — unverified';
}
