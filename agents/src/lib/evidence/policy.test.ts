// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROMPT_VERSION, observationSchema } from './contract.js';
import {
  candidateGrade,
  capabilityDecision,
  endpointFingerprint,
  projectObservation,
} from './policy.js';

const o = observationSchema.parse({
  lemma: 'café',
  form: 'café',
  language: 'pt',
  kind: 'production',
  assistance: 'none',
  outcome: 'succeeded',
  errorDomain: 'none',
  fluency: 'unavailable',
  ambiguity: null,
  evidence: [{ turnId: 't', quote: 'café' }],
});
test('capability authority is separate from the inferred success', () => {
  const identity = {
    fingerprint: endpointFingerprint('https://example.org/v1'),
    model: 'small',
    language: 'pt',
  };
  assert.equal(candidateGrade(o), 3);
  const unverified = capabilityDecision(o, identity, null);
  assert.equal(unverified.candidateGrade, 3);
  assert.equal(unverified.authorized, false);
  assert.equal(unverified.profileFound, false);
  assert.equal(unverified.checks.production, false);
  assert.equal(
    unverified.reason,
    'Model assessment capability is unverified for this endpoint, prompt and language',
  );
  assert.equal(projectObservation(o, identity, null).grade, null);
  const profile = {
    ...identity,
    promptVersion: PROMPT_VERSION,
    approved: true,
    report: 'reviewed-report',
    expiresAt: '2099-01-01T00:00:00Z',
    capabilities: ['production', 'assistance'],
  };
  assert.equal(projectObservation(o, identity, profile).grade, 3);
  for (const change of [
    { model: 'other' },
    { language: 'ru' },
    { fingerprint: 'other' },
    { promptVersion: 'old' },
    { approved: false },
    { report: '' },
    { expiresAt: '2000-01-01T00:00:00Z' },
    { capabilities: ['production'] },
  ]) {
    assert.equal(projectObservation(o, identity, { ...profile, ...change }).grade, null);
  }
  for (const change of [
    { assistance: 'answer_supplied' },
    { assistance: 'partial_cue' },
    { kind: 'mention' },
    { kind: 'comprehension' },
    { outcome: 'indeterminate' },
    { errorDomain: 'uncertain' },
  ] as const) {
    assert.equal(candidateGrade({ ...o, ...change }), null);
  }
  assert.equal(candidateGrade({ ...o, outcome: 'failed' }), 1);
  assert.equal(candidateGrade({ ...o, outcome: 'failed', errorDomain: 'grammar' }), null);
});
