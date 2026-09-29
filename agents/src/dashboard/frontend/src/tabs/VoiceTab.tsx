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
import { Avatar, Button, Chip, Popover, ScrollShadow } from '@heroui/react';
import { ConnectionStateToast, LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react';
import '@livekit/components-styles';
import { AudioLines, Info, Mic } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from '../components/TopBar';
import { PipecatVoice } from '../components/PipecatVoice';
import VoiceControl, { type VoiceControlMode } from '../components/VoiceControl';
import {
  type AgentTurn,
  type ConversationTurn,
  type UserTurn,
  useConversationStream,
} from '../hooks/useConversationStream';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';
import { apiFetch } from '../lib/api';
import { requestMicrophone } from '../lib/microphone';
import { getChipClass, isNeutralChip, resolveWordId } from '../lib/wordChips';
import { type ServiceMode, useAppState } from '../state/AppState';

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
async function fetchToken(
  mode: ServiceMode,
): Promise<{ token: string; url: string; roomName: string; eventSessionId: string }> {
  const res = await apiFetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
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
    <Button
      variant="secondary"
      size="sm"
      className="rounded-full"
      onPress={onClick}
      aria-label={LANGUAGE_NAMES[lang] ?? lang}
    >
      <span className="voice-pill-dot" />
      <span className="mono">{lang.toUpperCase()}</span>
    </Button>
  );
}

function CurriculumPill({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="voice-curriculum-pill"
      onPress={onClick}
      aria-label={title || 'Curriculum'}
    >
      <span>{title || 'Curriculum'}</span>
    </Button>
  );
}

function StreakChip({ streak }: { streak: number | null }) {
  return (
    <Chip variant="soft" color="warning" title="Day streak">
      {streak === null || streak === 0 ? 'no streak yet' : `${streak}-day streak`}
    </Chip>
  );
}

function GoalChip({ text, wordsDue }: { text: string; wordsDue: number | null }) {
  // "435 words due" read like a debt; reframe as an invitation (and handle
  // the 0 case so it doesn't say "0 words due").
  const count = wordsDue ?? 0;
  const dueLabel =
    count === 0
      ? 'nothing to review — chat to learn new words'
      : `${count} word${count === 1 ? '' : 's'} ready to review`;
  return (
    <div className="voice-goal mb-2.5 flex justify-center">
      <Chip variant="soft" color="success">
        Goal: {text} · {dueLabel}
      </Chip>
    </div>
  );
}

/**
 * In-session mobile bar (2026-09-26).
 *
 * The user's complaint was that during a live conversation the transcript
 * "gets little space due banners/footer": on a 360x640 phone the eyebrow +
 * title, the pills row and the goal chip cost ~113px above the transcript
 * (measured: scripts/probe-voice-mobile.mjs). Shrinking their fonts (the
 * previous attempt) kept every band and its padding, so nothing was
 * actually reclaimed.
 *
 * So while connected on a phone those three bands are removed from the
 * layout entirely and replaced by this single 44px row, which keeps the
 * same CONTEXT reachable:
 *   - language pill → the language sheet (unchanged control),
 *   - curriculum → the curriculum sheet (unchanged control),
 *   - an info button → a popover with the streak, the active goal and the
 *     review count that the hidden pills/chip used to show.
 *
 * Every control here is >=44px tall. Hidden on desktop (the wide layout has
 * room for the full chrome) and pre-connect (the pills row is still there).
 */
function SessionBar({
  lang,
  unitTitle,
  streak,
  goalText,
  wordsDue,
  onLanguage,
  onCurriculum,
}: {
  lang: string;
  unitTitle: string;
  streak: number | null;
  goalText: string;
  wordsDue: number | null;
  onLanguage: () => void;
  onCurriculum: () => void;
}) {
  const language = LANGUAGE_NAMES[lang] ?? lang;
  const due = wordsDue ?? 0;
  const dueLabel =
    due === 0 ? 'Nothing to review yet' : `${due} word${due === 1 ? '' : 's'} ready to review`;
  const streakLabel =
    streak === null || streak === 0 ? 'No streak yet — talk today to start one' : `${streak}-day streak`;

  return (
    <div className="voice-session-bar">
      <Button
        variant="secondary"
        size="sm"
        className="voice-session-language rounded-full"
        onPress={onLanguage}
        aria-label={`Change language, currently ${language}`}
      >
        <span className="voice-pill-dot" />
        <span className="mono">{lang.toUpperCase()}</span>
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="voice-session-curriculum"
        onPress={onCurriculum}
        aria-label={`Curriculum: ${unitTitle || 'Curriculum'}`}
      >
        <span>{unitTitle || 'Curriculum'}</span>
      </Button>
      <Popover>
        <Popover.Trigger>
          <Button variant="ghost" size="sm" className="voice-session-info" aria-label="Session details">
            <Info size={18} aria-hidden="true" />
          </Button>
        </Popover.Trigger>
        <Popover.Content className="voice-session-context" placement="bottom end">
          <Popover.Dialog>
            <Popover.Heading>Session details</Popover.Heading>
            <dl className="voice-session-context-list">
              <div>
                <dt>Goal</dt>
                <dd>{goalText}</dd>
              </div>
              <div>
                <dt>Streak</dt>
                <dd>{streakLabel}</dd>
              </div>
              <div>
                <dt>Review</dt>
                <dd>{dueLabel}</dd>
              </div>
            </dl>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  );
}

function TutorAvatar() {
  return (
    <Avatar size="sm" className="voice-avatar">
      <Avatar.Fallback>Т</Avatar.Fallback>
    </Avatar>
  );
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
    out.push(0.25 + ((h % 1000) / 1000) * 0.75); // 0.25..1.0
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

function formatUserTextWithChips(
  turn: UserTurn,
  onWordTap: (wordId: string) => void,
): ReactElement {
  if (turn.lexemes.length === 0) return <span>{turn.text}</span>;

  const source = turn.text;
  const lower = source.toLocaleLowerCase();
  const parts: ReactElement[] = [];
  let cursor = 0;

  for (const [i, lex] of turn.lexemes.entries()) {
    const form = lex.form?.trim();
    if (!form) continue;
    const start = lower.indexOf(form.toLocaleLowerCase(), cursor);
    if (start < 0) continue;
    if (start > cursor) parts.push(<span key={`text-${i}`}>{source.slice(cursor, start)}</span>);
    const chipClass = getChipClass(lex, turn.srsUpdates);
    const neutral = isNeutralChip(chipClass);
    parts.push(
      <span
        key={`word-${i}`}
        className={`voice-word ${chipClass}${neutral ? '' : ' voice-word-tappable'}`}
        onClick={neutral ? undefined : () => onWordTap(resolveWordId(lex, turn.srsUpdates))}
      >
        {source.slice(start, start + form.length)}
      </span>,
    );
    cursor = start + form.length;
  }

  if (cursor < source.length) parts.push(<span key="text-tail">{source.slice(cursor)}</span>);
  return <>{parts.length > 0 ? parts : <span>{source}</span>}</>;
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

  if (turn.interim) {
    // Live partial (realtime/Gemini only): show the words as they land
    // instead of a waveform, so the learner sees themselves being
    // transcribed in real time. Replaced in place by the final bubble.
    return (
      <div className="voice-bubble-row voice-bubble-row-user">
        <div className="voice-bubble voice-bubble-user voice-bubble-interim">
          <span>{turn.text}</span>
          <span className="voice-interim-caret" aria-hidden="true" />
        </div>
        <div className="voice-bubble-caption">listening…</div>
      </div>
    );
  }

  // 2026-09-09: the waveform used to stand in for the words until
  // processor.analysis landed, which is seconds later — so the learner's own
  // sentence was hidden exactly when they wanted to re-read it. Show the text
  // as soon as we have it; the waveform is now only for a turn that genuinely
  // has no text yet, and the colored word chips still light up when the
  // analysis arrives.
  if (!turn.hasAnalysis && !turn.text) {
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

  // Resolved: keep the original transcript stable and decorate matching
  // target-language words in place. Analysis is allowed to add color, never
  // to replace the sentence with a lossy lexeme-only list.
  return (
    <div className="voice-bubble-row voice-bubble-row-user">
      <div className="voice-bubble voice-bubble-user">
        {formatUserTextWithChips(turn, onWordTap)}
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

  // Stick-to-bottom: scroll whenever content height changes, not just when
  // a turn is added — streaming text and late webfont/layout reflow grow
  // the transcript without changing turns.length, which left the view
  // stranded mid-scroll (last message half-hidden under the fade mask).
  // Skipped when the user has scrolled up to reread.
  const pinnedToBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stick = () => {
      if (pinnedToBottom.current) el.scrollTop = el.scrollHeight;
    };
    stick();
    const ro = new ResizeObserver(stick);
    ro.observe(el);
    // Also observe content growth: the transcript's first child grows as
    // bubbles reflow; observing the container alone misses height changes
    // driven by content when the container itself is clipped to flex space.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [turns.length, showTyping]);

  return (
    <ScrollShadow className="voice-transcript" ref={scrollRef}>
      {turns.length === 0 && !showTyping && (
        <div className="voice-transcript-empty">
          <span className="conversation-empty-mark">
            <AudioLines size={36} aria-hidden="true" />
          </span>
          <h2>
            A little conversation.
            <br />A little more confidence.
          </h2>
          <p>Your next conversation starts here.</p>
        </div>
      )}
      {turns.map((turn) =>
        turn.kind === 'agent' ? (
          <AgentBubble key={turn.id} turn={turn} />
        ) : (
          <UserBubble
            key={turn.id}
            turn={turn}
            onWordTap={onWordTap}
            heldMs={
              pttHoldForTurnId && pttHoldForTurnId.id === turn.id ? pttHoldForTurnId.ms : undefined
            }
          />
        ),
      )}
      {showTyping && <TypingIndicator />}
    </ScrollShadow>
  );
}

export default function VoiceTab(props: VoiceTabProps) {
  const [transport, setTransport] = useState<'loading' | 'livekit' | 'smallwebrtc' | 'error'>('loading');
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/voice/config').then(async response => {
      // Older LiveKit deployments do not expose transport discovery.
      if (response.status === 404) { if (!cancelled) setTransport('livekit'); return; }
      if (!response.ok) throw new Error('Voice configuration unavailable');
      const config = await response.json();
      if (!['livekit', 'smallwebrtc'].includes(config.transport)) throw new Error('Unknown transport');
      if (!cancelled) setTransport(config.transport);
    }).catch(() => { if (!cancelled) setTransport('error'); });
    return () => { cancelled = true; };
  }, []);
  if (transport === 'loading') return <p role="status" className="p-4">Loading voice settings…</p>;
  if (transport === 'error') return <p role="alert" className="p-4">Voice settings unavailable. Reload to retry.</p>;
  if (transport === 'smallwebrtc') return <PipecatVoice key={`${props.userId}:${props.targetLang}`} language={props.targetLang} />;
  return <LiveKitVoiceTab {...props} />;
}

function LiveKitVoiceTab({ userId, targetLang }: VoiceTabProps) {
  const { openSheet, serviceMode, activeTab, contentVersion } = useAppState();
  const [eventSessionId, setEventSessionId] = useState<string | null>(null);
  const {
    turns,
    clear: clearConversation,
    status: streamStatus,
  } = useConversationStream(eventSessionId);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
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

  // Curriculum pill — shows the user's actual active reading (Library tab's
  // "Now Learning" selection → placeUserInSource → readLearnerView's
  // activeChunk), the same content the planner is using this turn. Falls
  // back to the lowest-`order` /api/curriculum unit only when nothing's
  // been selected yet, so the pill still shows something reasonable for a
  // brand-new user with an empty Library.
  //
  // Refetches on `activeTab` too, not just mount: VoiceTab stays mounted
  // across tab switches (AppShell toggles it with display:none rather than
  // unmounting, so the live LiveKit connection survives navigating away),
  // so without this a source picked in Library wouldn't show up here until
  // a full page reload. Also depends on `contentVersion` for the case where
  // the change happens WITHOUT a tab switch — jumping via the chunk browser
  // sheet, reachable from this same tab's curriculum pill.
  useEffect(() => {
    if (!targetLang || !userId || activeTab !== 'voice') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/users/${userId}/active-content?language=${targetLang}`);
        if (res.ok) {
          const chunk = await res.json();
          if (!cancelled && chunk) {
            setUnitTitle(chunk.sourceTitle);
            return;
          }
        }
      } catch {
        /* fall through to the curriculum-unit fallback below */
      }

      try {
        const res = await apiFetch(`/api/curriculum?language=${targetLang}`);
        if (!res.ok) return;
        const units: CurriculumUnit[] = await res.json();
        if (!cancelled && units.length > 0) {
          const first = units.slice().sort((a, b) => a.order - b.order)[0];
          setUnitTitle(first.title);
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetLang, userId, activeTab, contentVersion]);

  // Streak chip + word-due-count — Task 3's summary endpoint.
  // Re-fetch on tab re-entry / content bump so "ready to review" doesn't
  // go stale after a session moves words' state.
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const res = await apiFetch(`/api/users/${userId}/summary`);
        if (!res.ok) return;
        setSummary(await res.json());
      } catch {
        /* non-fatal */
      }
    })();
  }, [userId, activeTab, contentVersion]);

  // Goal chip text — existing /api/users/:userId response's goals[].
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const res = await apiFetch(`/api/users/${userId}`);
        if (!res.ok) return;
        const data = await res.json();
        setGoals((data.goals ?? []).filter((g: ActiveGoal) => g.status === 'active'));
      } catch {
        /* non-fatal */
      }
    })();
  }, [userId, activeTab, contentVersion]);

  // `connecting` guards against a double-tap firing this twice before the
  // button disappears — each call hits /api/token, which dispatches an
  // agent job; two overlapping dispatches for the same room used to spawn
  // two independent agent sessions talking over each other (see the
  // server-side comment on the dispatch-dedup fix in server.ts).
  const connect = async () => {
    if (connecting || connected) return;
    setConnecting(true);
    setError(null);
    // Ask for the microphone BEFORE spending a room token. Without this the
    // room still connects when the mic is blocked, plays the tutor's greeting,
    // and then silently ignores the learner — no error, no transcript, which
    // reads as "the app is broken". See lib/microphone.ts for the failure modes.
    const micProblem = await requestMicrophone();
    if (micProblem) {
      setError(micProblem);
      setConnecting(false);
      return;
    }
    // Fresh session, fresh transcript — otherwise turns from a previous
    // connection (possibly a different target language, since switching
    // languages only takes effect on the next connect) stay on screen
    // forever: useConversationStream's state lives in this component and
    // was never reset on reconnect.
    clearConversation();
    try {
      const { token: t, url: u, roomName: rn, eventSessionId: sid } = await fetchToken(serviceMode);
      setToken(t);
      setUrl(u);
      setEventSessionId(sid);
      console.log(`[VoiceTab] Connecting to room: ${rn}`);
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = (reason?: string) => {
    setConnected(false);
    setEventSessionId(null);
    setToken('');
    setUrl('');
    if (reason) setError(reason);
  };

  const primaryGoal = goals[0];
  const goalText = primaryGoal ? goalLabel(primaryGoal) : 'Keep talking';

  const handleWordTap = (wordId: string) => openSheet({ kind: 'wordDetail', wordId });

  // Mobile: once connected, the static bands (eyebrow+title, pills row, goal
  // chip) are dead weight — the user should be talking, not reading chrome.
  // 2026-09-26: CSS now removes them from the layout on phones (they were
  // previously only shrunk, which reclaimed nothing) and shows `SessionBar`
  // in their place. The `in-session` class is driven by `connected` state
  // rather than unmounting, so the pills/goal chip come back with the same
  // state on disconnect and nothing re-fetches.
  return (
    <div className={connected ? 'voice-tab in-session' : 'voice-tab'}>
      <div className="conversation-heading">
        <div>
          <span className="page-eyebrow">JUST SPEAK</span>
          <h1>Conversation</h1>
        </div>
        <span
          className={connected ? 'conversation-connection connected' : 'conversation-connection'}
        >
          <span />
          {connected ? 'Connected' : 'Ready when you are'}
        </span>
      </div>
      <TopBar
        left={<LanguagePill lang={targetLang} onClick={() => openSheet({ kind: 'language' })} />}
        center={
          <CurriculumPill title={unitTitle} onClick={() => openSheet({ kind: 'curriculum' })} />
        }
        right={<StreakChip streak={summary?.streak ?? null} />}
      />
      <GoalChip text={goalText} wordsDue={summary?.wordsDue ?? null} />

      {/* Mobile in-session replacement for the three bands above — CSS shows
          this only when connected on a phone (see app.css's in-session
          block), so desktop and the pre-connect screen are unchanged. */}
      <SessionBar
        lang={targetLang}
        unitTitle={unitTitle}
        streak={summary?.streak ?? null}
        goalText={goalText}
        wordsDue={summary?.wordsDue ?? null}
        onLanguage={() => openSheet({ kind: 'language' })}
        onCurriculum={() => openSheet({ kind: 'curriculum' })}
      />

      <Transcript turns={turns} onWordTap={handleWordTap} pttHoldForTurnId={pttHoldFor} />

      {!connected ? (
        <div className="voice-controls">
          <Button variant="primary" isPending={connecting} onPress={connect}>
            <Mic size={18} />
            {connecting ? 'Connecting…' : 'Start talking'}
          </Button>
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
        <LiveKitRoom
          token={token}
          serverUrl={url}
          connect={true}
          onDisconnected={() => disconnect()}
        >
          {(streamStatus === 'reconnecting' || streamStatus === 'error') && (
            <div className="error-msg conversation-stream-status" role="status">
              {streamStatus === 'reconnecting'
                ? 'Conversation updates disconnected. Reconnecting…'
                : 'Conversation updates are unavailable. Disconnect and reconnect to restore the transcript.'}
            </div>
          )}
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
