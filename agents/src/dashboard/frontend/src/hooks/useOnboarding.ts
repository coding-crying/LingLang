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
import { apiFetch } from '../lib/api';

// Display names for languages actually implemented in
// agents/src/config/languages.ts — LanguageSheet is the selectable list
// and sources its options live from /api/languages/voices (the backend's
// own config), but this map is still used here and in VoiceTab for a
// short display label. Keep this in sync with languages.ts: listing a
// language here that the backend doesn't support isn't itself harmful
// (it's a fallback label, not a picker source) but was previously the
// picker's own source and caused a silent connect-time crash for
// unsupported codes — see LanguageSheet.tsx's comment.
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', ru: 'Russian', es: 'Spanish', fr: 'French',
  pt: 'Portuguese', ar: 'Arabic', zh: 'Chinese',
};

export interface OnboardingResult {
  /** True once the initial /api/me + /api/users/:id/onboarding/:lang
   *  round-trip has resolved (successfully or not) — mirrors VoiceRoom's
   *  original `onboardingChecked` flag. */
  checked: boolean;
  needsOnboarding: boolean;
  userId: string;
  targetLang: string | null;
  languageName: string | null;
  /** Mark onboarding as complete client-side (both the "submitted the
   *  form" and "skipped to talk to the tutor instead" paths call this —
   *  identical to VoiceRoom's onComplete/onSkipToVoice, which did the same
   *  `setNeedsOnboarding(false)` in both branches). */
  markComplete: () => void;
  /** Re-run the /api/me + onboarding check. Used after switching target
   *  language (LanguageSheet) so the gate re-evaluates onboarding status
   *  for the new language — a language the user hasn't onboarded in yet
   *  should show the onboarding gate again, same as it would on a fresh
   *  login for that language. */
  refresh: () => Promise<void>;
}

export function useOnboarding(): OnboardingResult {
  const [checked, setChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [userId, setUserId] = useState('');
  const [targetLang, setTargetLang] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const meRes = await apiFetch('/api/me');
      if (!meRes.ok) { setChecked(true); return; }
      const { user } = await meRes.json();
      const uid = user?.id ?? '';
      const lang = typeof user?.targetLanguage === 'string' ? user.targetLanguage : null;
      setUserId(uid);
      setTargetLang(lang);
      setNeedsOnboarding(!lang);
      if (uid && lang) {
        const obRes = await apiFetch(`/api/users/${uid}/onboarding/${lang}`);
        if (obRes.ok) {
          const ob = await obRes.json();
          setNeedsOnboarding(!ob.isComplete);
        }
      }
    } catch { /* non-fatal */ }
    setChecked(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const markComplete = useCallback(() => setNeedsOnboarding(false), []);

  return {
    checked,
    needsOnboarding,
    userId,
    targetLang,
    languageName: targetLang ? (LANGUAGE_NAMES[targetLang] ?? targetLang) : null,
    markComplete,
    refresh: load,
  };
}
