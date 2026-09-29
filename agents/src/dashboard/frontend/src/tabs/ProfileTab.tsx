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

import { ProviderPolicyGate, type ProviderPolicyState } from '../components/ProviderPolicyGate';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, Card, Input, Label, ProgressBar, Switch, TextField, ToggleButton } from '@heroui/react';
import { useAppState, type ServiceMode } from '../state/AppState';
import { apiFetch } from '../lib/api';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';
import { ConversationSettings } from '../components/ConversationSettings';
import '../components/conversation-settings.css';

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
  { mode: 'local', label: 'Local', glyph: '🖥️', hint: 'Runs on our own GPU — no key or budget needed.' },
  { mode: 'cloud', label: 'Cloud · Gemini Live', glyph: '☁️', hint: 'Google\'s realtime speech model. Shared budget unless you add your own key below.' },
];

function formatMemberSince(iso: string | null): string {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export default function ProfileTab({ onLogout }: { onLogout: () => void }) {
  const { serviceMode, setServiceMode, localOnline, localAutoSwitched, debugEnabled, setDebugEnabled } = useAppState();
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

  // 2026-09-10: learner-facing progress, same three numbers the Voice tab's
  // chips show. A new user opening Profile should see what they've done, not
  // a settings page.
  const [summary, setSummary] = useState<{ streak: number; talkTimeHours: number; wordsDue: number } | null>(null);
  useEffect(() => {
    if (!me?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/users/${me.id}/summary`);
        if (res.ok && !cancelled) setSummary(await res.json());
      } catch { /* non-fatal — the card just stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, [me?.id]);

  const [providerPolicy, setProviderPolicy] = useState<ProviderPolicyState>('loading');
  useEffect(() => {
    let cancelled = false;
    setProviderPolicy('loading');
    apiFetch('/api/provider-policy').then(async (res) => {
      if (!res.ok) throw new Error('Policy unavailable');
      const value = await res.json();
      if (!['user', 'deployment'].includes(value.policy)) throw new Error('Invalid policy');
      if (!cancelled) setProviderPolicy(value.policy);
    }).catch(() => { if (!cancelled) setProviderPolicy('error'); });
    return () => { cancelled = true; };
  }, [me?.id]);

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

      {summary && (
        <Card variant="secondary" className="gap-2 p-4">
          <div className="text-sm font-semibold mb-0.5">Your progress</div>
          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between">
              <span style={{ color: 'var(--muted)' }}>Day streak</span>
              <span>{summary.streak}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--muted)' }}>Words ready to review</span>
              <span>{summary.wordsDue}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--muted)' }}>Time talking</span>
              <span>{summary.talkTimeHours}h</span>
            </div>
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Words become “ready to review” once you’ve met them and they start to fade.
            Just keeping talking — they come back to you.
          </p>
        </Card>
      )}

      {me && <ConversationSettings key={`${me.id}:${me.targetLanguage}:${serviceMode}`} userId={me.id} language={me.targetLanguage || 'pt'} mode={serviceMode} />}

      {/* 2026-09-10: collapsed by default. Backend selection, Google key and
          BYO providers are operator settings — a new learner used to open
          Profile and be greeted by endpoint URLs and API keys. */}
      <details className="profile-advanced">
        <summary>
          <span className="profile-advanced-label">Advanced settings</span>
          <span className="profile-advanced-hint">backend · API keys · providers</span>
        </summary>

      <ProviderPolicyGate state={providerPolicy}>
      <Card variant="secondary" className="gap-2 p-4">
        <div className="text-sm font-semibold mb-0.5">Tutor backend</div>
        <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>
          Where the voice conversation runs. If you set up your own AI
          providers below, those override the speech parts (STT/TTS) either
          way. Applies to your next session, not one in progress.
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
        <div className="text-sm font-semibold mb-0.5">Google API key — only for Cloud · Gemini Live</div>
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

      <ProvidersCard meId={me?.id ?? null} />
      </ProviderPolicyGate>

      {me?.id === 'will' && (
        <Card variant="secondary" className="gap-2 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Debug tools</div>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Show the admin Debug tab and processor benchmark diagnostics.
              </p>
            </div>
            <Switch
              aria-label="Enable Debug tools"
              isSelected={debugEnabled}
              size="sm"
              onChange={setDebugEnabled}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
        </Card>
      )}

      </details>

      <Button variant="ghost" onPress={() => onLogout()} fullWidth>
        Log out
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 2026-09-02: BYO speech-stack providers (see lib/provider-config.ts).
// Each of STT / LLM / TTS points at any endpoint the learner prefers —
// a local Ollama for the LLM plus an ElevenLabs key for TTS, etc. Empty
// components fall through to the operator defaults. Keys live in a named
// vault; the fields here only reference key names, never key material.
// ─────────────────────────────────────────────────────────────────────────

interface ComponentConfig {
  baseUrl?: string;
  model?: string;
  vendor?: string;
  voice?: string;
  keyRef?: string;
}
interface ProvidersShape {
  stt?: ComponentConfig;
  llm?: ComponentConfig;
  tts?: ComponentConfig;
  realtime?: { enabled?: boolean };
}
interface ProbeRow {
  component: 'stt' | 'llm' | 'tts';
  endpoint: string;
  ok: boolean;
  streaming: boolean | null;
  ttfbMs?: number;
  totalMs?: number;
  rtf?: number;
  bar?: number;
  meetsBar?: boolean;
  tokensPerSec?: number;
  audioSeconds?: number;
  chunks?: number;
  error?: string;
}

const COMPONENT_META: { key: 'stt' | 'llm' | 'tts'; label: string; placeholder: string; vendors?: string[] }[] = [
  { key: 'stt', label: 'Speech → text', placeholder: 'http://localhost:8001/v1 or api.groq.com/openai/v1', vendors: ['elevenlabs'] },
  { key: 'llm', label: 'Language model', placeholder: 'http://localhost:11434/v1 or https://openrouter.ai/api/v1' },
  { key: 'tts', label: 'Text → speech', placeholder: 'http://localhost:8882 (OmniVoice-compatible)', vendors: ['elevenlabs', 'openai', 'omnivoice'] },
];

function ProvidersCard({ meId }: { meId: string | null }) {
  const [providers, setProviders] = useState<ProvidersShape | null>(null);
  const [keyNames, setKeyNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeResults, setProbeResults] = useState<ProbeRow[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  // 2026-09-02: model auto-discovery — per-component list fetched from the
  // endpoint's /v1/models (or /v1/voices for OmniVoice). null = not fetched.
  const [discovered, setDiscovered] = useState<Record<string, string[] | null>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);
  // Collapsed by default; auto-expands once we know a config exists so a
  // returning BYO user lands straight in the editor instead of a summary row.
  const [open, setOpen] = useState(false);
  const [autoExpanded, setAutoExpanded] = useState(false);

  const load = useCallback(() => {
    if (!meId) return;
    apiFetch(`/api/users/${meId}/providers`)
      .then((r) => r.json())
      .then((data) => {
        setProviders(data.providers ?? {});
        setKeyNames(data.keyNames ?? []);
        const has = ['stt', 'llm', 'tts'].some((k) => data.providers?.[k]?.baseUrl);
        if (has && !autoExpanded) {
          setAutoExpanded(true);
          setOpen(true);
        }
      })
      .catch(() => {});
  }, [meId]);
  useEffect(load, [load]);

  if (!meId) return null;

  const patchComponent = (key: 'stt' | 'llm' | 'tts', field: keyof ComponentConfig, value: string) => {
    setSaved(false);
    setProviders((prev) => {
      const next: ProvidersShape = { ...(prev ?? {}) };
      const comp = { ...(next[key] ?? {}) };
      if (value === '') delete comp[field]; else (comp as any)[field] = value;
      // Drop the whole component object if it went empty — the server
      // treats {} as "configured with nothing", env default either way,
      // but null-ish is cleaner for GET round-trips.
      if (Object.keys(comp).length === 0) delete next[key]; else (next as any)[key] = comp;
      return next;
    });
  };

  // 2026-09-09: `realtime.enabled` has been in the data model (and in the
  // agent's mode resolver) since 2026-09-02 but had no control here — the
  // only way to turn Gemini Live on was a hand-written UPDATE on
  // users.speech_providers. This is that control.
  const patchRealtime = (enabled: boolean) => {
    setSaved(false);
    setProviders((prev) => {
      const next: ProvidersShape = { ...(prev ?? {}) };
      if (enabled) next.realtime = { enabled: true };
      else delete next.realtime;
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/users/${meId}/providers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSaved(true);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  // Probe the DRAFT currently in the editors (unsaved is fine — that's
  // the point: test before you commit a session to an unknown endpoint).
  const runProbe = async () => {
    setProbing(true);
    setProbeError(null);
    setProbeResults(null);
    try {
      const res = await apiFetch(`/api/users/${meId}/providers/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setProbeResults(body.results ?? []);
    } catch (e) {
      setProbeError(String((e as Error).message));
    } finally {
      setProbing(false);
    }
  };

  const addKey = async () => {
    if (!newKeyName.trim() || newKeyValue.trim().length < 10) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/users/${meId}/provider-keys/${encodeURIComponent(newKeyName.trim().toLowerCase())}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: newKeyValue.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setNewKeyName('');
      setNewKeyValue('');
      load();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async (name: string) => {
    await apiFetch(`/api/users/${meId}/provider-keys/${encodeURIComponent(name)}`, { method: 'DELETE' });
    load();
  };

  // Ask the server to list models from the component's draft baseUrl.
  // Fires automatically when a baseUrl is typed and the field blurs, and
  // manually via the "detect" button.
  const discoverModels = async (key: 'stt' | 'llm' | 'tts') => {
    const comp = providers?.[key];
    if (!meId || !comp?.baseUrl) return;
    setDiscovering(key);
    try {
      const res = await apiFetch(`/api/users/${meId}/providers/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: comp.baseUrl, keyRef: comp.keyRef, vendor: comp.vendor }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDiscovered((prev) => ({ ...prev, [key]: body.models ?? [] }));
    } catch (e) {
      setDiscovered((prev) => ({ ...prev, [key]: [] }));
      setError(`model list for ${key}: ${(e as Error).message}`);
    } finally {
      setDiscovering(null);
    }
  };

  // 2026-09-03: collapsible. The full editor stack (3 endpoint rows + key
  // vault + probe table) dominates the settings page for users who set it
  // once and never touch it again. Collapsed header shows a config summary
  // so it's clear at a glance whether BYO is active.
  const configured = providers
    ? (['stt', 'llm', 'tts'] as const).filter((k) => providers[k]?.baseUrl).length
    : 0;
  const summary = configured === 0
    ? 'not configured — using server defaults'
    : `${configured}/3 components pointed at your own endpoints`;

  if (!open) {
    return (
      <Card variant="secondary" className="p-0">
        <button
          type="button"
          className="w-full flex items-center justify-between gap-2 p-4 text-left"
          onClick={() => setOpen(true)}
          aria-expanded={false}
        >
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold">Your own AI providers (advanced)</span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>{summary}</span>
          </span>
          <span className="text-xs shrink-0 rounded-full px-2.5 py-1 border" style={{ borderColor: 'var(--border, #444)', color: 'var(--accent)' }}>
            edit ▾
          </span>
        </button>
      </Card>
    );
  }

  return (
    <Card variant="secondary" className="gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">Your own AI providers (advanced)</div>
        <button
          type="button"
          className="text-xs rounded-full px-2.5 py-1 border"
          style={{ borderColor: 'var(--border, #444)', color: 'var(--muted)' }}
          onClick={() => setOpen(false)}
          aria-expanded={true}
        >
          collapse ▴
        </button>
      </div>
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Point each part of the voice stack at a service you control — a local
        model, OpenRouter, Groq, ElevenLabs. Leave a row empty to use the
        server default. Takes effect on your next session.
      </p>

      {COMPONENT_META.map(({ key, label, placeholder, vendors }) => {
        const comp = providers?.[key] ?? {};
        return (
          <div key={key} className="flex flex-col gap-1.5 border-t pt-2" style={{ borderColor: 'var(--border, #333)' }}>
            <div className="text-xs font-semibold">{label}</div>
            {vendors && (
              <select
                className="text-xs rounded px-2 py-1.5 bg-transparent border"
                style={{ borderColor: 'var(--border, #444)' }}
                value={comp.vendor ?? ''}
                onChange={(e) => patchComponent(key, 'vendor', e.target.value)}
              >
                <option value="">OpenAI-compatible endpoint</option>
                {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            )}
            {(!comp.vendor || comp.vendor === 'omnivoice' || key === 'stt') && (
              <input
                className="text-xs rounded px-2 py-1.5 bg-transparent border w-full"
                style={{ borderColor: 'var(--border, #444)' }}
                placeholder={placeholder}
                defaultValue={comp.baseUrl ?? ''}
                onBlur={(e) => {
                  patchComponent(key, 'baseUrl', e.target.value.trim());
                  // Auto-detect models as soon as an endpoint is entered
                  // (2026-09-02: no manual model typing required).
                  if (e.target.value.trim()) setTimeout(() => discoverModels(key), 0);
                }}
              />
            )}
            <div className="flex gap-1.5">
              <input
                className="text-xs rounded px-2 py-1.5 bg-transparent border flex-1 min-w-0"
                style={{ borderColor: 'var(--border, #444)' }}
                placeholder={key === 'tts' ? (discovered[key]?.length ? 'pick a model/voice below' : 'model / voice id (or detect)') : discovered[key]?.length ? 'pick a model below' : 'model name (or detect)'}
                list={`provider-models-${key}`}
                value={comp.model ?? ''}
                onChange={(e) => patchComponent(key, 'model', e.target.value.trim())}
              />
              <datalist id={`provider-models-${key}`}>
                {(discovered[key] ?? []).map((m) => <option key={m} value={m} />)}
              </datalist>
              <button
                type="button"
                className="text-xs rounded px-2 py-1.5 border whitespace-nowrap"
                style={{ borderColor: 'var(--border, #444)' }}
                onClick={() => discoverModels(key)}
                disabled={!comp.baseUrl || discovering === key}
                title="List models from this endpoint"
              >
                {discovering === key ? '…' : 'Detect'}
              </button>
            </div>
            {discovered[key] && discovered[key]!.length > 0 && (
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                {discovered[key]!.length} model{discovered[key]!.length === 1 ? '' : 's'} found — type to filter or pick from the list
              </div>
            )}
            {keyNames.length > 0 && (
              <select
                className="text-xs rounded px-2 py-1.5 bg-transparent border"
                style={{ borderColor: 'var(--border, #444)' }}
                value={comp.keyRef ?? ''}
                onChange={(e) => patchComponent(key, 'keyRef', e.target.value)}
              >
                <option value="">no key (local server)</option>
                {keyNames.map((k) => <option key={k} value={k}>key: {k}</option>)}
              </select>
            )}
          </div>
        );
      })}

      <div className="flex flex-col gap-1.5 border-t pt-2" style={{ borderColor: 'var(--border, #333)' }}>
        <div className="text-xs font-semibold">API keys</div>
        {keyNames.map((k) => (
          <div key={k} className="flex items-center justify-between text-xs">
            <span style={{ color: 'var(--muted)' }}>{k} ••••</span>
            <Button variant="ghost" size="sm" onPress={() => removeKey(k)}>remove</Button>
          </div>
        ))}
        <div className="flex gap-1.5">
          <input
            className="text-xs rounded px-2 py-1.5 bg-transparent border flex-1 min-w-0"
            style={{ borderColor: 'var(--border, #444)' }}
            placeholder="name (e.g. elevenlabs)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
          />
          <input
            className="text-xs rounded px-2 py-1.5 bg-transparent border flex-[2] min-w-0"
            style={{ borderColor: 'var(--border, #444)' }}
            placeholder="paste key"
            type="password"
            value={newKeyValue}
            onChange={(e) => setNewKeyValue(e.target.value)}
          />
          <Button size="sm" variant="secondary" onPress={addKey} isDisabled={busy || !newKeyName.trim() || newKeyValue.trim().length < 10}>
            add
          </Button>
        </div>
      </div>

      {error && <span className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{error}</span>}

      {probeError && <span className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{probeError}</span>}
      {probeResults && probeResults.length === 0 && (
        <span className="text-xs" style={{ color: 'var(--muted)' }}>nothing configured to probe yet</span>
      )}
      {probeResults && probeResults.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-2" style={{ borderColor: 'var(--border, #333)' }}>
          <div className="text-xs font-semibold">Endpoint test</div>
          {probeResults.map((r) => (
            <div key={r.component} className="text-xs flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span style={{ color: r.ok ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>
                  {r.ok ? '●' : '✕'}
                </span>
                <span className="font-semibold">{r.component.toUpperCase()}</span>
                <span
                  className="rounded px-1.5 py-0.5"
                  style={{
                    color: 'var(--muted)',
                    border: '1px solid var(--border, #444)',
                  }}
                  title={r.streaming === null ? 'not measured' : r.streaming ? 'endpoint streams incrementally' : 'endpoint buffers the full response'}
                >
                  {r.streaming === null ? 'stream ?' : r.streaming ? 'streaming' : 'buffered'}
                </span>
                <span style={{ color: 'var(--muted)' }} title={r.endpoint}>
                  {r.endpoint.length > 46 ? r.endpoint.slice(0, 43) + '…' : r.endpoint}
                </span>
              </div>
              {r.ok ? (
                <div className="pl-5" style={{ color: 'var(--muted)' }}>
                  {r.ttfbMs !== undefined && <>TTFB {r.ttfbMs} ms · </>}
                  {r.totalMs !== undefined && <>total {r.totalMs} ms · </>}
                  {r.component === 'llm' && r.tokensPerSec !== undefined && <>{r.tokensPerSec} tok/s · {r.chunks} chunks · </>}
                  {r.component !== 'llm' && r.audioSeconds !== undefined && <>{r.audioSeconds}s audio · </>}
                  {r.rtf !== undefined && <>RTF {r.rtf}{r.meetsBar ? ` ✓ (bar <{r.bar})` : ` ⚠ needs <{r.bar}${r.streaming === false ? ' — buffered: full utterance is dead-air' : ''}`}{r.component === 'stt' ? ' (vs 1s clip)' : ''}</>}
                </div>
              ) : (
                <div className="pl-5" style={{ color: 'var(--danger, #ef4444)' }}>{r.error}</div>
              )}
            </div>
          ))}
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            RTF = processing time ÷ audio length. Streaming endpoints only
            need RTF &lt; 1 (generation stays ahead of playback); buffered
            ones must be far faster (&lt; 0.25) because you wait for the
            whole utterance before hearing anything. TTS/LLM probes consume
            a little of your provider quota.
          </span>
        </div>
      )}

      {/* 2026-09-09: realtime opt-in (Gemini Live). Sits below the cascaded
          components because it *replaces* them at session time — the agent's
          mode resolver upgrades to gemini and ignores stt/llm/tts above. */}
      <div
        className="flex items-start justify-between gap-3 border-t pt-3"
        style={{ borderColor: 'var(--border, #333)' }}
      >
        <div className="flex flex-col gap-0.5">
          <Label className="text-sm font-semibold">Gemini Live for conversation</Label>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            One realtime model handles speech-in, the language model, and
            speech-out in a single WebSocket. The three endpoints above are
            bypassed while this is on. Needs a Google API key — yours, or the
            shared budget.
          </span>
        </div>
        <Switch
          aria-label="Use Gemini Live for conversation"
          isSelected={providers?.realtime?.enabled === true}
          size="sm"
          onChange={patchRealtime}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onPress={save} isDisabled={busy || !providers}>
          {busy ? 'Saving…' : 'Save providers'}
        </Button>
        <Button size="sm" variant="ghost" onPress={runProbe} isDisabled={probing || busy || !providers}>
          {probing ? 'Testing…' : 'Test endpoints'}
        </Button>
        {saved && <span className="text-xs" style={{ color: 'var(--muted)' }}>saved — applies next session</span>}
      </div>
    </Card>
  );
}
