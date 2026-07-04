/**
 * VoiceTab — the Voice tab screen (Task 4b).
 *
 * This is a reskin + hook-extraction pass on top of VoiceRoom.tsx's
 * already-working connection logic — NOT a connection-logic change:
 *   - Same `POST /api/token` fetch, same `LiveKitRoom`/`useVoiceAssistant()`
 *     wiring as VoiceRoom.tsx uses today.
 *   - Same always-on mic toggle behavior as VoiceRoom.tsx's `CallControls`
 *     (extracted near-verbatim below as `BottomControls`) — the PTT/
 *     hands-free redesign is deliberately deferred to Task 5.
 *   - Conversation data comes from the NEW `useConversationStream` hook
 *     (Task 4a), not the old buggy copy that still lives inside
 *     VoiceRoom.tsx.
 *
 * New in this task: the chat-style transcript re-skin (tutor avatar
 * bubbles, user audio-waveform-bubble morphing in place into a
 * tappable-colored-word text bubble via `lib/wordChips.ts`, 3-dot typing
 * indicator), plus the TopBar pills (language/curriculum/streak) and the
 * goal chip.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LiveKitRoom,
  useVoiceAssistant,
  useRoomContext,
  RoomAudioRenderer,
  ConnectionStateToast,
} from '@livekit/components-react';
import '@livekit/components-styles';
import TopBar from '../components/TopBar';
import { useAppState } from '../state/AppState';
import { useConversationStream, type ConversationTurn, type UserTurn, type AgentTurn } from '../hooks/useConversationStream';
import { getChipClass, isNeutralChip, resolveWordId } from '../lib/wordChips';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';

interface VoiceTabProps {
  userId: string;
  targetLang: string;
}

interface CurriculumUnit {
  id: string;
  title: string;
  language: string;
  order: number;
}

interface ActiveGoal {
  id: number;
  type: string;
  targetId: string;
  status: string;
  pattern?: string | null;
  grammarContext?: string | null;
}

interface UserSummary {
  streak: number;
  talkTimeHours: number;
  wordsDue: number;
}

// ─── Token fetch (unchanged from VoiceRoom.tsx) ───
//
// 2026-06-25: server picks the room based on the authenticated user, so we
// don't send roomName from the client any more. The response includes the
// room name for logging/debugging.
async function fetchToken(): Promise<{ token: string; url: string; roomName: string }> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Token error: ${(await res.json()).error}`);
  return res.json();
}

/**
 * Best-effort human label for an active goal. `/api/users/:userId`'s
 * `goals[]` (activeGoals rows) only carries `type`/`targetId`/`pattern`/
 * `grammarContext` — no pre-resolved lemma/translation text (that
 * resolution happens server-side in lib/context.ts's planner-prompt
 * builder via a lexeme join, which this endpoint doesn't do). Rather than
 * add a new endpoint/join (out of scope here), this renders a reasonable
 * label from the fields already present; if Task 3's summary/goal data
 * grows a proper display string later, swap it in here.
 */
function goalLabel(goal: ActiveGoal): string {
  if (goal.type === 'remediation') {
    return goal.pattern ? `Fix: ${goal.pattern}` : 'Fix recurring error';
  }
  if (goal.type === 'grammar') {
    return goal.grammarContext ? `Grammar: ${goal.grammarContext}` : 'Practice grammar';
  }
  return 'Learn new words';
}

function LanguagePill({ lang, onClick }: { lang: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="voice-pill voice-pill-lang"
      onClick={onClick}
      title={LANGUAGE_NAMES[lang] ?? lang}
    >
      <span className="voice-pill-dot" />
      <span className="mono">{lang.toUpperCase()}</span>
    </button>
  );
}

function CurriculumPill({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button type="button" className="voice-pill voice-pill-curriculum" onClick={onClick}>
      {title || 'Curriculum'}
    </button>
  );
}

function StreakChip({ streak }: { streak: number | null }) {
  return (
    <span className="voice-pill voice-pill-streak" title="Day streak">
      🔥 {streak === null ? '—' : streak}
    </span>
  );
}

function GoalChip({ text, wordsDue }: { text: string; wordsDue: number | null }) {
  return (
    <div className="voice-goal-chip">
      Goal: {text} · {wordsDue === null ? '0' : wordsDue} words due
    </div>
  );
}

function TutorAvatar() {
  return <div className="voice-avatar">Т</div>;
}

function TypingIndicator() {
  return (
    <div className="voice-bubble-row voice-bubble-row-agent">
      <TutorAvatar />
      <div className="voice-typing-dots" aria-label="Tutor is replying">
        <span style={{ animationDelay: '0ms' }} />
        <span style={{ animationDelay: '150ms' }} />
        <span style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  );
}

function AgentBubble({ turn }: { turn: AgentTurn }) {
  return (
    <div className="voice-bubble-row voice-bubble-row-agent">
      <TutorAvatar />
      <div className="voice-bubble voice-bubble-agent">{turn.text}</div>
    </div>
  );
}

/**
 * Deterministic pseudo-random bar heights for the pending-transcription
 * waveform bubble, keyed on the turn id so a re-render doesn't jitter the
 * bars. Not real audio waveform data (that isn't exposed to the frontend
 * anywhere in this pipeline) — a stand-in visual while the transcript is
 * "in flight", matching the brief's "bars of varying height" spec.
 */
function barHeights(seed: string, count: number): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    out.push(0.25 + (h % 1000) / 1000 * 0.75); // 0.25..1.0
  }
  return out;
}

/** Live "how long has this been transcribing" clock, ticking only while
 *  the turn is still pending analysis. Not a recorded-audio-duration value
 *  (no such field is available from useConversationStream) — an elapsed-
 *  since-transcript-arrived proxy, formatted mm:ss. */
function useElapsed(sinceTs: number, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  const secs = Math.max(0, Math.floor((now - sinceTs) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function UserBubble({
  turn,
  onWordTap,
}: {
  turn: UserTurn;
  onWordTap: (wordId: string) => void;
}) {
  const bars = useMemo(() => barHeights(turn.id, 24), [turn.id]);
  const elapsed = useElapsed(turn.ts, !turn.hasAnalysis);

  if (!turn.hasAnalysis) {
    // Pending: audio-waveform bubble with shimmer + duration + caption.
    // Same list position/id as the eventual text bubble below — this is
    // what makes the later swap a morph-in-place, not a new bubble.
    return (
      <div className="voice-bubble-row voice-bubble-row-user">
        <div className="voice-bubble voice-bubble-user voice-bubble-waveform">
          <div className="voice-waveform">
            {bars.map((h, i) => (
              <span
                key={i}
                className="voice-waveform-bar"
                style={{ height: `${Math.round(h * 22)}px`, animationDelay: `${i * 40}ms` }}
              />
            ))}
          </div>
          <span className="mono voice-waveform-duration">{elapsed}</span>
        </div>
        <div className="voice-bubble-caption">transcribing…</div>
      </div>
    );
  }

  // Resolved: same position, now rendered as a tappable colored-word bubble.
  return (
    <div className="voice-bubble-row voice-bubble-row-user">
      <div className="voice-bubble voice-bubble-user">
        {turn.lexemes.length > 0 ? (
          turn.lexemes.map((lex, i) => {
            const chipClass = getChipClass(lex, turn.srsUpdates);
            const neutral = isNeutralChip(chipClass);
            return (
              <span
                key={i}
                className={`voice-word ${chipClass}${neutral ? '' : ' voice-word-tappable'}`}
                onClick={neutral ? undefined : () => onWordTap(resolveWordId(lex, turn.srsUpdates))}
              >
                {lex.form}{' '}
              </span>
            );
          })
        ) : (
          <span>{turn.text}</span>
        )}
      </div>
    </div>
  );
}

function Transcript({ turns, onWordTap }: { turns: ConversationTurn[]; onWordTap: (wordId: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const last = turns[turns.length - 1];
  // "Tutor is about to reply" proxy: the most recent turn is a user turn
  // with no agent turn started for it yet (useConversationStream doesn't
  // expose a separate "waiting" flag — see its exported shape — so this is
  // derived from the turn list itself, same source the rest of this
  // component reads).
  const showTyping = last?.kind === 'user';

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length, showTyping]);

  return (
    <div className="voice-transcript" ref={scrollRef}>
      {turns.length === 0 && !showTyping && (
        <div className="voice-transcript-empty">Connect and start talking — your conversation appears here.</div>
      )}
      {turns.map((turn) =>
        turn.kind === 'agent' ? (
          <AgentBubble key={turn.id} turn={turn} />
        ) : (
          <UserBubble key={turn.id} turn={turn} onWordTap={onWordTap} />
        ),
      )}
      {showTyping && <TypingIndicator />}
    </div>
  );
}

// ─── Bottom controls: existing always-on mic toggle, extracted as-is from
// VoiceRoom.tsx's CallControls (Task 5 owns the PTT/hands-free redesign) ───

function BottomControls({ onDisconnect }: { onDisconnect: () => void }) {
  const room = useRoomContext();
  const [micOn, setMicOn] = useState(true);

  const toggleMic = async () => {
    const next = !micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
  };

  return (
    <div className="voice-controls">
      <button type="button" className={`btn-toggle ${micOn ? 'active' : ''}`} onClick={toggleMic}>
        {micOn ? '🎙 On' : '🔇 Off'}
      </button>
      <button type="button" className="btn-danger" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}

export default function VoiceTab({ userId, targetLang }: VoiceTabProps) {
  const { openSheet } = useAppState();
  const { turns } = useConversationStream();

  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [unitTitle, setUnitTitle] = useState('');
  const [summary, setSummary] = useState<UserSummary | null>(null);
  const [goals, setGoals] = useState<ActiveGoal[]>([]);

  // Curriculum pill — existing /api/curriculum endpoint; Task 3's
  // "current unit" concept isn't wired up yet, so this picks the
  // lowest-`order` unit for the user's target language as a stand-in.
  useEffect(() => {
    if (!targetLang) return;
    (async () => {
      try {
        const res = await fetch(`/api/curriculum?language=${targetLang}`);
        if (!res.ok) return;
        const units: CurriculumUnit[] = await res.json();
        if (units.length > 0) {
          const first = units.slice().sort((a, b) => a.order - b.order)[0];
          setUnitTitle(first.title);
        }
      } catch { /* non-fatal */ }
    })();
  }, [targetLang]);

  // Streak chip + word-due-count — Task 3's summary endpoint.
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const res = await fetch(`/api/users/${userId}/summary`);
        if (!res.ok) return;
        setSummary(await res.json());
      } catch { /* non-fatal */ }
    })();
  }, [userId]);

  // Goal chip text — existing /api/users/:userId response's goals[].
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const res = await fetch(`/api/users/${userId}`);
        if (!res.ok) return;
        const data = await res.json();
        setGoals((data.goals ?? []).filter((g: ActiveGoal) => g.status === 'active'));
      } catch { /* non-fatal */ }
    })();
  }, [userId]);

  const connect = async () => {
    setError(null);
    try {
      const { token: t, url: u, roomName: rn } = await fetchToken();
      setToken(t);
      setUrl(u);
      console.log(`[VoiceTab] Connecting to room: ${rn}`);
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

  const primaryGoal = goals[0];
  const goalText = primaryGoal ? goalLabel(primaryGoal) : 'Keep talking';

  const handleWordTap = (wordId: string) => openSheet({ kind: 'wordDetail', wordId });

  return (
    <div className="voice-tab">
      <TopBar
        left={<LanguagePill lang={targetLang} onClick={() => openSheet({ kind: 'language' })} />}
        center={<CurriculumPill title={unitTitle} onClick={() => openSheet({ kind: 'curriculum' })} />}
        right={<StreakChip streak={summary?.streak ?? null} />}
      />
      <GoalChip text={goalText} wordsDue={summary?.wordsDue ?? null} />

      <Transcript turns={turns} onWordTap={handleWordTap} />

      {!connected ? (
        <div className="voice-controls">
          <button type="button" className="btn-primary" onClick={connect}>
            Connect
          </button>
          {error && <div className="error-msg">{error}</div>}
        </div>
      ) : (
        <LiveKitRoom token={token} serverUrl={url} connect={true} audio={true} onDisconnected={disconnect}>
          <RoomAudioRenderer />
          <ConnectionStateToast />
          <VoiceAssistantKeepAlive />
          <BottomControls onDisconnect={disconnect} />
        </LiveKitRoom>
      )}
    </div>
  );
}

/**
 * useVoiceAssistant() must be called from inside <LiveKitRoom>. This task
 * doesn't render the old BarVisualizer panel (that debug-style visualizer
 * doesn't fit the chat-first reskin — the typing indicator now covers "is
 * the tutor about to reply"), but we still invoke the hook to preserve the
 * exact same `@livekit/components-react` wiring the brief asks to keep
 * (VoiceRoom.tsx's AgentVisualizer called it the same way).
 */
function VoiceAssistantKeepAlive() {
  useVoiceAssistant();
  return null;
}
