import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types for Agent Flow ───

interface FlowTurn {
  id: string;
  ts: number;
  // User input
  userInput?: string;
  // Conversational agent
  agentReply?: string;
  /** Live-streaming partial reply, populated token-by-token via llm.token events. */
  agentReplyStreaming?: string;
  agentState?: string;
  // Processor
  processorLexemes?: any[];
  processorSrsUpdates?: any[];
  processorTriggers?: any[];
  processorRawPrompt?: string;
  processorRawResponse?: string;
  // Supervisor
  supervisorTrigger?: any;
  // Planner
  plannerNudge?: string;
  plannerReason?: string;
  plannerRawResponse?: string;
  // Instructions
  instructionsRefreshed?: boolean;
}

// ─── Agent Flow Tracker: groups SSE events by utterance turn ───

// Streaming render throttle. Token deltas arrive one at a time; calling
// setState for each one overwhelms React. We coalesce them into ~50ms
// batches: each token marks the turn dirty, and a single setTurns fires
// when the throttle timer elapses.
function useAgentFlow() {
  const [turns, setTurns] = useState<FlowTurn[]>([]);
  const currentTurnRef = useRef<FlowTurn | null>(null);
  const streamingDirtyRef = useRef<boolean>(false);
  const streamingRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Throttled streaming render: mark dirty, schedule a 50ms render.
    const scheduleStreamingRender = () => {
      streamingDirtyRef.current = true;
      if (streamingRenderTimerRef.current) return;
      streamingRenderTimerRef.current = setTimeout(() => {
        streamingRenderTimerRef.current = null;
        if (!streamingDirtyRef.current) return;
        streamingDirtyRef.current = false;
        // Clone the current turn into the turns list so React re-renders.
        setTurns((prev) => {
          const cur = currentTurnRef.current;
          if (!cur) return prev;
          const idx = prev.findIndex((t) => t.id === cur.id);
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = { ...cur };
            return next;
          }
          return [...prev, { ...cur }];
        });
      }, 50);
    };

    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        const { type, data } = evt;

        // Start a new turn on user.transcript
        if (type === 'user.transcript') {
          if (currentTurnRef.current) {
            setTurns((prev) => [...prev, currentTurnRef.current!]);
          }
          currentTurnRef.current = {
            id: crypto.randomUUID(),
            ts: evt.ts,
            userInput: data?.text || '',
          };
        }

        // Agent reply
        if (type === 'agent.reply' && currentTurnRef.current) {
          const text = (data?.text || '').replace(/^thought\n/i, '').trim();
          if (text) currentTurnRef.current.agentReply = text;
        }

        // LLM token stream — accumulate the partial reply token-by-token.
        // When the stream ends, copy the accumulated text into agentReply.
        // While streaming, the UI shows the partial text with a cursor.
        if (type === 'llm.token') {
          if (!currentTurnRef.current) {
            // No active turn — open one with just a streaming reply.
            currentTurnRef.current = {
              id: crypto.randomUUID(),
              ts: evt.ts,
            };
          }
          if (data?.isStart) {
            currentTurnRef.current.agentReplyStreaming = '';
          }
          if (data?.text) {
            currentTurnRef.current.agentReplyStreaming =
              (currentTurnRef.current.agentReplyStreaming || '') + data.text;
          }
          if (data?.isEnd) {
            const final = (currentTurnRef.current.agentReplyStreaming || '')
              .replace(/^thought\n/i, '')
              .trim();
            if (final) currentTurnRef.current.agentReply = final;
            currentTurnRef.current.agentReplyStreaming = undefined;
          }
          // Trigger a UI re-render every ~50ms while streaming so we don't
          // overwhelm React with 200+ setStates per response.
          scheduleStreamingRender();
        }

        // Agent state changes
        if (type === 'session.agent_state_changed' && currentTurnRef.current) {
          currentTurnRef.current.agentState = data?.detail;
        }

        // Processor analysis
        if (type === 'processor.analysis' && currentTurnRef.current) {
          currentTurnRef.current.processorLexemes = data?.lexemes || [];
          currentTurnRef.current.processorSrsUpdates = data?.srsUpdates || [];
          currentTurnRef.current.processorTriggers = data?.supervisorTriggers || [];
        }

        // Processor raw (prompt + response)
        if (type === 'processor.raw' && currentTurnRef.current) {
          currentTurnRef.current.processorRawPrompt = (data?.prompt || '').substring(0, 2000);
          currentTurnRef.current.processorRawResponse = (data?.response || '').substring(0, 2000);
        }

        // Supervisor trigger
        if (type === 'supervisor.trigger' && currentTurnRef.current) {
          currentTurnRef.current.supervisorTrigger = data;
        }

        // Planner nudge
        if (type === 'planner.nudge' && currentTurnRef.current) {
          currentTurnRef.current.plannerNudge = data?.nudge;
          currentTurnRef.current.plannerReason = data?.reason;
        }

        // Planner raw
        if (type === 'planner.raw' && currentTurnRef.current) {
          currentTurnRef.current.plannerRawResponse = (data?.response || '').substring(0, 1000);
        }

        // Instructions refresh
        if (type === 'instructions.refresh' && currentTurnRef.current) {
          currentTurnRef.current.instructionsRefreshed = true;
        }
      } catch {}
    };
    return () => es.close();
  }, []);

  // Flush the current turn periodically (in case it's still accumulating)
  useEffect(() => {
    const interval = setInterval(() => {
      if (currentTurnRef.current) {
        setTurns((prev) => {
          // Replace the last turn if it's the same id, or append
          const existing = prev.find((t) => t.id === currentTurnRef.current!.id);
          if (existing) {
            return prev.map((t) => t.id === currentTurnRef.current!.id ? { ...currentTurnRef.current! } : t);
          }
          return [...prev, currentTurnRef.current!];
        });
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const clear = useCallback(() => {
    setTurns([]);
    currentTurnRef.current = null;
  }, []);

  return { turns, clear };
}

// ─── Agent Node (single agent in the flow) ───

interface AgentNodeProps {
  icon: string;
  name: string;
  status: 'pending' | 'active' | 'done';
  children?: React.ReactNode;
  detail?: string;
}

function AgentNode({ icon, name, status, children, detail }: AgentNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = !!children;

  return (
    <div className={`flow-node flow-node-${status}`}>
      <div className="flow-node-header" onClick={() => hasContent && setExpanded(!expanded)}>
        <span className="flow-node-icon">{icon}</span>
        <span className="flow-node-name">{name}</span>
        <span className={`flow-node-status flow-status-${status}`}>
          {status === 'active' ? '●' : status === 'done' ? '✓' : '○'}
        </span>
        {hasContent && <span className="flow-expand">{expanded ? '▼' : '▶'}</span>}
      </div>
      {detail && <div className="flow-node-detail">{detail}</div>}
      {expanded && hasContent && (
        <div className="flow-node-body">{children}</div>
      )}
    </div>
  );
}

// ─── Flow Arrow ───

function FlowArrow({ label }: { label?: string }) {
  return (
    <div className="flow-arrow">
      {label && <span className="flow-arrow-label">{label}</span>}
      <span className="flow-arrow-line">↓</span>
    </div>
  );
}

// ─── Single Turn Flow ───

function TurnFlow({ turn, index }: { turn: FlowTurn; index: number }) {
  const hasProcessor = !!turn.processorLexemes?.length || !!turn.processorRawResponse;
  const hasPlanner = !!turn.plannerRawResponse || !!turn.plannerNudge;
  const hasTrigger = !!turn.supervisorTrigger;

  return (
    <div className="turn-flow">
      <div className="turn-header">
        <span className="turn-number">Turn {index + 1}</span>
        <span className="turn-time">{new Date(turn.ts).toLocaleTimeString()}</span>
      </div>

      <div className="flow-pipeline">
        {/* User Input */}
        <AgentNode
          icon="👤"
          name="User (audio)"
          status="done"
          detail={turn.userInput?.replace(/\[audio .*?\]/, m => m)}
        />

        <FlowArrow label="audio" />

        {/* Conversational Agent */}
        <AgentNode
          icon="🤖"
          name="Conversational Agent"
          status={turn.agentReply ? 'done' : (turn.agentReplyStreaming ? 'active' : 'active')}
          detail={
            turn.agentReplyStreaming
              ? `"${turn.agentReplyStreaming}${turn.agentReply ? '' : ' ▍'}"`
              : turn.agentReply
                ? `"${turn.agentReply.substring(0, 120)}${turn.agentReply.length > 120 ? '…' : ''}"`
                : 'thinking…'
          }
        />

        {/* Processor */}
        {(hasProcessor || turn.processorTriggers?.length) && (
          <>
            <FlowArrow label="parallel" />
            <AgentNode
              icon="📊"
              name="Processor"
              status={hasProcessor ? 'done' : 'active'}
              detail={
                turn.processorLexemes?.length
                  ? `${turn.processorLexemes.length} words analyzed, ${turn.processorSrsUpdates?.length || 0} SRS updates`
                  : 'analyzing…'
              }
            >
              {/* Lexeme chips */}
              {turn.processorLexemes && turn.processorLexemes.length > 0 && (
                <div className="flow-lexemes">
                  {turn.processorLexemes.map((lex, i) => (
                    <span key={i} className={`word-chip chip-${lex.performance}`}>
                      {lex.form}
                    </span>
                  ))}
                </div>
              )}
              {/* Raw prompt/response */}
              {turn.processorRawResponse && (
                <details className="flow-raw">
                  <summary>Raw LLM response</summary>
                  <pre className="flow-raw-content">{turn.processorRawResponse}</pre>
                </details>
              )}
            </AgentNode>
          </>
        )}

        {/* Supervisor Trigger */}
        {hasTrigger && (
          <>
            <FlowArrow label="trigger" />
            <AgentNode
              icon="⚡"
              name="Supervisor"
              status="done"
              detail={`${turn.supervisorTrigger.type}: ${turn.supervisorTrigger.value || turn.supervisorTrigger.reason || ''}`}
            />
          </>
        )}

        {/* Planner */}
        {hasPlanner && (
          <>
            <FlowArrow label="timer" />
            <AgentNode
              icon="📝"
              name="Planner"
              status={turn.plannerRawResponse ? 'done' : 'active'}
              detail={turn.plannerReason ? `reason: ${turn.plannerReason}` : undefined}
            >
              {turn.plannerNudge && (
                <div className="flow-nudge">
                  <strong>Nudge:</strong> {turn.plannerNudge}
                </div>
              )}
              {turn.plannerRawResponse && (
                <details className="flow-raw">
                  <summary>Raw LLM response</summary>
                  <pre className="flow-raw-content">{turn.plannerRawResponse}</pre>
                </details>
              )}
            </AgentNode>
          </>
        )}

        {/* Instructions refresh */}
        {turn.instructionsRefreshed && (
          <>
            <FlowArrow />
            <AgentNode
              icon="🔄"
              name="Instructions"
              status="done"
              detail="System prompt refreshed"
            />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main Agent Flow Panel ───

export default function AgentFlow() {
  const { turns, clear } = useAgentFlow();
  const [open, setOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, open]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Agent Flow <span className="log-count">{turns.length}</span></h2>
        <div>
          <button className="btn-text" onClick={clear}>Clear</button>
          <button className="btn-text" onClick={() => setOpen(!open)}>
            {open ? '▼' : '▶'}
          </button>
        </div>
      </div>
      {open && (
        <div className="flow-scroll" ref={scrollRef}>
          {turns.length === 0 && (
            <div className="empty-state">Connect and start talking. The pipeline flow will appear here…</div>
          )}
          {turns.map((turn, i) => (
            <TurnFlow key={turn.id} turn={turn} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
