// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';
import { apiFetch } from '../lib/api';

type Values = Record<string, string | null>;
type Profile = { revision: number; guidance: string | null; evaluationId: string | null };
type ModelSettings = {
  identity: { key: string; model: string; transport: string };
  profile: Profile;
  defaultGuidance: string;
  preview: string;
  previewNotice: string;
  canAlign: boolean;
  calibrationModality: string;
  history: Profile[];
  jobs: { id: string; status: string }[];
};
type Exchange = {
  input: string;
  text: string;
  durationMs: number;
  firstOutputMs: number | null;
  audioBytes: number;
};
type Job = {
  id: string;
  status: string;
  report: {
    completed: number;
    total: number;
    modality: string;
    result: {
      notice: string;
      candidates: { id: string; guidance: string }[];
      trials: {
        variant: string;
        split: string;
        repeat: number;
        exchanges: Exchange[];
        flags: string[];
      }[];
    } | null;
  };
};
type ArchiveSession = {
  sessionId: string;
  startedAt: string;
  eventCount: number;
  languages: string[];
};
type ArchiveEvent = {
  cursor: string;
  payload: {
    id: string;
    role: string;
    text: string;
    status: string;
    interrupted: boolean | null;
    occurredAt: string;
    source: string;
    revisionOf?: string;
    reason?: string;
  };
};
const fields = ['tone', 'correctionStyle', 'teachingMode', 'extraInstructions', 'personaOverride'];
const selections = [
  { key: 'tone', label: 'Tone', options: ['roast', 'warm', 'neutral', 'formal', 'drill-sergeant'] },
  {
    key: 'correctionStyle',
    label: 'Corrections',
    options: ['immediate', 'gentle', 'ignore', 'end-of-turn'],
  },
  {
    key: 'teachingMode',
    label: 'Teaching style',
    options: ['conversational', 'drill', 'roleplay', 'storytelling'],
  },
];
const friendly = (value: string) => value.replaceAll('-', ' ');
async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await apiFetch(
    path,
    body === undefined
      ? undefined
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export function ConversationSettings({
  userId,
  language,
  mode,
}: {
  userId: string;
  language: string;
  mode: 'local' | 'cloud';
}) {
  const [scope, setScope] = useState(language);
  const [values, setValues] = useState<Values>({});
  const [effective, setEffective] = useState<Values>({});
  const [patch, setPatch] = useState<Values>({});
  const [inherit, setInherit] = useState<string[]>([]);
  const [preferenceReady, setPreferenceReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<ModelSettings | null>(null);
  const [guidance, setGuidance] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [sessions, setSessions] = useState<ArchiveSession[]>([]);
  const [sessionsNext, setSessionsNext] = useState<string | null>(null);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [events, setEvents] = useState<ArchiveEvent[]>([]);
  const [selectedSession, setSelectedSession] = useState('');
  const [eventNext, setEventNext] = useState<string | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const prefPath = `/api/users/${encodeURIComponent(userId)}/persona`;
  const loadPreferences = useCallback(async () => {
    setPreferenceReady(false);
    const data = await request<{
      rows: { languageCode: string; explicitPreferences: Values }[];
      effective: Values;
    }>(`${prefPath}?lang=${scope}`);
    if (scopeRef.current !== scope) return;
    setValues(data.rows.find((r) => r.languageCode === scope)?.explicitPreferences || {});
    setEffective(data.effective);
    setPatch({});
    setInherit([]);
    setPreferenceReady(true);
  }, [prefPath, scope]);
  const loadModel = useCallback(async () => {
    const data = await request<ModelSettings>(
      `/api/model-prompts?language=${language}&mode=${mode}`,
    );
    setModel(data);
    setGuidance(data.profile.guidance ?? data.defaultGuidance);
    setJob(data.jobs[0] ? await request<Job>(`/api/model-prompts/jobs/${data.jobs[0].id}`) : null);
  }, [language, mode]);
  useEffect(() => {
    setScope(language);
  }, [language]);
  useEffect(() => {
    void loadPreferences().catch((e) => setError(e.message));
  }, [loadPreferences]);
  useEffect(() => {
    setModel(null);
    setJob(null);
    void loadModel().catch((e) => setError(e.message));
  }, [loadModel]);
  useEffect(() => {
    if (job?.status !== 'running') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void request<Job>(`/api/model-prompts/jobs/${job.id}`)
        .then((j) => {
          if (!cancelled) setJob(j);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }
  function change(key: string, value: string) {
    setValues((old) => {
      const next = { ...old };
      if (value === '__inherit') delete next[key];
      else next[key] = value === '__default' ? null : value;
      return next;
    });
    setPatch((old) => {
      const next = { ...old };
      if (value === '__inherit') delete next[key];
      else next[key] = value === '__default' ? null : value;
      return next;
    });
    setInherit((old) =>
      value === '__inherit' ? [...new Set([...old, key])] : old.filter((x) => x !== key),
    );
  }
  async function savePreferences() {
    await request(prefPath, { languageCode: scope, ...patch, inheritFields: inherit }, 'PATCH');
    await loadPreferences();
    await loadModel();
    setNotice(
      'Preferences saved. Guaranteed from your next session; current-call coaching is best-effort.',
    );
  }
  async function saveModel(reset = false, value = guidance) {
    if (!model) return;
    await request(
      '/api/model-prompts',
      {
        language,
        mode,
        profileKey: model.identity.key,
        revision: model.profile.revision,
        guidance: value,
        reset,
      },
      'PUT',
    );
    await loadModel();
    setNotice(
      reset
        ? 'Model guidance reset. Personal preferences and history are unchanged.'
        : 'Model guidance saved as untested. Applies to your next session.',
    );
  }
  async function loadArchive(before?: string) {
    const data = await request<{ sessions: ArchiveSession[]; next: string | null }>(
      `/api/conversations${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    );
    setSessions((old) => (before ? [...old, ...data.sessions] : data.sessions));
    setSessionsNext(data.next);
    setArchiveLoaded(true);
  }
  async function loadEvents(id: string, after?: string) {
    const data = await request<{ events: ArchiveEvent[]; next: string | null }>(
      `/api/conversations/${encodeURIComponent(id)}${after ? `?after=${after}` : ''}`,
    );
    setSelectedSession(id);
    setEvents((old) => (after ? [...old, ...data.events] : data.events));
    setEventNext(data.next);
  }
  async function exportSession() {
    let after: string | null = null;
    const all: ArchiveEvent[] = [];
    do {
      const data: { events: ArchiveEvent[]; next: string | null } = await request<{
        events: ArchiveEvent[];
        next: string | null;
      }>(
        `/api/conversations/${encodeURIComponent(selectedSession)}${after ? `?after=${after}` : ''}`,
      );
      all.push(...data.events);
      after = data.next;
    } while (after);
    const blob = new Blob(
      [
        JSON.stringify(
          {
            sessionId: selectedSession,
            notice:
              'Source events, not mastery assessments. No raw audio. Rejected/corrected events retain provenance.',
            events: all,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'linglang-conversation.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const dirty = Object.keys(patch).length + inherit.length > 0;
  return (
    <section className="conversation-settings" aria-label="Conversation settings">
      {error && (
        <p role="alert" className="error-msg">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="settings-notice">
          {notice}
        </p>
      )}
      <div className="settings-card">
        <h2>Conversation preferences</h2>
        <p>
          How should the tutor talk with you? Your choices outrank observed style. Changes apply
          from your next session.
        </p>
        <label>
          Apply to
          <select
            aria-label="Preference scope"
            value={scope}
            disabled={busy}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value={language}>{LANGUAGE_NAMES[language] || language}</option>
            <option value="all">All languages</option>
          </select>
        </label>
        <fieldset disabled={busy || !preferenceReady}>
          <div className="settings-fields">
            {selections.map((field) => (
              <label key={field.key}>
                {field.label}
                <select
                  aria-label={field.label}
                  value={
                    Object.hasOwn(values, field.key)
                      ? (values[field.key] ?? '__default')
                      : '__inherit'
                  }
                  onChange={(e) => change(field.key, e.target.value)}
                >
                  <option value="__inherit">Inherit / adapt</option>
                  <option value="__default">System default</option>
                  {field.options.map((v) => (
                    <option key={v} value={v}>
                      {friendly(v)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <label>
            Conversation requests
            <textarea
              aria-label="Conversation requests"
              rows={3}
              maxLength={2000}
              value={values.extraInstructions || ''}
              placeholder="Keep it brief. Let me finish. Explain more when I ask."
              onChange={(e) => change('extraInstructions', e.target.value)}
            />
          </label>
          <details>
            <summary>Custom persona</summary>
            <label>
              Replace the default style description
              <textarea
                aria-label="Custom persona"
                rows={3}
                maxLength={2000}
                value={values.personaOverride || ''}
                onChange={(e) => change('personaOverride', e.target.value)}
              />
            </label>
            <p>Preferences customize conversation style, not learning scores or safety rules.</p>
          </details>
          <div className="settings-actions">
            <button
              className="btn-primary"
              disabled={!dirty}
              onClick={() => void act(savePreferences)}
            >
              Save preferences
            </button>
            <button
              className="btn-text"
              onClick={() =>
                void act(async () => {
                  await request(prefPath, { languageCode: scope, inheritFields: fields }, 'PATCH');
                  await loadPreferences();
                  await loadModel();
                  setNotice(
                    'Explicit choices cleared for this scope. Global preferences and observed style can apply again.',
                  );
                })
              }
            >
              Use inherited preferences
            </button>
          </div>
        </fieldset>
        <p className="settings-meta">
          Effective: {effective.tone || 'adaptive tone'} ·{' '}
          {effective.correctionStyle || 'default corrections'} ·{' '}
          {effective.teachingMode || 'natural conversation'}
        </p>
      </div>
      <details className="settings-card">
        <summary>
          <h2>Model behavior</h2>
          <span>Advanced · Align / Edit / Reset</span>
        </summary>
        <p>
          Adjust how this model is instructed—not your personal preferences. Versions stay fixed
          during a call.
        </p>
        {!model ? (
          <p>Loading model configuration…</p>
        ) : (
          <>
            <p>
              <strong>{model.identity.model}</strong> · {model.identity.transport} · revision{' '}
              {model.profile.revision}
              <br />
              <span className="settings-meta">
                {model.profile.revision === 0
                  ? 'Default'
                  : model.profile.evaluationId
                    ? 'Synthetic comparison reviewed; voice trial still needed'
                    : 'Untested custom edit'}
              </span>
            </p>
            <label>
              Optional model guidance
              <textarea
                aria-label="Optional model guidance"
                maxLength={2000}
                rows={5}
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
              />
            </label>
            <p>
              Empty guidance deliberately removes this optional layer. The shared tutor contract and
              your preferences remain.
            </p>
            <div className="settings-actions">
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() => void act(() => saveModel())}
              >
                Save untested edit
              </button>
              <button
                className="btn-text"
                disabled={busy}
                onClick={() => void act(() => saveModel(true))}
              >
                Reset model guidance
              </button>
              <button className="btn-text" disabled={busy} onClick={() => void act(loadModel)}>
                Refresh model
              </button>
            </div>
            <details>
              <summary>Effective prompt preview</summary>
              <p>{model.previewNotice}</p>
              <pre className="settings-preview">{model.preview}</pre>
            </details>
            {model.history.length > 1 && (
              <label>
                Revert to an earlier version
                <select
                  aria-label="Revert model version"
                  value=""
                  disabled={busy}
                  onChange={(e) => {
                    const previous = model.history.find(
                      (v) => String(v.revision) === e.target.value,
                    );
                    if (previous)
                      void act(() =>
                        saveModel(previous.guidance === null, previous.guidance ?? undefined),
                      );
                  }}
                >
                  <option value="">Choose a version…</option>
                  {model.history
                    .filter((v) => v.revision !== model.profile.revision)
                    .map((v) => (
                      <option key={v.revision} value={v.revision}>
                        Revision {v.revision}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <h3>Align with this model</h3>
            <p>
              Runs up to 25 model turns using synthetic conversations and your preferences. Compares
              current guidance, no optional guidance, and a rewrite. Provider usage may incur
              charges; three runs per day. Nothing is applied automatically.
            </p>
            <p className="settings-meta">
              Screening path: {model.calibrationModality}. A real voice trial is still required.
            </p>
            <button
              className="btn-primary"
              disabled={busy || !model.canAlign || job?.status === 'running' || dirty}
              onClick={() =>
                void act(async () => {
                  const run = await request<{ id: string }>('/api/model-prompts/align', {
                    language,
                    mode,
                    profileKey: model.identity.key,
                    revision: model.profile.revision,
                    confirmCost: true,
                  });
                  setJob(await request<Job>(`/api/model-prompts/jobs/${run.id}`));
                })
              }
            >
              Align — use provider
            </button>
            {!model.canAlign && (
              <p>
                Alignment is unavailable for this transport or budget. Editing and reset remain
                available.
              </p>
            )}
          </>
        )}
        {job && (
          <section aria-label="Alignment results">
            <h3>Alignment: {job.status}</h3>
            <p>
              {job.report.completed} / {job.report.total} comparisons · {job.report.modality}
            </p>
            {job.status === 'running' && (
              <button
                className="btn-text"
                onClick={() =>
                  void act(async () => {
                    await request(`/api/model-prompts/jobs/${job.id}/cancel`, {});
                    setJob(await request<Job>(`/api/model-prompts/jobs/${job.id}`));
                  })
                }
              >
                Cancel alignment
              </button>
            )}
            {['failed', 'cancelled', 'interrupted'].includes(job.status) && (
              <p>
                The run did not complete. Your active prompt is unchanged; any completed trials
                remain below.
              </p>
            )}
            {job.report.result && (
              <>
                <p>{job.report.result.notice}</p>
                {job.report.result.candidates.map((candidate) => (
                  <details key={candidate.id}>
                    <summary>{candidate.id}</summary>
                    <pre className="settings-preview">
                      {candidate.guidance || '(Optional guidance removed)'}
                    </pre>
                    {job.report
                      .result!.trials.filter((t) => t.variant === candidate.id)
                      .map((t) => (
                        <div key={`${t.split}-${t.repeat}`} className="settings-trial">
                          <strong>
                            {t.split} · repeat {t.repeat + 1}
                          </strong>
                          {t.exchanges.map((ex, i) => (
                            <div key={i}>
                              <p>
                                <b>Learner:</b> {ex.input}
                              </p>
                              <p>
                                <b>Tutor:</b> {ex.text}
                              </p>
                              <p className="settings-meta">
                                First output:{' '}
                                {ex.firstOutputMs === null
                                  ? 'unavailable'
                                  : `${ex.firstOutputMs} ms`}{' '}
                                · total {ex.durationMs} ms ·{' '}
                                {ex.audioBytes ? 'audio generated' : 'text only'}
                              </p>
                            </div>
                          ))}
                          {t.flags.map((f) => (
                            <p key={f} role="note">
                              {f}
                            </p>
                          ))}
                        </div>
                      ))}
                    {job.status === 'review' && (
                      <button
                        className="btn-primary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await request(`/api/model-prompts/jobs/${job.id}/apply`, {
                              candidate: candidate.id,
                              reviewed: true,
                            });
                            await loadModel();
                            setNotice(
                              'Reviewed candidate saved. Try it in your next voice session; revert here if it feels worse.',
                            );
                          })
                        }
                      >
                        Reviewed — try {candidate.id} next session
                      </button>
                    )}
                  </details>
                ))}
              </>
            )}
          </section>
        )}
      </details>
      <details
        className="settings-card"
        onToggle={(e) => {
          if (e.currentTarget.open && !archiveLoaded) void act(() => loadArchive());
        }}
      >
        <summary>
          <h2>Saved conversations</h2>
          <span>Inspect / export original turns</span>
        </summary>
        <p>
          Available from the archive release onward. Learner and tutor text are retained separately,
          including marked revisions and rejected input. No raw audio is saved here. These
          transcripts are evidence, not verified mastery.
        </p>
        {archiveLoaded && sessions.length === 0 && (
          <p>No saved conversations yet. Earlier sessions may not have recoverable transcripts.</p>
        )}
        <div className="settings-actions">
          {sessions.map((s) => (
            <button
              className="btn-text"
              key={s.sessionId}
              disabled={busy}
              onClick={() => void act(() => loadEvents(s.sessionId))}
            >
              {new Date(s.startedAt).toLocaleString()} · {s.languages.join(', ')} · {s.eventCount}{' '}
              events
            </button>
          ))}
        </div>
        {sessionsNext && (
          <button
            className="btn-text"
            disabled={busy}
            onClick={() => void act(() => loadArchive(sessionsNext))}
          >
            Older conversations
          </button>
        )}
        {selectedSession && (
          <>
            <button className="btn-primary" disabled={busy} onClick={() => void act(exportSession)}>
              Export complete session JSON
            </button>
            <button
              className="btn-text"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Delete this saved transcript? This cannot be undone. Existing learning assessments are separate and will not be regraded or deleted.',
                  )
                )
                  void act(async () => {
                    await request(
                      `/api/conversations/${encodeURIComponent(selectedSession)}`,
                      { confirm: true },
                      'DELETE',
                    );
                    setSelectedSession('');
                    setEvents([]);
                    await loadArchive();
                    setNotice(
                      'Transcript deleted; delayed archive retries cannot restore it. Existing learning assessments are unchanged.',
                    );
                  });
              }}
            >
              Delete saved transcript
            </button>
            <div className="settings-transcript">
              {events.map((e) => (
                <article key={e.payload.id}>
                  <strong>{e.payload.role === 'learner' ? 'You' : 'Tutor'}</strong>{' '}
                  <span className="settings-meta">
                    {new Date(e.payload.occurredAt).toLocaleTimeString()} · {e.payload.status}
                    {e.payload.interrupted ? ' · interrupted' : ''}
                  </span>
                  <p>{e.payload.text}</p>
                  {e.payload.reason && <p className="settings-meta">{e.payload.reason}</p>}
                </article>
              ))}
            </div>
            {eventNext && (
              <button
                className="btn-text"
                disabled={busy}
                onClick={() => void act(() => loadEvents(selectedSession, eventNext))}
              >
                More events
              </button>
            )}
          </>
        )}
      </details>
    </section>
  );
}
