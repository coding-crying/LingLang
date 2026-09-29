import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Gemini's public Live API accepts append-only clientContent even though the
// LiveKit plugin disables its managed updateChatCtx() path for gemini-3.1.
// Regression: use the direct content lane without completing the turn.
const source = readFileSync(new URL('../tutor-event-driven.ts', import.meta.url), 'utf8');
const refresh = source.slice(
  source.indexOf('const refreshInstructions ='),
  source.indexOf('// Single place that actually moves a session'),
);
const delivery = source.slice(
  source.indexOf('const deliverCoachNote ='),
  source.indexOf('const refreshInstructions ='),
);
assert.match(
  refresh + delivery,
  /midSessionChatCtxUpdate\s*===\s*false/,
  'The limited plugin capability must select the direct content lane',
);
assert.ok(
  delivery.indexOf("type: 'content'") >= 0 && delivery.indexOf('turnComplete: false') >= 0,
  'Direct Gemini content injection must append without triggering a standalone reply',
);
assert.match(delivery, /coach\.note\.injected_direct/, 'Direct delivery must be observable');
assert.ok(
  delivery.indexOf('lastCoachNote = note') > delivery.indexOf("type: 'content'") ||
    delivery.indexOf('lastCoachNote = note') >
      delivery.indexOf('await realtimeSession.updateChatCtx'),
  'Only mark a note delivered after enqueueing the transport update',
);

const languageSwitch = source.slice(
  source.indexOf('async function applyTargetLanguage'),
  source.indexOf('// === AGENT SETUP'),
);
assert.match(
  source,
  /let onboardingState\s*=\s*await getOnboardingState/,
  'Onboarding state must be reloadable after a language choice',
);
assert.match(
  source,
  /let onboardingLadder\s*=\s*inOnboarding \? await getOnboardingLadder/,
  'Onboarding ladder must be reloadable after a language choice',
);
const reload = languageSwitch.indexOf(
  'onboardingState = await getOnboardingState(userId, newLang)',
);
const reloadLadder = languageSwitch.indexOf(
  'onboardingLadder = inOnboarding ? await getOnboardingLadder(newLang) : []',
);
const reloadLevel = languageSwitch.indexOf(
  'const freshLanguageEstimate = await inferLevel(userId, newLang)',
);
assert.ok(
  reload >= 0 && reloadLadder > reload && reloadLevel > reloadLadder,
  'Language switch must refresh target-scoped state in order',
);
console.log('coach note and language-switch regressions: 7 assertions passed');
