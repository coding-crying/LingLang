/**
 * useOnboarding — extracted (Task 4b) from VoiceRoom.tsx's inline
 * onboarding-gate check.
 *
 * Fetches `/api/me` to find the current user + their target language, then
 * `/api/users/:id/onboarding/:lang` to see whether the onboarding gate has
 * been completed. Exposes the resulting userId/targetLang too, since the
 * new tabbed shell (AppShell) needs both anyway — the caller (AppShell)
 * gates the entire tabbed app on `needsOnboarding`, not just the Voice
 * screen the way VoiceRoom.tsx did.
 */

import { useCallback, useEffect, useState } from 'react';

export const LANGUAGE_NAMES: Record<string, string> = {
  ru: 'Russian', pt: 'Portuguese', es: 'Spanish', fr: 'French',
  de: 'German', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', it: 'Italian', nl: 'Dutch', en: 'English',
};

export interface OnboardingResult {
  /** True once the initial /api/me + /api/users/:id/onboarding/:lang
   *  round-trip has resolved (successfully or not) — mirrors VoiceRoom's
   *  original `onboardingChecked` flag. */
  checked: boolean;
  needsOnboarding: boolean;
  userId: string;
  targetLang: string;
  languageName: string;
  /** Mark onboarding as complete client-side (both the "submitted the
   *  form" and "skipped to talk to the tutor instead" paths call this —
   *  identical to VoiceRoom's onComplete/onSkipToVoice, which did the same
   *  `setNeedsOnboarding(false)` in both branches). */
  markComplete: () => void;
}

export function useOnboarding(): OnboardingResult {
  const [checked, setChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [userId, setUserId] = useState('');
  const [targetLang, setTargetLang] = useState('ru');

  useEffect(() => {
    (async () => {
      try {
        const meRes = await fetch('/api/me');
        if (!meRes.ok) { setChecked(true); return; }
        const { user } = await meRes.json();
        const uid = user?.id ?? '';
        const lang = user?.targetLanguage ?? 'ru';
        setUserId(uid);
        setTargetLang(lang);
        if (uid) {
          const obRes = await fetch(`/api/users/${uid}/onboarding/${lang}`);
          if (obRes.ok) {
            const ob = await obRes.json();
            setNeedsOnboarding(!ob.isComplete);
          }
        }
      } catch { /* non-fatal */ }
      setChecked(true);
    })();
  }, []);

  const markComplete = useCallback(() => setNeedsOnboarding(false), []);

  return {
    checked,
    needsOnboarding,
    userId,
    targetLang,
    languageName: LANGUAGE_NAMES[targetLang] ?? targetLang,
    markComplete,
  };
}
