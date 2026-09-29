/**
 * DebugTab — admin-only trace view: what every agent is thinking, and
 * exactly what text each model was handed.
 *
 * 2026-08-04: the data for this already existed and was already being
 * written — `AgentFlow` (live SSE, per-utterance pipeline) and
 * `runtime_state.json` (planner/processor raw prompts + responses, session
 * trace, subagent chats, served by GET /api/runtime). What was missing was
 * a way to *reach* it: AgentFlow was only ever mounted inside
 * `VoiceRoom.tsx`, which the tabbed-shell reskin orphaned — App.tsx renders
 * AppShell now, so nothing has rendered AgentFlow since. This tab puts both
 * sources back on screen in one place.
 *
 * Two panels, because they answer different questions:
 *   - Live pipeline (AgentFlow): what happened on THIS turn, streaming.
 *   - Runtime state: the current standing state — the exact prompt strings
 *     handed to the planner and processor, the active nudge, and the raw
 *     session trace. This is the one that answers "what did the model
 *     actually see", which streaming events can't show in full.
 *
 * Access: `/api/runtime` is server-side gated to the admin user, so a
 * non-admin who forces this tab open gets an empty panel rather than
 * another user's session. The tab is hidden in TabBar for everyone else.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import AgentFlow from '../AgentFlow';

const RUNTIME_POLL_MS = 3_000;

interface RuntimeState {
  userId?: string;
  targetLang?: string;
  lastPlanAt?: number;
  pendingSignals?: string[];
  supervisorNudge?: string;
  lastProcessorRun?: { at?: number; rawPrompt?: string; rawResponse?: string } | null;
  lastPlannerRun?: { at?: number; reason?: string; rawPrompt?: string; rawResponse?: string } | null;
  subagentChats?: Array<{ role: string; timestamp: number; prompt: string; response: string }>;
  sessionTrace?: Array<{ at: number; event: string; detail?: string }>;
  // ISO string at runtime (see ago()); typed loosely to match the writer.
  updatedAt?: number | string;
}

interface BenchmarkModel {
  model: string;
  label: string;
  sourceFile: string;
  promptVersion: string;
  fixtureCount: number;
  certified: boolean;
  limitation: string;
  metrics: {
    exactMatchRate: number;
    exactMatches: number;
    falseRecallCredits: number;
    falseFailures: number;
    missedRecall: number;
    rejectedOrErrors: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  };
}

interface BenchmarkResponse {
  ok: boolean;
  error?: string;
  configuredModel?: string | null;
  configuredModelSource?: string;
  configuredModelBenchmarked?: boolean;
  configuredModelResult?: BenchmarkModel | null;
  report?: {
    benchmarkId: string;
    generatedAt: string;
    purpose: string;
    selectionPolicy?: { qualityWinner?: string; latencyAwareAlternative?: string; policyNote?: string };
    models: BenchmarkModel[];
  };
}

function ago(ts?: number | string | null): string {
  if (!ts) return '—';
  // updatedAt arrives as an ISO string (JSON.stringify(new Date()) in
  // tutor-event-driven.ts); epoch-ms numbers arrive as numbers. Coerce both.
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Collapsible block for a long raw prompt/response string. */
function RawBlock({ label, text }: { label: string; text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const chars = text.length;
  // Rough token estimate — enough to spot a prompt that has quietly
  // doubled in size, which is the main reason to look at this at all.
  const approxTokens = Math.round(chars / 4);
  return (
    <div className="dbg-raw">
      <button className="dbg-raw-toggle" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▼' : '▶'} {label}</span>
        <span className="dbg-meta">{chars.toLocaleString()} chars · ~{approxTokens.toLocaleString()} tok</span>
      </button>
      {open && <pre className="dbg-pre">{text}</pre>}
    </div>
  );
}

function BenchmarkPanel() {
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/processor-benchmark')
      .then(async (res) => {
        const body = await res.json() as BenchmarkResponse;
        if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!cancelled) setData(body);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);

  const models = data?.report?.models ?? [];
  return (
    <div className="dbg-panel dbg-benchmark-panel">
      <div className="dbg-panel-header">
        <h2>Processor capability test <span className="dbg-meta">· evidence-v2</span></h2>
        <button className="dbg-btn" onClick={() => setOpen((v) => !v)}>{open ? '▼' : '▶'}</button>
      </div>
      {open && (
        <div className="dbg-body">
          {error && <div className="dbg-empty">Benchmark unavailable: {error}</div>}
          {!error && !data && <div className="dbg-empty">Loading benchmark…</div>}
          {data && (
            <>
              <div className="dbg-benchmark-current">
                <div>
                  <span className="dbg-k">active processor</span>{' '}
                  <strong>{data.configuredModel || 'not reported'}</strong>{' '}
                  <span className="dbg-meta">({data.configuredModelSource || 'runtime'})</span>
                </div>
                <div className={data.configuredModelBenchmarked ? 'dbg-benchmark-match' : 'dbg-benchmark-unmatched'}>
                  {data.configuredModelBenchmarked ? '✓ benchmarked below' : '○ not in this fixture set'}
                </div>
              </div>
              <div className="dbg-benchmark-note">
                {data.report?.purpose} Results are diagnostic, not a certification or a claim about mastery.
              </div>
              <div className="dbg-benchmark-grid">
                {models.map((model) => (
                  <div className={`dbg-benchmark-card${model.model === data.configuredModelResult?.model ? ' is-active' : ''}`} key={model.model}>
                    <div className="dbg-benchmark-model">{model.label}</div>
                    <div className="dbg-meta dbg-benchmark-id">{model.model}</div>
                    <div className="dbg-benchmark-stat"><strong>{Math.round(model.metrics.exactMatchRate * 100)}%</strong> exact fixture match</div>
                    <div className="dbg-benchmark-stats">
                      <span>missed recall <b>{model.metrics.missedRecall}</b></span>
                      <span>errors <b>{model.metrics.rejectedOrErrors}</b></span>
                      <span>p50 <b>{model.metrics.latencyP50Ms}ms</b></span>
                      <span>p95 <b>{model.metrics.latencyP95Ms}ms</b></span>
                    </div>
                    {model.model === data.report?.selectionPolicy?.qualityWinner && <span className="dbg-benchmark-badge">quality winner</span>}
                    {model.model === data.report?.selectionPolicy?.latencyAwareAlternative && <span className="dbg-benchmark-badge is-muted">latency alternative</span>}
                  </div>
                ))}
              </div>
              <div className="dbg-meta">{data.report?.generatedAt} · 36 synthetic cases · prompt {models[0]?.promptVersion ?? '—'}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RuntimePanel() {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/runtime');
      if (res.status === 403) {
        setError('Admin only.');
        return;
      }
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || 'No runtime state yet.');
        return;
      }
      setError(null);
      setState(data.state as RuntimeState);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, RUNTIME_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="dbg-panel">
      <div className="dbg-panel-header">
        <h2>
          Runtime state
          {state?.updatedAt ? <span className="dbg-meta"> · {ago(state.updatedAt)}</span> : null}
        </h2>
        <button className="dbg-btn" onClick={() => setOpen((v) => !v)}>{open ? '▼' : '▶'}</button>
      </div>

      {open && (
        <div className="dbg-body">
          {error && <div className="dbg-empty">{error}</div>}
          {!error && !state && <div className="dbg-empty">Loading…</div>}

          {state && (
            <>
              <div className="dbg-kv">
                <div><span className="dbg-k">user</span><span>{state.userId ?? '—'}</span></div>
                <div><span className="dbg-k">lang</span><span>{state.targetLang ?? '—'}</span></div>
                <div><span className="dbg-k">last plan</span><span>{ago(state.lastPlanAt)}</span></div>
                <div><span className="dbg-k">signals</span><span>{state.pendingSignals?.length ? state.pendingSignals.join(', ') : 'none'}</span></div>
              </div>

              {state.supervisorNudge && (
                <div className="dbg-section">
                  <div className="dbg-section-title">Active nudge (what steers the tutor right now)</div>
                  <div className="dbg-quote">{state.supervisorNudge}</div>
                </div>
              )}

              <div className="dbg-section">
                <div className="dbg-section-title">
                  Planner {state.lastPlannerRun?.reason ? `· ${state.lastPlannerRun.reason}` : ''}
                  <span className="dbg-meta"> {ago(state.lastPlannerRun?.at)}</span>
                </div>
                {!state.lastPlannerRun && <div className="dbg-empty">Has not run yet.</div>}
                <RawBlock label="prompt sent to planner" text={state.lastPlannerRun?.rawPrompt} />
                <RawBlock label="planner response" text={state.lastPlannerRun?.rawResponse} />
              </div>

              <div className="dbg-section">
                <div className="dbg-section-title">
                  Processor<span className="dbg-meta"> {ago(state.lastProcessorRun?.at)}</span>
                </div>
                {!state.lastProcessorRun && <div className="dbg-empty">Has not run yet.</div>}
                <RawBlock label="prompt sent to processor" text={state.lastProcessorRun?.rawPrompt} />
                <RawBlock label="processor response" text={state.lastProcessorRun?.rawResponse} />
              </div>

              {!!state.subagentChats?.length && (
                <div className="dbg-section">
                  <div className="dbg-section-title">Subagent chats ({state.subagentChats.length})</div>
                  {state.subagentChats.map((c, i) => (
                    <div key={i} className="dbg-sub">
                      <div className="dbg-sub-role">{c.role} <span className="dbg-meta">{ago(c.timestamp)}</span></div>
                      <RawBlock label="prompt" text={c.prompt} />
                      <RawBlock label="response" text={c.response} />
                    </div>
                  ))}
                </div>
              )}

              <div className="dbg-section">
                <div className="dbg-section-title">Session trace ({state.sessionTrace?.length ?? 0})</div>
                <div className="dbg-trace">
                  {(state.sessionTrace ?? []).slice().reverse().map((e, i) => (
                    <div key={i} className="dbg-trace-row">
                      <span className="dbg-trace-ev">{e.event}</span>
                      {e.detail && e.detail !== 'None' && <span className="dbg-trace-detail">{e.detail}</span>}
                    </div>
                  ))}
                  {!state.sessionTrace?.length && <div className="dbg-empty">No trace events.</div>}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function DebugTab() {
  return (
    <div className="debug-tab p-4 flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Debug</h2>
      <p className="dbg-sub-note">
        Live agent reasoning and the exact text handed to each model. Admin only.
      </p>
      <BenchmarkPanel />
      <RuntimePanel />
      <AgentFlow />
    </div>
  );
}
