import { useState, useRef, useEffect, useCallback } from 'react';
import {
  LiveKitRoom,
  BarVisualizer,
  useVoiceAssistant,
  useRoomContext,
  RoomAudioRenderer,
  ConnectionStateToast,
} from '@livekit/components-react';
import '@livekit/components-styles';
import './app.css';
import OnboardingGate from './OnboardingGate';

const LANGUAGE_NAMES: Record<string, string> = {
  ru: 'Russian', pt: 'Portuguese', es: 'Spanish', fr: 'French',
  de: 'German', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', it: 'Italian', nl: 'Dutch', en: 'English',
};

// ─── Types ───

interface LexemeChip {
  lemma: string;
  form: string;
  pos: string;
  performance:
    | 'correct' | 'correct_instant' | 'correct_struggled'
    | 'wrong_use' | 'recall_fail' | 'native_substitution'
    | 'correct_use' | 'scaffolded'; // legacy labels, still in old events
  grammarRule?: { rule: string; example: string };
  pronunciation?: { stress: string; notes?: string };
}

interface SrsUpdate {
  lexemeId: string;
  oldState: number;
  newState: number;
  grade: number;
}

interface ProcessorBubble {
  id: string;
  lexemes: LexemeChip[];
  srsUpdates: SrsUpdate[];
  ts: number;
}

interface AgentBubble {
  id: string;
  text: string;
  ts: number;
}

interface VocabWord {
  id: string;
  lemma: string;
  pos: string;
  language: string;
  translation: string;
  state: number;
  stateName: string;
  stability: number;
  reps: number;
  lapses: number;
  due: string;
  isMastered: boolean;
}

// ─── Performance → Color mapping ───

const perfColors: Record<string, { bg: string; text: string; label: string }> = {
  correct:          { bg: '#1a5334', text: '#4ade80', label: '✓ correct' },
  correct_instant:  { bg: '#1a5334', text: '#4ade80', label: '✓✓ fluent' },
  correct_struggled:{ bg: '#1a3a5a', text: '#60a5fa', label: '~ struggled' },
  correct_use:      { bg: '#1a5334', text: '#4ade80', label: '✓ correct' }, // legacy
  wrong_use:        { bg: '#5a1a1a', text: '#f87171', label: '✗ wrong' },
  recall_fail:      { bg: '#5a3a1a', text: '#fbbf24', label: '? forgot' },
  scaffolded:       { bg: '#1a3a5a', text: '#60a5fa', label: '↻ scaffolded' }, // legacy
  native_substitution: { bg: '#5a4a1a', text: '#facc15', label: '⚠ native' },
};

// SRS state colors for mastered vs new
function getChipClass(lex: LexemeChip, srsUpdates: SrsUpdate[]): string {
  const srs = srsUpdates.find(u => u.lexemeId.includes(lex.lemma) || u.lexemeId.includes(lex.form));
  const isNew = !srs || srs.newState <= 1;
  const isMastered = srs && srs.newState === 2 && srs.grade >= 3;

  if (lex.performance === 'correct' || lex.performance === 'correct_instant' || lex.performance === 'correct_use') {
    // Green for new words used correctly, grey for mastered
    return isMastered ? 'chip-mastered' : 'chip-correct';
  }
  if (lex.performance === 'correct_struggled') return 'chip-scaffolded'; // reuse blue "effortful" styling
  return `chip-${lex.performance}`;
}

// ─── Token fetch ───

// 2026-06-25: server picks the room based on the authenticated user, so
// we don't send roomName from the client any more. The response includes
// the room name for logging/debugging.
async function fetchToken(): Promise<{ token: string; url: string; roomName: string }> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Token error: ${(await res.json()).error}`);
  return res.json();
}

// ─── Agent Visualizer ───

function AgentVisualizer() {
  const { state, audioTrack } = useVoiceAssistant();

  const labels: Record<string, string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
    'pre-connect-buffering': 'Buffering…',
    initializing: 'Starting…',
    idle: 'Idle',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
    failed: 'Failed',
  };

  return (
    <div className="visualizer-wrap">
      <div className={`state-indicator state-${state}`}>
        <span className="state-dot" />
        {labels[state] || state}
      </div>
      <BarVisualizer
        state={state}
        trackRef={audioTrack}
        barCount={48}
        options={{ maxHeight: 100, minHeight: 5 }}
      />
      {!audioTrack && (
        <div className="visualizer-placeholder">
          {state === 'connecting' || state === 'initializing'
            ? 'Connecting to agent…'
            : 'Waiting for agent audio…'}
        </div>
      )}
    </div>
  );
}

// ─── Call Controls ───

function CallControls({ onDisconnect }: { onDisconnect: () => void }) {
  const room = useRoomContext();
  const [micOn, setMicOn] = useState(true);

  const toggleMic = async () => {
    const next = !micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
  };

  return (
    <div className="call-controls">
      <button
        className={`btn-toggle ${micOn ? 'active' : ''}`}
        onClick={toggleMic}
      >
        {micOn ? '🎙 On' : '🔇 Off'}
      </button>
      <button className="btn-danger" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}

// ─── Event Stream: processor.analysis + agent.reply ───

function useConversationStream() {
  const [processorBubbles, setProcessorBubbles] = useState<ProcessorBubble[]>([]);
  const [agentBubbles, setAgentBubbles] = useState<AgentBubble[]>([]);
  // Active bubble being streamed — gets a stable id while tokens arrive,
  // then is appended to agentBubbles on `isEnd` or replaced on `agent.reply`.
  const streamingRef = useRef<{ id: string; text: string; ts: number } | null>(null);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        const { type, data } = evt;

        if (type === 'processor.analysis' && data?.lexemes?.length > 0) {
          setProcessorBubbles((prev) => [...prev, {
            id: crypto.randomUUID(),
            lexemes: data.lexemes,
            srsUpdates: data.srsUpdates || [],
            ts: evt.ts,
          }]);
        } else if (type === 'llm.token') {
          // 2026-06-30: stream LLM tokens into the chat as they arrive,
          // BEFORE TTS finishes. The previous code waited for `agent.reply`
          // which fires after the full message is in the chat context —
          // by then TTS was already mid-sentence. Now we maintain a single
          // "streaming" bubble that grows with each delta.
          if (data?.isEnd) {
            // Finalize: append the accumulated bubble to the list.
            if (streamingRef.current && streamingRef.current.text.trim()) {
              const finalized = { ...streamingRef.current };
              setAgentBubbles((prev) => {
                // Replace the streaming placeholder (if it was ever pushed)
                const without = prev.filter((b) => b.id !== finalized.id);
                return [...without, finalized];
              });
            }
            streamingRef.current = null;
          } else if (data?.text) {
            if (!streamingRef.current) {
              streamingRef.current = { id: crypto.randomUUID(), text: '', ts: evt.ts };
            }
            streamingRef.current.text += data.text;
            // Throttle React updates to ~20fps while streaming.
            if (!renderTimerRef.current) {
              renderTimerRef.current = setTimeout(() => {
                renderTimerRef.current = null;
                // Bump a render by replacing the last bubble if it's ours,
                // otherwise append a new one.
                const current = streamingRef.current;
                if (!current) return;
                setAgentBubbles((prev) => {
                  const idx = prev.findIndex((b) => b.id === current.id);
                  const snap = { id: current.id, text: current.text, ts: current.ts };
                  if (idx >= 0) {
                    const copy = prev.slice();
                    copy[idx] = snap;
                    return copy;
                  }
                  return [...prev, snap];
                });
              }, 50);
            }
          }
        } else if (type === 'agent.reply' && data?.text) {
          // The orchestrator's late-arriving "official" reply. We already
          // streamed the same text via llm.token — just replace ours to
          // ensure any filter (e.g. leading "thought\n") is applied.
          const text = data.text.replace(/^thought\n/i, '').trim();
          if (text) {
            if (streamingRef.current) {
              streamingRef.current.text = text;
              setAgentBubbles((prev) => {
                const idx = prev.findIndex((b) => b.id === streamingRef.current!.id);
                if (idx >= 0) {
                  const copy = prev.slice();
                  copy[idx] = { id: streamingRef.current!.id, text, ts: streamingRef.current!.ts };
                  return copy;
                }
                return [...prev, { id: crypto.randomUUID(), text, ts: evt.ts }];
              });
            } else {
              setAgentBubbles((prev) => [...prev, {
                id: crypto.randomUUID(),
                text,
                ts: evt.ts,
              }]);
            }
          }
        }
      } catch {}
    };
    return () => {
      es.close();
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    };
  }, []);

  const clear = useCallback(() => {
    setProcessorBubbles([]);
    setAgentBubbles([]);
    streamingRef.current = null;
  }, []);

  return { processorBubbles, agentBubbles, clear };
}

// ─── Log Stream ───

function useLogStream() {
  const [logs, setLogs] = useState<{ text: string; ts: number }[]>([]);

  useEffect(() => {
    const es = new EventSource('/api/logs');
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data);
        setLogs((prev) => [...prev, {
          text: typeof line === 'string' ? line : JSON.stringify(line),
          ts: Date.now(),
        }].slice(-200));
      } catch {
        setLogs((prev) => [...prev, { text: e.data, ts: Date.now() }].slice(-200));
      }
    };
    return () => es.close();
  }, []);

  const clear = useCallback(() => setLogs([]), []);
  return { logs, clear };
}

// ─── Vocabulary Panel ───

function VocabularyPanel() {
  const [words, setWords] = useState<VocabWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('due');
  const [filterLang, setFilterLang] = useState('');
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchVocab = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort });
      if (filterLang) params.set('lang', filterLang);
      const res = await fetch(`/api/vocabulary?${params}`);
      if (res.ok) {
        const data = await res.json();
        setWords(data.words || []);
      }
    } catch {}
    setLoading(false);
  }, [sort, filterLang]);

  useEffect(() => {
    if (open) fetchVocab();
  }, [open, sort, filterLang, fetchVocab]);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [open, words]);

  const mastered = words.filter(w => w.isMastered).length;
  const learning = words.filter(w => !w.isMastered && w.state <= 1).length;
  const review = words.filter(w => w.state === 2 && !w.isMastered).length;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Vocabulary <span className="log-count">{words.length}</span></h2>
        <div>
          <button className="btn-text" onClick={() => setOpen(!open)}>
            {open ? '▼' : '▶'}
          </button>
        </div>
      </div>
      {open && (
        <div className="vocab-body">
          <div className="vocab-stats">
            <span className="vocab-stat mastered">✓ {mastered} mastered</span>
            <span className="vocab-stat learning">📖 {learning} learning</span>
            <span className="vocab-stat review">🔄 {review} review</span>
            <button className="btn-text" onClick={fetchVocab} disabled={loading}>
              {loading ? '...' : '↻'}
            </button>
          </div>
          <div className="vocab-filters">
            <select value={filterLang} onChange={e => setFilterLang(e.target.value)}>
              <option value="">All languages</option>
              <option value="ru">Russian</option>
              <option value="pt">Portuguese</option>
              <option value="es">Spanish</option>
              <option value="en">English</option>
            </select>
            <select value={sort} onChange={e => setSort(e.target.value)}>
              <option value="due">Due</option>
              <option value="stability">Stability</option>
              <option value="reps">Reviews</option>
              <option value="lapses">Lapses</option>
            </select>
          </div>
          <div className="vocab-scroll" ref={scrollRef}>
            {words.length === 0 && !loading && (
              <div className="empty-state">No words yet. Start talking!</div>
            )}
            {words.map((w) => (
              <div key={w.id} className={`vocab-word ${w.isMastered ? 'vw-mastered' : `vw-state-${w.state}`}`}>
                <div className="vw-lemma">{w.lemma}</div>
                <div className="vw-pos">{w.pos}</div>
                <div className="vw-translation">{w.translation}</div>
                <div className="vw-srs">
                  <span className="vw-state">{w.stateName}</span>
                  <span className="vw-reps">{w.reps} reps</span>
                  {w.lapses > 0 && <span className="vw-lapses">{w.lapses} lapses</span>}
                  <span className="vw-stability">S={w.stability.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Conversation View (color-coded bubbles) ───

function ConversationView({
  processorBubbles,
  agentBubbles,
  onClear,
}: {
  processorBubbles: ProcessorBubble[];
  agentBubbles: AgentBubble[];
  onClear: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Interleave processor and agent bubbles by timestamp
  const allBubbles: Array<{ type: 'user' | 'agent'; data: ProcessorBubble | AgentBubble; ts: number }> = [
    ...processorBubbles.map(b => ({ type: 'user' as const, data: b, ts: b.ts })),
    ...agentBubbles.map(b => ({ type: 'agent' as const, data: b, ts: b.ts })),
  ].sort((a, b) => a.ts - b.ts);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allBubbles.length]);

  return (
    <div className="panel conversation-panel">
      <div className="panel-header">
        <h2>Conversation</h2>
        <button className="btn-text" onClick={onClear}>Clear</button>
      </div>
      <div className="conversation-scroll" ref={scrollRef}>
        {allBubbles.length === 0 && (
          <div className="empty-state">Connect and start talking. Your words will appear here with color-coded feedback…</div>
        )}
        {allBubbles.map((bubble) => {
          if (bubble.type === 'agent') {
            const agent = bubble.data as AgentBubble;
            return (
              <div key={agent.id} className="bubble bubble-agent">
                <div className="bubble-speaker">🤖</div>
                <div className="bubble-content bubble-content-agent">{agent.text}</div>
              </div>
            );
          }
          const proc = bubble.data as ProcessorBubble;
          return (
            <div key={proc.id} className="bubble bubble-user">
              <div className="bubble-speaker">👤</div>
              <div className="bubble-content bubble-content-user">
                <div className="chip-row">
                  {proc.lexemes.map((lex, i) => (
                    <span
                      key={i}
                      className={`word-chip ${getChipClass(lex, proc.srsUpdates)}`}
                      title={lex.grammarRule ? `${lex.grammarRule.rule} — ${lex.grammarRule.example}` : perfColors[lex.performance]?.label}
                    >
                      {lex.form}
                    </span>
                  ))}
                </div>
                {proc.srsUpdates.length > 0 && (
                  <div className="srs-row">
                    {proc.srsUpdates.map((u, i) => (
                      <span key={i} className="srs-badge">
                        {['New', 'Learning', 'Review', 'Relearning'][u.newState]} · G{u.grade}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Log View ───

function LogView({ logs, onClear }: { logs: { text: string; ts: number }[]; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, open]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Logs <span className="log-count">{logs.length}</span></h2>
        <div>
          <button className="btn-text" onClick={onClear}>Clear</button>
          <button className="btn-text" onClick={() => setOpen(!open)}>
            {open ? '▼' : '▶'}
          </button>
        </div>
      </div>
      {open && (
        <div className="log-scroll" ref={scrollRef}>
          {logs.map((l, i) => (
            <div key={i} className="log-line">{l.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Legend ───

function ColorLegend() {
  return (
    <div className="legend">
      <span className="legend-item"><span className="word-chip chip-correct">word</span> Correct (new)</span>
      <span className="legend-item"><span className="word-chip chip-mastered">word</span> Mastered</span>
      <span className="legend-item"><span className="word-chip chip-wrong_use">word</span> Wrong usage</span>
      <span className="legend-item"><span className="word-chip chip-recall_fail">word</span> Forgot</span>
      <span className="legend-item"><span className="word-chip chip-scaffolded">word</span> Scaffolded</span>
      <span className="legend-item"><span className="word-chip chip-native_substitution">word</span> Native substitution</span>
    </div>
  );
}

// ─── Main Voice Room ───

export default function VoiceRoom({ onLogout }: { onLogout: () => void }) {
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Onboarding state
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [userId, setUserId] = useState('');
  const [targetLang, setTargetLang] = useState('ru');

  // Check onboarding on mount
  useEffect(() => {
    (async () => {
      try {
        const meRes = await fetch('/api/me');
        if (!meRes.ok) { setOnboardingChecked(true); return; }
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
      setOnboardingChecked(true);
    })();
  }, []);

  const { processorBubbles, agentBubbles, clear: clearConv } = useConversationStream();
  const { logs, clear: clearLogs } = useLogStream();

  const connect = async () => {
    setError(null);
    // 2026-06-25: server determines room name per-user (`linglang-<userId>`).
    try {
      const { token: t, url: u, roomName: rn } = await fetchToken();
      setToken(t);
      setUrl(u);
      console.log(`[VoiceRoom] Connecting to room: ${rn}`);
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnect = () => {
    setConnected(false);
    setToken('');
    setUrl('');
  };

  return (
    <div className="app-layout">
      <header className="app-header">
        <h1>⚡ LingLang</h1>
        <button className="btn-text" onClick={onLogout}>Logout</button>
      </header>

      {/* Onboarding gate — shown before the voice room if not yet complete */}
      {!onboardingChecked ? (
        <div className="loading-wrap">Loading…</div>
      ) : needsOnboarding ? (
        <OnboardingGate
          userId={userId}
          targetLanguage={targetLang}
          languageName={LANGUAGE_NAMES[targetLang] ?? targetLang}
          onComplete={() => setNeedsOnboarding(false)}
          onSkipToVoice={() => {
            // User wants to talk to the tutor — agent will run onboarding voice flow
            setNeedsOnboarding(false);
          }}
        />
      ) : (

      <div className="app-main">
        {/* Call Panel */}
        <div className="panel call-panel">
          {!connected ? (
            <div className="connect-screen">
              <div className="connect-icon">🎙️</div>
              <p>Start a voice session with your LingLang tutor</p>
              <button className="btn-primary btn-lg" onClick={connect}>
                Connect
              </button>
              {error && <div className="error-msg">{error}</div>}
            </div>
          ) : (
            <>
              <LiveKitRoom
                token={token}
                serverUrl={url}
                connect={true}
                audio={true}
                onDisconnected={disconnect}
              >
                <AgentVisualizer />
                <RoomAudioRenderer />
                <ConnectionStateToast />
                <CallControls onDisconnect={disconnect} />
              </LiveKitRoom>
            </>
          )}
        </div>

        {/* Color Legend */}
        <ColorLegend />

        {/* Conversation (color-coded bubbles) */}
        <ConversationView
          processorBubbles={processorBubbles}
          agentBubbles={agentBubbles}
          onClear={clearConv}
        />

        {/* Vocabulary */}
        <VocabularyPanel />

        {/* Agent Flow (per-utterance pipeline visualization) */}
        <AgentFlow />

        {/* Raw Logs */}
        <LogView logs={logs} onClear={clearLogs} />
      </div>
      )} {/* end onboarding ternary: ) closes third branch, } closes expression */}
    </div>
  );
}

// ─── Inline import to avoid circular deps ───
import AgentFlow from './AgentFlow';
