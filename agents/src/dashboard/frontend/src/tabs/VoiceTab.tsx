/**
 * VoiceTab — the Voice tab screen (Task 4b, PTT/hands-free control by
 * Task 5).
 *
 * This is a reskin + hook-extraction pass on top of VoiceRoom.tsx's
 * already-working connection logic — NOT a connection-logic change:
 *   - Same `POST /api/token` fetch, same `LiveKitRoom`/`useVoiceAssistant()`
 *     wiring as VoiceRoom.tsx uses today.
 *   - Bottom mic control is now `../components/VoiceControl` (Task 5):
 *     push-to-talk (mic muted between presses) / hands-free (mic
 *     continuously on, same behavior VoiceRoom.tsx's `CallControls` always
 *     had), switched by a local mode toggle — see VoiceControl.tsx for the
 *     full design and the pointer-event trace in task-5-report.md.
 *   - Conversation data comes from the NEW `useConversationStream` hook
 *     (Task 4a), not the old buggy copy that still lives inside
 *     VoiceRoom.tsx.
 *
 * New in Task 4b: the chat-style transcript re-skin (tutor avatar
 * bubbles, user audio-waveform-bubble morphing in place into a
 * tappable-colored-word text bubble via `lib/wordChips.ts`, 3-dot typing
 * indicator), plus the TopBar pills (language/curriculum/streak) and the
 * goal chip.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  ConnectionStateToast,
} from '@livekit/components-react';
import '@livekit/components-styles';
import TopBar from '../components/TopBar';
import VoiceControl, { type VoiceControlMode } from '../components/VoiceControl';
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
 *  since-transcript-arrived proxy, formatted mm:ss. This remains the
 *  fallback display in hands-free mode (no discrete recording duration
 *  exists there — see Task 5 brief item 5) and for any pending turn that
 *  a PTT hold duration wasn't attributed to. */
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

function formatHeldMs(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function UserBubble({
  turn,
  onWordTap,
  heldMs,
}: {
  turn: UserTurn;
  onWordTap: (wordId: string) => void;
  /** Real PTT-hold duration (ms) for this specific turn, when known (Task
   *  5) — see VoiceTab's `pttHoldByTurnId` wiring below. When present,
   *  this replaces the ticking elapsed-since-arrival proxy with the
   *  actual measured recording length, which is a strictly better number
   *  now that PTT mode makes it available; hands-free mode has no such
   *  signal (there's no interim STT event, per the brief), so it keeps
   *  the Task 4b ticking-proxy behavior unchanged. */
  heldMs?: number;
}) {
  const bars = useMemo(() => barHeights(turn.id, 24), [turn.id]);
  const ticking = useElapsed(turn.ts, !turn.hasAnalysis);
  const elapsed = heldMs !== undefined ? formatHeldMs(heldMs) : ticking;

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

function Transcript({
  turns,
  onWordTap,
  pttHoldForTurnId,
}: {
  turns: ConversationTurn[];
  onWordTap: (wordId: string) => void;
  /** { id, ms } of the one pending user turn a just-completed PTT hold's
   *  duration should be attributed to — see VoiceTab's `pttHoldFor` state. */
  pttHoldForTurnId?: { id: string; ms: number } | null;
}) {
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
          <UserBubble
            key={turn.id}
            turn={turn}
            onWordTap={onWordTap}
            heldMs={pttHoldForTurnId && pttHoldForTurnId.id === turn.id ? pttHoldForTurnId.ms : undefined}
          />
        ),
      )}
      {showTyping && <TypingIndicator />}
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

  // PTT / hands-free mode — local to this tab, not global AppState
  // (Task 5 brief item 4).
  const [voiceMode, setVoiceMode] = useState<VoiceControlMode>('ptt');

  // Task 5 item 5: attribute the just-measured PTT-hold duration to the
  // next pending user turn that appears, so its waveform bubble shows the
  // real recording length instead of the ticking since-arrival proxy.
  // `pendingHoldMsQueueRef` holds hold durations "waiting to be claimed" by
  // the next new pending turn(s), oldest first; `pttHoldFor` is the most
  // recently claimed { id, ms } pair actually handed to the
  // Transcript/UserBubble. This is a best-effort, order-based correlation
  // (no turnSeq round-trip exists for this client-only value) — sound for
  // the single-mic-at-a-time flow this app has, same class of heuristic as
  // useConversationStream's existing FIFO/arrival-order fallbacks.
  //
  // Review fix (task-5, Low/cosmetic finding): this used to be a single
  // `useRef<number | null>` slot, not a queue — if two PTT presses/releases
  // happened back-to-back before the first turn's STT round-trip produced
  // a pending turn to attach to, the second release's duration would
  // silently clobber the first's before either was claimed, so the FIRST
  // turn's waveform bubble could end up showing the SECOND press's
  // duration. A FIFO queue (push on release, shift on claim) fixes this
  // cheaply: each release gets its own slot and is claimed in the same
  // order presses happened, so no duration is ever overwritten before
  // being attached to a turn. (Only the single most-recently-claimed turn
  // is tracked in `pttHoldFor` at a time — once a later turn claims the
  // slot, an earlier still-pending turn falls back to the ticking-elapsed
  // proxy rather than showing a stale real duration. That's an accepted,
  // cosmetic-only limitation: once a turn resolves (`hasAnalysis`), its
  // duration display is irrelevant anyway, so this only matters for the
  // rare case of 3+ concurrently-pending turns, which was already an edge
  // case before this fix.)
  const pendingHoldMsQueueRef = useRef<number[]>([]);
  const [pttHoldFor, setPttHoldFor] = useState<{ id: string; ms: number } | null>(null);

  const handlePttRelease = (durationMs: number) => {
    pendingHoldMsQueueRef.current.push(durationMs);
  };

  useEffect(() => {
    if (pendingHoldMsQueueRef.current.length === 0) return;
    const last = turns[turns.length - 1];
    if (
      last &&
      last.kind === 'user' &&
      !last.hasAnalysis &&
      (!pttHoldFor || pttHoldFor.id !== last.id)
    ) {
      const ms = pendingHoldMsQueueRef.current.shift();
      if (ms !== undefined) setPttHoldFor({ id: last.id, ms });
    }
  }, [turns, pttHoldFor]);

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

      <Transcript turns={turns} onWordTap={handleWordTap} pttHoldForTurnId={pttHoldFor} />

      {!connected ? (
        <div className="voice-controls">
          <button type="button" className="btn-primary" onClick={connect}>
            Connect
          </button>
          {error && <div className="error-msg">{error}</div>}
        </div>
      ) : (
        // NOTE: deliberately no `audio` prop here (task-5 review fix). LiveKitRoom
        // independently listens for its own `SignalConnected` event and calls
        // `localParticipant.setMicrophoneEnabled(!!audioProp)` whenever the room
        // finishes connecting — completely independent of VoiceControl's own
        // mode-driven mic logic below. With `audio={true}` this silently
        // re-enabled the mic on every connect, defeating PTT's "starts muted"
        // guarantee. VoiceControl (via its `connectionState`-gated effect) is now
        // the SOLE authority over mic-enabled state; omitting `audio` here (or
        // passing `audio={false}`, the library default) means LiveKitRoom's own
        // listener applies `setMicrophoneEnabled(false)`, which is harmless in
        // PTT mode and gets superseded by VoiceControl's effect (which fires
        // later, once `useConnectionState` flips to `connected`) in hands-free
        // mode. See VoiceControl.tsx and task-5-report.md for the full trace.
        <LiveKitRoom token={token} serverUrl={url} connect={true} onDisconnected={disconnect}>
          <RoomAudioRenderer />
          <ConnectionStateToast />
          <VoiceControl
            mode={voiceMode}
            onModeChange={setVoiceMode}
            onDisconnect={disconnect}
            onPttRelease={handlePttRelease}
          />
        </LiveKitRoom>
      )}
    </div>
  );
}
