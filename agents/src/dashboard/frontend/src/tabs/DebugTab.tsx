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
  updatedAt?: number;
}

function ago(ts?: number | null): string {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
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
      <RuntimePanel />
      <AgentFlow />
    </div>
  );
}
