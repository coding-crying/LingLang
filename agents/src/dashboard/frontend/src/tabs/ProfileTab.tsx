/**
 * ProfileTab — profile basics (username/email/languages/member-since) plus
 * the backend service-mode switch (Local vs Cloud) and log out.
 *
 * `onLogout` used to be threaded through AppShell all the way down and
 * never actually rendered anywhere — there was no way to log out from the
 * UI at all. This is the first place it's wired up.
 *
 * Reads `serviceMode` from AppState (persisted to localStorage). The mode
 * only takes effect on the NEXT `/api/token` call — VoiceTab reads it at
 * connect time — since each mode is a fully independent room/job
 * (`linglang-<userId>-local` / `-cloud`, see server.ts's /api/token) and
 * switching never tears down a live session.
 *
 * 2026-07-16: "Local" is currently pointed at the experimental Audex-30B-A3B
 * cascaded s2s server (see resolveServiceMode in tutor-event-driven.ts) for
 * an A/B comparison against the previous local-gemma-audio pipeline — no
 * separate UI toggle for it, since there will only ever be one local mode.
 * Revert resolveServiceMode's mapping to go back to local-gemma-audio.
 */

import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, Card, Input, Label, ProgressBar, TextField, ToggleButton } from '@heroui/react';
import { useAppState, type ServiceMode } from '../state/AppState';
import { apiFetch } from '../lib/api';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';

interface MeResponse {
  id: string;
  username: string;
  email: string | null;
  targetLanguage: string;
  nativeLanguage: string;
  proficiencyLevel: string;
  createdAt: string | null;
  hasGoogleApiKey: boolean;
  googleUsageMicros: number;
  googleUsageLimitMicros: number | null;
}

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

const MODE_OPTIONS: { mode: ServiceMode; label: string; glyph: string; hint: string }[] = [
  { mode: 'local', label: 'Local', glyph: '🖥️', hint: 'Runs on our own GPU.' },
  { mode: 'cloud', label: 'Cloud', glyph: '☁️', hint: 'Gemini Live — use when the local machine is busy.' },
];

function formatMemberSince(iso: string | null): string {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export default function ProfileTab({ onLogout }: { onLogout: () => void }) {
  const { serviceMode, setServiceMode, localOnline, localAutoSwitched } = useAppState();
  const activeMode = MODE_OPTIONS.find((o) => o.mode === serviceMode) ?? MODE_OPTIONS[0];
  const [me, setMe] = useState<MeResponse | null>(null);

  const loadMe = useCallback(() => {
    apiFetch('/api/me')
      .then((r) => r.json())
      .then((data) => setMe(data.user))
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const [googleKeyInput, setGoogleKeyInput] = useState('');
  const [googleKeyBusy, setGoogleKeyBusy] = useState(false);
  const [googleKeyError, setGoogleKeyError] = useState<string | null>(null);

  const saveGoogleKey = useCallback(async () => {
    if (!me || googleKeyInput.trim().length < 10) {
      setGoogleKeyError('That doesn’t look like a valid key.');
      return;
    }
    setGoogleKeyBusy(true);
    setGoogleKeyError(null);
    try {
      const res = await apiFetch(`/api/users/${me.id}/google-key`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: googleKeyInput.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setGoogleKeyInput('');
      loadMe();
    } catch (err) {
      setGoogleKeyError(err instanceof Error ? err.message : 'Could not save key.');
    } finally {
      setGoogleKeyBusy(false);
    }
  }, [me, googleKeyInput, loadMe]);

  const removeGoogleKey = useCallback(async () => {
    if (!me) return;
    setGoogleKeyBusy(true);
    setGoogleKeyError(null);
    try {
      const res = await apiFetch(`/api/users/${me.id}/google-key`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      loadMe();
    } catch {
      setGoogleKeyError('Could not remove key.');
    } finally {
      setGoogleKeyBusy(false);
    }
  }, [me, loadMe]);

  const initial = (me?.username ?? '?').slice(0, 1).toUpperCase();

  return (
    <div className="profile-tab p-4 flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Profile</h2>

      <Card variant="secondary" className="gap-3 p-4">
        <div className="flex items-center gap-3">
          <Avatar>
            <Avatar.Fallback>{initial}</Avatar.Fallback>
          </Avatar>
          <div>
            <div className="text-base font-semibold">{me?.username ?? '…'}</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              {me?.email ?? 'No email on file'}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 text-sm mt-1">
          <div className="flex justify-between">
            <span style={{ color: 'var(--muted)' }}>Learning</span>
            <span>{me ? (LANGUAGE_NAMES[me.targetLanguage] ?? me.targetLanguage) : '—'}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--muted)' }}>Native language</span>
            <span>{me ? (LANGUAGE_NAMES[me.nativeLanguage] ?? me.nativeLanguage) : '—'}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--muted)' }}>Self-rated level</span>
            <span>{me ? capitalize(me.proficiencyLevel) : '—'}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--muted)' }}>Member since</span>
            <span>{me ? formatMemberSince(me.createdAt) : '—'}</span>
          </div>
        </div>
      </Card>

      <Card variant="secondary" className="gap-2 p-4">
        <div className="text-sm font-semibold mb-0.5">Tutor backend</div>
        <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>
          Choose which backend your next voice session connects to. This does
          not interrupt a session already in progress.
        </p>
        <div className="flex gap-2" role="radiogroup" aria-label="Tutor backend">
          {MODE_OPTIONS.map(({ mode, label, glyph }) => {
            const isLocalDown = mode === 'local' && localOnline === false;
            return (
              <ToggleButton
                key={mode}
                variant="ghost"
                isSelected={serviceMode === mode}
                isDisabled={isLocalDown}
                onChange={(isSelected) => isSelected && setServiceMode(mode)}
                className="flex-1 rounded-full"
                aria-label={isLocalDown ? `${label} (offline)` : label}
              >
                <span className="mr-1">{glyph}</span>
                {label}
                {isLocalDown && <span className="ml-1 text-xs">(offline)</span>}
              </ToggleButton>
            );
          })}
        </div>
        <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
          {localAutoSwitched
            ? 'Local went offline, so this session switched to Cloud automatically.'
            : activeMode.hint}
        </p>
      </Card>

      <Card variant="secondary" className="gap-2 p-4">
        <div className="text-sm font-semibold mb-0.5">Google API key (Cloud mode)</div>
        {me?.hasGoogleApiKey ? (
          <>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Using your own key — unlimited Cloud mode use.
            </p>
            <Button variant="ghost" size="sm" onPress={removeGoogleKey} isDisabled={googleKeyBusy}>
              Remove key
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Cloud mode is on a shared key with a limited budget. Paste your
              own free key from{' '}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                aistudio.google.com
              </a>{' '}
              for unlimited use — otherwise Local mode has no limit at all.
            </p>
            {me && me.googleUsageLimitMicros !== null && (
              <div className="flex flex-col gap-1 mt-1">
                <ProgressBar
                  aria-label="Shared Google API budget used"
                  value={Math.min(100, Math.round((me.googleUsageMicros / me.googleUsageLimitMicros) * 100))}
                  size="sm"
                >
                  <Label className="sr-only">Shared budget used</Label>
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                  {formatUsd(me.googleUsageMicros)} / {formatUsd(me.googleUsageLimitMicros)} used this period
                </span>
              </div>
            )}
            <TextField className="w-full mt-1" value={googleKeyInput} onChange={setGoogleKeyInput}>
              <Label className="sr-only">Google API key</Label>
              <Input placeholder="AIza..." type="password" />
            </TextField>
            {googleKeyError && (
              <span className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{googleKeyError}</span>
            )}
            <Button size="sm" onPress={saveGoogleKey} isDisabled={googleKeyBusy || googleKeyInput.trim().length < 10}>
              {googleKeyBusy ? 'Saving…' : 'Save key'}
            </Button>
          </>
        )}
      </Card>

      <Button variant="ghost" onPress={() => onLogout()} fullWidth>
        Log out
      </Button>
    </div>
  );
}
