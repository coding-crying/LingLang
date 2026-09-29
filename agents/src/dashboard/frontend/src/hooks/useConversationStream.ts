/**
 * useConversationStream — SSE-driven conversation state for the Voice tab.
 *
 * Task 4a rewrite. This supersedes the inline hook that used to live in
 * VoiceRoom.tsx (still there, untouched, for VoiceRoom's own rendering —
 * see that file's `useConversationStream` around lines 180-286). This file
 * exists standalone; nothing imports it yet. Task 4b will switch the Voice
 * tab over to it.
 *
 * Two bugs this fixes (see .superpowers/sdd/task-4a-brief.md for the full
 * writeup):
 *
 * 1. Duplicate agent replies — the old code finalized the streaming bubble
 *    on `llm.token`'s `isEnd` by nulling out the ref that `agent.reply`
 *    used to find it, so the "late" `agent.reply` (arriving after isEnd,
 *    which is the common case) fell into the `else` branch and pushed a
 *    brand-new bubble. Fixed here by keying every agent turn on `turnSeq`
 *    (see below) instead of a ref that gets nulled: `llm.token` and
 *    `agent.reply` for the same exchange always resolve to the identical
 *    turn id, so `agent.reply` always updates in place.
 *
 * 2. User turns rendered out of order / disconnected from speaking time —
 *    the old code merged two separately-populated arrays and re-sorted by
 *    each bubble's *creation* timestamp. Since `processor.analysis` is an
 *    async, batched, potentially-much-later event, sorting by ts routinely
 *    put the user's bubble after the agent's reply to it. Fixed here by
 *    maintaining ONE append-order list of turns: a user turn's slot is
 *    created the instant `user.transcript` arrives, and `processor.analysis`
 *    only ever updates that same slot in place — it can never move a turn
 *    to a new position.
 *
 * turnSeq correlation (design decision):
 * This hook relies on a `turnSeq` field now threaded through the backend
 * emit calls in tutor-event-driven.ts (`user.transcript`, `processor.analysis`,
 * `agent.reply`, `llm.token`) — see that file for the corresponding change.
 * We chose the backend addition over a frontend-only FIFO/arrival-order
 * heuristic because it was a small, low-risk change (a single counter,
 * `totalUserTurns`, already existed and just needed to be stamped onto four
 * existing emitEvent calls) and it removes an entire class of matching bugs
 * outright rather than approximating them. As a defensive fallback — in case
 * events ever arrive without a `turnSeq` (e.g. a mixed rollout) — this
 * module still falls back to arrival-order heuristics (FIFO oldest-open
 * user turn for `processor.analysis`, "current streaming turn" for
 * `llm.token`/`agent.reply`), which is the frontend-only approach the brief
 * offered as the alternative. That fallback path is exercised in the tests
 * below alongside the primary turnSeq path.
 *
 * One caveat noted for the record (not a blocker): when
 * `PROCESSOR_TURN_INTERVAL` (env var read by tutor-event-driven.ts) is set
 * above its default of 1, a single `processor.analysis` batches several
 * prior user turns into one LLM call. The backend stamps that event with
 * the turnSeq of the *last* turn in the batch, so only that turn's bubble
 * gets the analysis chips attached — earlier turns in the batch render as
 * plain (unanalyzed) bubbles. That's a pre-existing ambiguity in the
 * pipeline, not something this task introduces, and the default
 * configuration (interval = 1) has no ambiguity at all.
 *
 * Second caveat, added after review (also not a blocker): the backend now
 * captures the turnSeq for an exchange's `llm.token`/`agent.reply` pair
 * exactly once, at that exchange's own token-stream start (its first
 * `isStart` delta), and holds it steady through to `isEnd` — this is what
 * keeps a barge-in/interruption on a *later* turn from bumping the turnSeq
 * stamped on an *earlier*, still-streaming exchange's remaining deltas
 * (see tutor-event-driven.ts, `currentExchangeTurnSeq`). One narrow gap
 * remains, unclosed, because there is no clean signal for it: if an
 * exchange is interrupted before its stream's `isEnd`, and its
 * `ConversationItemAdded` (i.e. `agent.reply`) is somehow still emitted
 * *after* a subsequent exchange's token stream has already started, the
 * shared `currentExchangeTurnSeq` will have already advanced to that next
 * exchange's turnSeq, and the stale `agent.reply` will misattach to it.
 * In this codebase's normal flow, replies are generated one at a time and
 * an interrupted exchange typically never reaches `ConversationItemAdded`
 * at all, so this ordering has not been observed — but it is not
 * structurally impossible, and no test in this file exercises it.
 */
import { useCallback, useEffect, useReducer, useState } from 'react';
import { apiEventSource } from '../lib/api';

// ─── Types ───

export interface LexemeChip {
  lemma: string;
  form: string;
  pos: string;
  performance:
    | 'correct'
    | 'correct_instant'
    | 'correct_struggled'
    | 'wrong_use'
    | 'recall_fail'
    | 'native_substitution'
    | 'correct_use'
    | 'scaffolded'; // legacy labels, still in old events
  grammarRule?: { rule: string; example: string };
  pronunciation?: { stress: string; notes?: string };
}

export interface SrsUpdate {
  lexemeId: string;
  oldState: number;
  newState: number;
  grade: number;
}

export interface UserTurn {
  kind: 'user';
  id: string;
  turnSeq: number | null;
  text: string;
  lexemes: LexemeChip[];
  srsUpdates: SrsUpdate[];
  hasAnalysis: boolean;
  ts: number;
  /** True while this bubble is still being spoken — rendered dimmed/italic
   *  and replaced in place by the finalized transcript on the same id.
   *  Only realtime (Gemini) sessions emit partials. */
  interim?: boolean;
}

export interface AgentTurn {
  kind: 'agent';
  id: string;
  turnSeq: number | null;
  text: string;
  finalized: boolean;
  ts: number;
}

export type ConversationTurn = UserTurn | AgentTurn;

/** Raw shape of a parsed SSE `data:` payload from GET /api/events. */
export interface RawStreamEvent {
  type: string;
  ts: number;
  data: any;
}

export interface ConversationState {
  turns: ConversationTurn[];
  /** id of the agent turn currently mid-stream (accumulating llm.token
   *  deltas) — only used as a fallback when an event arrives without a
   *  turnSeq. Cleared on isEnd, since a fresh llm.token after that starts
   *  a new turn. */
  streamingAgentId: string | null;
  /** id of the MOST RECENT agent turn (streamed or reply-only), fallback
   *  path only. Unlike streamingAgentId, this is NOT cleared on isEnd —
   *  it's what lets a fallback-path agent.reply that arrives after isEnd
   *  still find and update the same turn instead of creating a duplicate
   *  (the no-turnSeq equivalent of the turnSeq-keyed fix above). */
  lastAgentId: string | null;
  /** FIFO of user turn ids awaiting processor.analysis — only consulted
   *  when a processor.analysis event arrives without a turnSeq. */
  pendingUserQueue: string[];
  /** Counter for synthesizing ids when turnSeq is unavailable. Kept in
   *  state (rather than crypto.randomUUID) so the reducer stays a pure,
   *  deterministic function of (state, event) — that's what makes it
   *  unit-testable without a DOM. */
  nextFallbackId: number;
}

export const initialConversationState: ConversationState = {
  turns: [],
  streamingAgentId: null,
  lastAgentId: null,
  pendingUserQueue: [],
  nextFallbackId: 0,
};

function findTurnIndex(turns: ConversationTurn[], id: string): number {
  return turns.findIndex((t) => t.id === id);
}

function numTurnSeq(data: any): number | null {
  return typeof data?.turnSeq === 'number' ? data.turnSeq : null;
}

/**
 * Stable per-message id from the backend, when the transport provides one.
 * Realtime (S2S) sessions do: one generation can emit several user utterances
 * and several assistant items that all share a turnSeq, so keying on turnSeq
 * alone made them overwrite each other. The prefix keeps these ids from
 * colliding with the turnSeq-derived ones. Cascaded (STT/LLM/TTS) sessions
 * send null here and keep the turnSeq path untouched.
 */
function itemIdKey(data: any, prefix: 'user' | 'agent'): string | null {
  const raw = data?.itemId;
  return typeof raw === 'string' && raw.length > 0 ? `${prefix}-item-${raw}` : null;
}

function itemIdBase(id: string): string {
  return id.replace(/#\d+$/, '');
}

function findInterimUserIndex(turns: ConversationTurn[], id: string): number {
  const base = itemIdBase(id.replace(/^user-item-/, ''));
  return turns.findIndex(
    (turn) =>
      turn.kind === 'user' &&
      turn.interim &&
      itemIdBase(turn.id.replace(/^user-item-/, '')) === base,
  );
}

/**
 * ConversationItemAdded can expose an internal tool result as an assistant
 * item before the actual spoken answer. It is not learner-facing content and
 * in realtime sessions it arrives with a different itemId, so itemId-keying
 * alone would render it as a second bubble. Keep this narrow: only remove a
 * leading `tool_name Result:` block, never rewrite normal tutor prose.
 */
function cleanAgentText(raw: unknown): string {
  let text = String(raw ?? '')
    .replace(/^thought\n/i, '')
    .trim();
  text = text.replace(/^[A-Za-z][A-Za-z0-9_-]*\s+(?:Результат|Result):[\s\S]*?\n\s*\n/i, '');
  return text.trim();
}

/**
 * Pure merge function: applies one raw SSE event to the conversation state
 * and returns the new state. No DOM, no EventSource, no randomness — fully
 * unit-testable by feeding it a sequence of fake events.
 */
export function applyStreamEvent(state: ConversationState, evt: RawStreamEvent): ConversationState {
  const { type, data, ts } = evt;

  switch (type) {
    case 'session.start': {
      // A worker restart is a hard transcript boundary. Do not let late
      // events from the previous worker populate the new conversation.
      return initialConversationState;
    }

    case 'user.transcript.partial': {
      // In-flight learner speech (realtime only). Upsert on the stable
      // per-generation itemId so the bubble grows as they talk; the final
      // `user.transcript` on the same id replaces it in place.
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      if (!text) return state;
      const itemId = itemIdKey(data, 'user');
      // No stable key → skip rather than churn fallback ids: the final
      // transcript will create the bubble anyway.
      if (itemId === null) return state;

      const idx = findTurnIndex(state.turns, itemId);
      const interimIdx = idx >= 0 ? idx : findInterimUserIndex(state.turns, itemId);
      if (interimIdx >= 0) {
        const prev = state.turns[interimIdx] as UserTurn;
        // A late partial must never overwrite a finalized turn.
        if (!prev.interim) return state;
        const turns = state.turns.slice();
        turns[interimIdx] = { ...prev, text };
        return { ...state, turns };
      }

      const turn: UserTurn = {
        kind: 'user',
        id: itemId,
        turnSeq: numTurnSeq(data),
        text,
        lexemes: [],
        srsUpdates: [],
        hasAnalysis: false,
        ts,
        interim: true,
      };
      // Deliberately NOT queued for processor.analysis — the final does that.
      return { ...state, turns: [...state.turns, turn] };
    }

    case 'user.transcript.rejected': {
      // The backend may reject a phantom only after its partial was shown.
      // Remove that provisional bubble, never finalized learner history.
      const id = itemIdKey(data, 'user');
      if (id === null) return state;
      const turn = state.turns.find((t) => t.id === id);
      if (turn?.kind !== 'user' || !turn.interim) return state;
      return { ...state, turns: state.turns.filter((t) => t.id !== id) };
    }

    case 'user.transcript': {
      if (!data?.text) return state;
      const turnSeq = numTurnSeq(data);
      const itemId = itemIdKey(data, 'user');
      const usedFallback = itemId === null && turnSeq === null;
      const id =
        itemId ?? (turnSeq !== null ? `user-${turnSeq}` : `user-fallback-${state.nextFallbackId}`);

      // Guard against duplicate creation — e.g. VAD EOU and STT FINAL both
      // firing for the same turn with the same turnSeq. Exception: an
      // interim bubble from `user.transcript.partial` is finalized in place.
      const exactIdx = findTurnIndex(state.turns, id);
      const existingIdx =
        exactIdx >= 0 ? exactIdx : itemId !== null ? findInterimUserIndex(state.turns, id) : -1;
      if (existingIdx >= 0) {
        const existing = state.turns[existingIdx] as UserTurn;
        if (existing.kind !== 'user' || !existing.interim) return state;
        const turns = state.turns.slice();
        turns[existingIdx] = {
          ...existing,
          text: data.text,
          turnSeq,
          interim: false,
          hasAnalysis: false,
        };
        return {
          ...state,
          turns,
          pendingUserQueue: [...state.pendingUserQueue, existing.id],
        };
      }

      const turn: UserTurn = {
        kind: 'user',
        id,
        turnSeq,
        text: data.text,
        lexemes: [],
        srsUpdates: [],
        hasAnalysis: false,
        ts,
      };

      return {
        ...state,
        turns: [...state.turns, turn],
        pendingUserQueue: [...state.pendingUserQueue, id],
        nextFallbackId: usedFallback ? state.nextFallbackId + 1 : state.nextFallbackId,
      };
    }

    case 'processor.analysis': {
      const turnSeq = numTurnSeq(data);
      const lexemes: LexemeChip[] = data?.lexemes ?? [];
      const srsUpdates: SrsUpdate[] = data?.srsUpdates ?? [];

      let targetId: string | null = itemIdKey(data, 'user');
      if (targetId !== null && findTurnIndex(state.turns, targetId) < 0) targetId = null;
      if (targetId === null && turnSeq !== null) {
        const candidate = `user-${turnSeq}`;
        if (findTurnIndex(state.turns, candidate) >= 0) targetId = candidate;
      }
      if (targetId === null) {
        // Fallback: oldest user turn still awaiting analysis (arrival-order
        // heuristic), for events that arrive without a turnSeq.
        targetId = state.pendingUserQueue[0] ?? null;
      }
      if (targetId === null) return state;

      const idx = findTurnIndex(state.turns, targetId);
      if (idx < 0) return state;

      const turns = state.turns.slice();
      const existing = turns[idx] as UserTurn;
      // Update IN PLACE — same index, same id. This is what keeps a
      // delayed processor.analysis from reordering the conversation: the
      // turn already occupies its correct append-order slot.
      turns[idx] = { ...existing, lexemes, srsUpdates, hasAnalysis: true };

      return {
        ...state,
        turns,
        pendingUserQueue: state.pendingUserQueue.filter((qid) => qid !== targetId),
      };
    }

    case 'llm.token': {
      const turnSeq = numTurnSeq(data);
      const itemId = itemIdKey(data, 'agent');

      if (data?.isEnd) {
        const id = itemId ?? (turnSeq !== null ? `agent-${turnSeq}` : state.streamingAgentId);
        if (!id) return { ...state, streamingAgentId: null };
        const idx = findTurnIndex(state.turns, id);
        if (idx < 0) return { ...state, streamingAgentId: null };
        const turns = state.turns.slice();
        const existing = turns[idx] as AgentTurn;
        turns[idx] = { ...existing, finalized: true };
        // NOTE: streamingAgentId (used to route the NEXT token delta) is
        // cleared here, same as the old streamingRef — but lastAgentId
        // (used only by the no-turnSeq agent.reply fallback below) is
        // deliberately left pointing at `id`, so a late fallback-path
        // agent.reply can still find this turn after isEnd.
        return { ...state, turns, streamingAgentId: null, lastAgentId: id };
      }

      if (!data?.text) return state;
      const id =
        itemId ??
        (turnSeq !== null
          ? `agent-${turnSeq}`
          : (state.streamingAgentId ?? `agent-fallback-${state.nextFallbackId}`));
      const idx = findTurnIndex(state.turns, id);

      if (idx >= 0) {
        const turns = state.turns.slice();
        const existing = turns[idx] as AgentTurn;
        turns[idx] = { ...existing, text: existing.text + data.text };
        return { ...state, turns, streamingAgentId: id, lastAgentId: id };
      }

      const turn: AgentTurn = { kind: 'agent', id, turnSeq, text: data.text, finalized: false, ts };
      return {
        ...state,
        turns: [...state.turns, turn],
        streamingAgentId: id,
        lastAgentId: id,
        nextFallbackId:
          itemId !== null || turnSeq !== null ? state.nextFallbackId : state.nextFallbackId + 1,
      };
    }

    case 'agent.reply': {
      if (!data?.text) return state;
      const text = cleanAgentText(data.text);
      if (!text) return state;

      const turnSeq = numTurnSeq(data);
      const itemId = itemIdKey(data, 'agent');
      // Primary path: itemId (realtime) or turnSeq-derived id, both stable
      // across isEnd. Fallback path (neither): prefer the currently-streaming
      // turn if there is one, else the last-known agent turn (which survives
      // isEnd) — this mirrors the turnSeq fix for events that predate turnSeq.
      const id =
        itemId ??
        (turnSeq !== null ? `agent-${turnSeq}` : (state.streamingAgentId ?? state.lastAgentId));

      // Gemini may surface the same completed answer twice around a tool call,
      // with different response/item ids. Same turn + same visible text is
      // one conversational bubble, not two assistant turns.
      if (
        turnSeq !== null &&
        state.turns.some(
          (turn) =>
            turn.kind === 'agent' && turn.turnSeq === turnSeq && cleanAgentText(turn.text) === text,
        )
      ) {
        return state;
      }

      if (id) {
        const idx = findTurnIndex(state.turns, id);
        if (idx >= 0) {
          // The fix for bug #1: this always lands here, on the SAME turn
          // the streamed tokens built up, regardless of whether isEnd
          // already fired — because the id is derived from turnSeq (or,
          // in the fallback path, from lastAgentId, which also survives
          // isEnd), not from a ref that isEnd nulls out entirely.
          const turns = state.turns.slice();
          const existing = turns[idx] as AgentTurn;
          turns[idx] = { ...existing, text, finalized: true };
          return {
            ...state,
            turns,
            streamingAgentId: state.streamingAgentId === id ? null : state.streamingAgentId,
            lastAgentId: id,
          };
        }
        // Correlated id, but no streamed turn exists yet (agent.reply beat
        // llm.token, or llm.token was never emitted for this exchange).
        const turn: AgentTurn = { kind: 'agent', id, turnSeq, text, finalized: true, ts };
        return { ...state, turns: [...state.turns, turn], lastAgentId: id };
      }

      // No correlation available at all (no turnSeq, no active/last stream)
      // — last-resort append, matching the old code's behavior in that case.
      const fallbackId = `agent-fallback-${state.nextFallbackId}`;
      const turn: AgentTurn = {
        kind: 'agent',
        id: fallbackId,
        turnSeq: null,
        text,
        finalized: true,
        ts,
      };
      return {
        ...state,
        turns: [...state.turns, turn],
        lastAgentId: fallbackId,
        nextFallbackId: state.nextFallbackId + 1,
      };
    }

    default:
      return state;
  }
}

type ConversationAction = { kind: 'event'; evt: RawStreamEvent } | { kind: 'clear' };

function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  if (action.kind === 'clear') return initialConversationState;
  return applyStreamEvent(state, action.evt);
}

// ─── Hook ───

export type ConversationStreamStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export function useConversationStream(sessionId: string | null = null) {
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  const [status, setStatus] = useState<ConversationStreamStatus>('idle');

  useEffect(() => {
    if (!sessionId) {
      setStatus('idle');
      return;
    }

    const es = apiEventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);
    setStatus('connecting');
    es.onopen = () => setStatus('connected');
    es.onerror = () =>
      setStatus(es.readyState === EventSource.CONNECTING ? 'reconnecting' : 'error');
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as RawStreamEvent;
        dispatch({ kind: 'event', evt });
      } catch {
        // malformed SSE payload — ignore, matches prior behavior
      }
    };
    return () => {
      es.close();
      setStatus('idle');
    };
  }, [sessionId]);

  const clear = useCallback(() => dispatch({ kind: 'clear' }), []);

  return { turns: state.turns, clear, status };
}
