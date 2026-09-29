/**
 * LanguageSheet — real language switcher.
 *
 * Lists languages fetched live from /api/languages/voices — the same
 * LANGUAGES config the agent itself reads at connect time (Task 3's
 * endpoint, config/languages.ts) — NOT the frontend's static
 * LANGUAGE_NAMES map. That map used to be the list source here and
 * included languages (zh/ja/ko/it/nl/de) the backend never actually
 * implemented; picking one silently crashed the agent job on connect
 * with no user-facing error ("Unsupported language: zh. Supported: en,
 * ru, es, fr, pt, ar" in the agent log). Sourcing from the live backend
 * endpoint means this list can never drift out of sync with what's
 * actually supported again. LANGUAGE_NAMES is still used for the short
 * display label where we have one (falls back to the API's own name).
 *
 * Tapping a row PATCHes /api/users/:userId with the new targetLanguage —
 * that field is what the agent reads at dispatch time
 * (tutor-event-driven.ts's per-session context load), so the switch
 * takes effect the next time the user connects to Voice, not mid-call.
 * If the user hasn't onboarded in the new language yet, the onboarding
 * gate will show for it next load — same as it would on first login for
 * that language — which is why this calls `onSwitched` (AppShell wires
 * that to useOnboarding().refresh()).
 */

import type { Key } from 'react';
import { useEffect, useState } from 'react';
import { Button, Label, ListBox, Spinner, Typography } from '@heroui/react';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';
import { apiFetch } from '../lib/api';

interface LanguageOption {
  code: string;
  name: string;
}

interface LanguageSheetProps {
  userId: string;
  currentLang: string | null;
  onSwitched: () => void;
  onClose: () => void;
}

export default function LanguageSheet({ userId, currentLang, onSwitched, onClose }: LanguageSheetProps) {
  const [languages, setLanguages] = useState<LanguageOption[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLanguages(null);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch('/api/languages/voices');
        if (!res.ok) throw new Error(`Could not load languages (${res.status}).`);
        const data: { code: string; name: string }[] = await res.json();
        if (!data.length) throw new Error('No languages are available right now.');
        if (!cancelled) setLanguages(data.map((l) => ({ code: l.code, name: LANGUAGE_NAMES[l.code] ?? l.name })));
      } catch {
        if (!cancelled) {
          setLanguages([]);
          setError('Could not load languages. Check your connection and try again.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [loadAttempt]);

  const switchTo = async (code: string) => {
    if (code === currentLang || pending) return;
    setPending(code);
    setError(null);
    try {
      const res = await apiFetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLanguage: code }),
      });
      if (!res.ok) {
        let message = `Switch failed (${res.status})`;
        try {
          const body = await res.json() as { error?: string };
          if (body.error) message = body.error;
        } catch { /* preserve the HTTP failure when the body is not JSON */ }
        throw new Error(message);
      }
      const updated = await res.json() as { targetLanguage?: string | null };
      if (updated.targetLanguage !== code) {
        throw new Error('Language change was not confirmed by the server');
      }
      setPending(null);
      onSwitched();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Typography.Heading level={4}>Language</Typography.Heading>
      {languages === null ? (
        <div className="flex items-center gap-2 py-4 text-muted">
          <Spinner size="sm" /> Loading…
        </div>
      ) : (
        <ListBox
          aria-label="Languages"
          className="w-full"
          disabledKeys={pending ? [pending] : undefined}
          selectedKeys={currentLang ? [currentLang] : []}
          selectionMode="single"
          // onSelectionChange, NOT onAction: this is a controlled
          // single-selection ListBox, and React Aria only fires onAction for
          // action-style lists. Clicking a language therefore moved the
          // focus ring and nothing else — no PATCH, no switch — which is
          // exactly the "the language menu doesn't work" report. The
          // selection is controlled by `currentLang`, so the highlight only
          // moves once the server confirms and the refresh lands.
          onSelectionChange={(keys) => {
            const next = Array.from(keys as Iterable<Key>)[0];
            if (next !== undefined) void switchTo(String(next));
          }}
        >
          {languages.map(({ code, name }) => (
            <ListBox.Item key={code} id={code} textValue={name}>
              <Label>{name}</Label>
              {pending === code ? <Spinner className="ms-auto" size="sm" /> : <ListBox.ItemIndicator />}
            </ListBox.Item>
          ))}
        </ListBox>
      )}
      {error && languages?.length === 0 && <Button onPress={() => setLoadAttempt(n => n + 1)}>Try again</Button>}
      {error && <Typography color="muted" type="body-xs" className="text-danger">{error}</Typography>}
    </div>
  );
}
