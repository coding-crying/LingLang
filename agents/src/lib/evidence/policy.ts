// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { PROMPT_VERSION } from './contract.js';
import type { Observation } from './contract.js';

export interface ModelIdentity {
  fingerprint: string;
  model: string;
  language: string;
}
export interface CapabilityProfile extends ModelIdentity {
  promptVersion: string;
  approved: boolean;
  report: string;
  expiresAt: string;
  capabilities: string[];
}

/**
 * Persistable explanation of the authority decision. This is deliberately
 * non-secret: it contains endpoint/model identity and gate results, never the
 * provider URL, API key, or model response.
 */
export interface CapabilityDecision {
  candidateGrade: 1 | 3 | null;
  authorized: boolean;
  reason: string;
  profileFound: boolean;
  profileApproved: boolean;
  profilePromptVersion: string | null;
  profileExpiresAt: string | null;
  profileCapabilities: string[];
  checks: {
    fingerprint: boolean;
    model: boolean;
    language: boolean;
    promptVersion: boolean;
    notExpired: boolean;
    production: boolean;
    assistance: boolean;
  };
}
export function endpointFingerprint(url: string): string {
  const u = new URL(url);
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  return createHash('sha256').update(u.toString().replace(/\/+$/, '')).digest('hex');
}
export function candidateGrade(o: Observation): 1 | 3 | null {
  if (
    o.kind !== 'production' ||
    o.assistance !== 'none' ||
    o.ambiguity ||
    o.errorDomain === 'uncertain'
  )
    return null;
  if (o.outcome === 'succeeded') return 3;
  if (o.outcome === 'failed' && o.errorDomain === 'none') return 1;
  return null;
}
export function capabilityDecision(
  o: Observation,
  identity: ModelIdentity,
  profile: CapabilityProfile | null,
  now = Date.now(),
): CapabilityDecision {
  const grade = candidateGrade(o);
  const capabilities = profile?.capabilities ?? [];
  const checks = {
    fingerprint: !!profile && profile.fingerprint === identity.fingerprint,
    model: !!profile && profile.model === identity.model,
    language:
      !!profile && profile.language === identity.language && o.language === identity.language,
    promptVersion: !!profile && profile.promptVersion === PROMPT_VERSION,
    notExpired: !!profile && Date.parse(profile.expiresAt) > now,
    production: capabilities.includes('production'),
    assistance: capabilities.includes('assistance'),
  };
  const authorized =
    grade !== null &&
    !!profile?.approved &&
    !!profile.report.trim() &&
    Object.values(checks).every(Boolean);
  let reason = 'Supported independent lexical outcome';
  if (grade === null) reason = 'Practice or insufficient independent lexical evidence';
  else if (!authorized)
    reason = 'Model assessment capability is unverified for this endpoint, prompt and language';
  return {
    candidateGrade: grade,
    authorized,
    reason,
    profileFound: !!profile,
    profileApproved: profile?.approved === true,
    profilePromptVersion: profile?.promptVersion ?? null,
    profileExpiresAt: profile?.expiresAt ?? null,
    profileCapabilities: capabilities,
    checks,
  };
}
export function projectObservation(
  o: Observation,
  identity: ModelIdentity,
  profile: CapabilityProfile | null,
  now = Date.now(),
): { grade: 1 | 3 | null; reason: string } {
  const decision = capabilityDecision(o, identity, profile, now);
  return {
    grade: decision.authorized ? decision.candidateGrade : null,
    reason: decision.reason,
  };
}
