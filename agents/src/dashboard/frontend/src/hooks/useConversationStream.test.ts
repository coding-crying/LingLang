/**
 * Unit tests for the useConversationStream merge/ordering logic.
 *
 * Plain assertion script (matches the repo's existing test-architecture.ts /
 * test-database-flow.ts convention — no test framework is configured for
 * this frontend package). Run with:
 *
 *   npx tsx src/dashboard/frontend/src/hooks/useConversationStream.test.ts
 *
 * (from the `agents/` directory)
 *
 * This file is excluded from `tsc --noEmit -p .` by agents/tsconfig.json's
 * `src/**\/*.test.ts` exclude pattern, same as every other *.test.ts in the
 * package — tsx type-strips and runs it directly.
 */

import {
  applyStreamEvent,
  initialConversationState,
  type ConversationState,
  type RawStreamEvent,
  type UserTurn,
  type AgentTurn,
} from './useConversationStream.js';

let failures = 0;
let passes = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`✗ FAIL: ${msg}`);
  }
}

function replay(events: RawStreamEvent[]): ConversationState {
  let state = initialConversationState;
  for (const evt of events) {
    state = applyStreamEvent(state, evt);
  }
  return state;
}

// ============================================================================
// Test 1: duplicate agent reply (bug #1)
//
// Reproduces the original failure mode first: llm.token deltas + isEnd
// finalize a streaming bubble, then a "late" agent.reply for the SAME
// exchange arrives afterward (the common case per the bug report). The old
// code nulled streamingRef on isEnd, so agent.reply's `else` branch pushed
// a brand-new bubble => TWO agent turns for one exchange. The fix keys
// both llm.token and agent.reply on the same turnSeq-derived id, so
// agent.reply must always update the existing turn instead.
// ============================================================================

function testNoDuplicateAgentReply() {
  const events: RawStreamEvent[] = [
    { type: 'user.transcript', ts: 1000, data: { text: 'Привет', isFinal: true, turnSeq: 1 } },
    { type: 'llm.token', ts: 1010, data: { text: 'Здравствуй', isStart: true, isEnd: false, turnSeq: 1 } },
    { type: 'llm.token', ts: 1020, data: { text: 'те!', isStart: false, isEnd: false, turnSeq: 1 } },
    { type: 'llm.token', ts: 1030, data: { text: '', isStart: false, isEnd: true, turnSeq: 1 } },
    // agent.reply arrives AFTER isEnd — this is the "late" case that broke
    // the old code (streamingRef.current was already null by this point).
    { type: 'agent.reply', ts: 1200, data: { text: 'Здравствуйте!', source: 'llm', turnSeq: 1 } },
  ];

  const state = replay(events);
  const agentTurns = state.turns.filter((t) => t.kind === 'agent') as AgentTurn[];

  assert(agentTurns.length === 1, `expected exactly ONE agent bubble, got ${agentTurns.length}`);
  assert(
    agentTurns[0]?.text === 'Здравствуйте!',
    `expected the single agent bubble to hold the agent.reply text, got "${agentTurns[0]?.text}"`,
  );
  assert(agentTurns[0]?.finalized === true, 'expected the agent bubble to be finalized');

  // Also cover the case where agent.reply arrives BEFORE isEnd (order not
  // guaranteed relative to the tail of the token stream in all backends) —
  // should still collapse to one bubble.
  const eventsEarlyReply: RawStreamEvent[] = [
    { type: 'user.transcript', ts: 2000, data: { text: 'Как дела?', isFinal: true, turnSeq: 2 } },
    { type: 'llm.token', ts: 2010, data: { text: 'Хорошо', isStart: true, isEnd: false, turnSeq: 2 } },
    { type: 'agent.reply', ts: 2015, data: { text: 'Хорошо, а у тебя?', turnSeq: 2 } },
    { type: 'llm.token', ts: 2020, data: { text: ', а у тебя?', isStart: false, isEnd: false, turnSeq: 2 } },
    { type: 'llm.token', ts: 2030, data: { text: '', isStart: false, isEnd: true, turnSeq: 2 } },
  ];
  const state2 = replay(eventsEarlyReply);
  const agentTurns2 = state2.turns.filter((t) => t.kind === 'agent') as AgentTurn[];
  assert(agentTurns2.length === 1, `[early-reply variant] expected ONE agent bubble, got ${agentTurns2.length}`);
}

// ============================================================================
// Test 2: delayed processor.analysis ordering (bug #2)
//
// processor.analysis for turn N arrives AFTER the full agent.reply/llm.token
// exchange for turn N+1 (the realistic case, since processor grading is an
// async background LLM call gated by PROCESSOR_TURN_INTERVAL and can lag
// behind the live conversation by a full extra turn or more). The old code
// sorted the merged bubble list by each bubble's creation ts, so turn N's
// user bubble — created late — would sort AFTER turn N+1's agent reply.
// The fix: turn N's user slot is created immediately at user.transcript
// time (before N+1 even starts), and processor.analysis only ever updates
// that existing slot in place, never re-sorts.
// ============================================================================

function testDelayedProcessorAnalysisOrdering() {
  const events: RawStreamEvent[] = [
    // Turn N (turnSeq=1): user speaks, agent replies immediately.
    { type: 'user.transcript', ts: 1000, data: { text: 'Я хочу пиво', isFinal: true, turnSeq: 1 } },
    { type: 'llm.token', ts: 1010, data: { text: 'Отлично!', isStart: true, isEnd: true, turnSeq: 1 } },
    { type: 'agent.reply', ts: 1015, data: { text: 'Отлично!', turnSeq: 1 } },

    // Turn N+1 (turnSeq=2): user speaks again, agent replies again — all of
    // this happens BEFORE turn N's grading ever completes.
    { type: 'user.transcript', ts: 2000, data: { text: 'Спасибо', isFinal: true, turnSeq: 2 } },
    { type: 'llm.token', ts: 2010, data: { text: 'Пожалуйста!', isStart: true, isEnd: true, turnSeq: 2 } },
    { type: 'agent.reply', ts: 2015, data: { text: 'Пожалуйста!', turnSeq: 2 } },

    // Turn N's processor.analysis finally lands, LATE — after everything
    // above, with a timestamp well after turn N+1's exchange.
    {
      type: 'processor.analysis',
      ts: 5000,
      data: {
        turnSeq: 1,
        lexemes: [{ lemma: 'пиво', form: 'пиво', pos: 'NOUN', performance: 'correct' }],
        srsUpdates: [],
      },
    },
  ];

  const state = replay(events);

  const kinds = state.turns.map((t) => t.kind);
  // Expected append order: user(1), agent(1), user(2), agent(2) — the late
  // processor.analysis must NOT have moved user(1) after agent(2).
  assert(
    JSON.stringify(kinds) === JSON.stringify(['user', 'agent', 'user', 'agent']),
    `expected turn order [user, agent, user, agent], got ${JSON.stringify(kinds)}`,
  );

  const userTurn1 = state.turns[0] as UserTurn;
  const agentTurn2 = state.turns[3] as AgentTurn;
  const idxUser1 = state.turns.indexOf(userTurn1);
  const idxAgent2 = state.turns.indexOf(agentTurn2);
  assert(idxUser1 < idxAgent2, "turn N's user bubble must render BEFORE turn N+1's exchange");

  // And the analysis data must have actually landed on turn N's slot (in
  // place — same id/index), not created a new dangling bubble.
  assert(userTurn1.turnSeq === 1, 'turn N user bubble should carry turnSeq 1');
  assert(userTurn1.hasAnalysis === true, "turn N's user bubble should be updated with hasAnalysis=true");
  assert(userTurn1.lexemes.length === 1 && userTurn1.lexemes[0]?.lemma === 'пиво', 'turn N should carry the delayed lexeme data');
  assert(state.turns.length === 4, `no extra bubble should have been created for the delayed analysis, got ${state.turns.length} turns`);
}

// ============================================================================
// Test 3: fallback path (no turnSeq) — arrival-order heuristic
//
// Defensive coverage for events that arrive without a turnSeq (e.g. an
// older backend build). processor.analysis without turnSeq should attach
// to the OLDEST user turn still awaiting analysis (FIFO), and agent.reply
// without turnSeq should still collapse into the currently-streaming turn.
// ============================================================================

function testFallbackFifoMatchingWithoutTurnSeq() {
  const events: RawStreamEvent[] = [
    { type: 'user.transcript', ts: 1000, data: { text: 'first', isFinal: true } },
    { type: 'user.transcript', ts: 2000, data: { text: 'second', isFinal: true } },
    // No turnSeq on this analysis — should attach to the OLDEST unresolved
    // turn ("first"), not "second".
    {
      type: 'processor.analysis',
      ts: 3000,
      data: { lexemes: [{ lemma: 'x', form: 'x', pos: 'NOUN', performance: 'correct' }], srsUpdates: [] },
    },
  ];
  const state = replay(events);
  const userTurns = state.turns.filter((t) => t.kind === 'user') as UserTurn[];
  assert(userTurns[0]?.hasAnalysis === true, 'fallback: analysis should attach to the oldest (first) unresolved user turn');
  assert(userTurns[1]?.hasAnalysis === false, 'fallback: the second, newer user turn should remain unanalyzed');

  const dupEvents: RawStreamEvent[] = [
    { type: 'llm.token', ts: 1010, data: { text: 'hi', isStart: true, isEnd: false } },
    { type: 'llm.token', ts: 1020, data: { text: '', isStart: false, isEnd: true } },
    { type: 'agent.reply', ts: 1030, data: { text: 'hi there' } },
  ];
  const dupState = replay(dupEvents);
  const agentTurns = dupState.turns.filter((t) => t.kind === 'agent') as AgentTurn[];
  assert(agentTurns.length === 1, `fallback: expected ONE agent bubble without turnSeq, got ${agentTurns.length}`);
  assert(agentTurns[0]?.text === 'hi there', 'fallback: agent.reply text should have replaced the streamed text');
}

// ============================================================================
// Test 4: overlapping/interrupted turn — turnSeq must stay stable for the
// FULL lifetime of one agent exchange (review finding on Task 4a)
//
// Backend bug being regression-tested: `agent.reply` and `llm.token` used to
// stamp `turnSeq: totalUserTurns`, read LIVE at each emit, instead of a
// value captured once per exchange. If a new user turn (barge-in) landed
// while a prior agent reply's token stream was still open (before isEnd),
// the stream's tail + its agent.reply would get stamped with the NEW,
// higher turnSeq — even though they belong to the FIRST exchange. The fix
// (tutor-event-driven.ts's `currentExchangeTurnSeq`, captured once at the
// stream's `isStart`) makes every event of one exchange carry the SAME
// turnSeq, no matter what happens on later turns before isEnd.
//
// Part A below replays events as the FIXED backend actually emits them
// (turnSeq stable at 1 throughout exchange 1, despite turn 2 interleaving)
// and asserts the hook produces exactly one turn-1 agent bubble, correctly
// separate from turn 2's.
//
// Part B replays the SAME scenario but with the tail of exchange 1's events
// stamped turnSeq: 2 — i.e. exactly what the PRE-FIX backend would have
// produced (a live read of totalUserTurns after it had already bumped to
// 2). This half is what makes the test meaningful as a regression check:
// it demonstrates the hook (unchanged, correct, turnSeq-keyed logic) still
// produces the duplicate-bubble bug when fed pre-fix-shaped events, proving
// the bug lived in the backend's turnSeq stamping, not in this hook, and
// that this test would have been RED before the tutor-event-driven.ts fix
// (because production events would have looked like Part B, not Part A).
// ============================================================================

function testOverlappingTurnKeepsStableTurnSeq() {
  // --- Part A: fixed-backend shape — turnSeq stays 1 for all of exchange 1 ---
  const fixedEvents: RawStreamEvent[] = [
    // Exchange 1 begins: user turn 1, agent reply starts streaming.
    { type: 'user.transcript', ts: 1000, data: { text: 'Расскажи о погоде', isFinal: true, turnSeq: 1 } },
    { type: 'llm.token', ts: 1010, data: { text: 'Сегодня ', isStart: true, isEnd: false, turnSeq: 1 } },

    // Turn 2 (barge-in) arrives WHILE exchange 1's stream is still open
    // (no isEnd yet for turnSeq 1's stream).
    { type: 'user.transcript', ts: 1015, data: { text: 'Подожди', isFinal: true, turnSeq: 2 } },
    { type: 'processor.analysis', ts: 1300, data: { turnSeq: 2, lexemes: [], srsUpdates: [] } },

    // Exchange 1's stream resumes/finishes — FIXED backend holds turnSeq at
    // 1 for these, even though totalUserTurns is now 2 in the backend.
    { type: 'llm.token', ts: 1020, data: { text: 'солнечно', isStart: false, isEnd: false, turnSeq: 1 } },
    { type: 'llm.token', ts: 1030, data: { text: '', isStart: false, isEnd: true, turnSeq: 1 } },
    { type: 'agent.reply', ts: 1040, data: { text: 'Сегодня солнечно', turnSeq: 1 } },
  ];

  const fixedState = replay(fixedEvents);
  const fixedAgentTurns = fixedState.turns.filter((t) => t.kind === 'agent') as AgentTurn[];

  assert(
    fixedAgentTurns.length === 1,
    `[stable turnSeq] expected exactly ONE agent bubble for exchange 1, got ${fixedAgentTurns.length}`,
  );
  assert(
    fixedAgentTurns[0]?.turnSeq === 1,
    `[stable turnSeq] the single agent bubble must belong to turn 1, got turnSeq=${fixedAgentTurns[0]?.turnSeq}`,
  );
  assert(
    fixedAgentTurns[0]?.text === 'Сегодня солнечно',
    `[stable turnSeq] expected exchange 1's final text, got "${fixedAgentTurns[0]?.text}"`,
  );
  assert(fixedAgentTurns[0]?.finalized === true, '[stable turnSeq] exchange 1 bubble should be finalized');

  // --- Part B: pre-fix backend shape — tail of exchange 1 mis-stamped 2 ---
  const buggyEvents: RawStreamEvent[] = [
    { type: 'user.transcript', ts: 1000, data: { text: 'Расскажи о погоде', isFinal: true, turnSeq: 1 } },
    { type: 'llm.token', ts: 1010, data: { text: 'Сегодня ', isStart: true, isEnd: false, turnSeq: 1 } },
    { type: 'user.transcript', ts: 1015, data: { text: 'Подожди', isFinal: true, turnSeq: 2 } },
    { type: 'processor.analysis', ts: 1300, data: { turnSeq: 2, lexemes: [], srsUpdates: [] } },
    // PRE-FIX bug: totalUserTurns already bumped to 2 by the time these
    // fire, so the (buggy) live read stamps them turnSeq: 2 even though
    // they're still exchange 1's own stream tail / reply.
    { type: 'llm.token', ts: 1020, data: { text: 'солнечно', isStart: false, isEnd: false, turnSeq: 2 } },
    { type: 'llm.token', ts: 1030, data: { text: '', isStart: false, isEnd: true, turnSeq: 2 } },
    { type: 'agent.reply', ts: 1040, data: { text: 'Сегодня солнечно', turnSeq: 2 } },
  ];

  const buggyState = replay(buggyEvents);
  const buggyAgentTurns = buggyState.turns.filter((t) => t.kind === 'agent') as AgentTurn[];

  // This documents the bug this task fixes: fed pre-fix-shaped events, the
  // (unmodified, correct) hook creates a SECOND agent bubble under turnSeq 2
  // — a phantom exchange-1-shaped reply with no turn-1 user turn of its own
  // and no exchange-2 reply reaching it either. This is the exact
  // duplicate-bubble failure mode the review flagged; it's why the fix had
  // to be in tutor-event-driven.ts (stamp correctly) rather than in this
  // hook (which already trusts turnSeq as ground truth).
  assert(
    buggyAgentTurns.length === 2,
    `[pre-fix shape demonstrates the bug] expected the mis-stamped events to produce TWO agent bubbles ` +
    `(proving the hook can't recover from a backend that mis-stamps turnSeq mid-stream), got ${buggyAgentTurns.length}`,
  );
}

// ============================================================================
// Test 5: realtime (Gemini Live) itemId keying
//
// Realtime sessions have no llm.token stream and no VAD EOU, so the backend
// stamps every assistant item with a live totalUserTurns and every user
// utterance with the generation id. Pre-fix, that collapsed the two-item
// greeting onto `agent-0` and merged barge-in utterances into one bubble.
// Now itemId is the key when present; turnSeq remains the fallback.
// ============================================================================

function testRealtimeItemIdKeying() {
  // --- Part A: pre-fix shape — two greeting items, both turnSeq 0 ---
  const preFix = replay([
    { type: 'agent.reply', ts: 1000, data: { text: 'Olá! Praticamos um pouco de português.', turnSeq: 0 } },
    { type: 'agent.reply', ts: 1010, data: { text: 'Lembras-te de como dizer que te sentes um pouco mal?', turnSeq: 0 } },
  ]);
  const preAgent = preFix.turns.filter((t) => t.kind === 'agent') as AgentTurn[];
  assert(
    preAgent.length === 1,
    `[pre-fix shape demonstrates the collision] expected both greeting items to collapse onto one bubble, got ${preAgent.length}`,
  );

  // --- Part B: fixed shape — itemId keys each item separately ---
  const fixed = replay([
    { type: 'agent.reply', ts: 1000, data: { text: 'Olá! Praticamos um pouco de português.', turnSeq: 0, itemId: 'resp-a' } },
    { type: 'agent.reply', ts: 1010, data: { text: 'Lembras-te de como dizer que te sentes um pouco mal?', turnSeq: 0, itemId: 'resp-b' } },
    { type: 'user.transcript', ts: 2000, data: { text: 'No, I thought it was', isFinal: true, turnSeq: 1, itemId: 'gen-1', latencySec: 0.8 } },
    { type: 'user.transcript', ts: 2100, data: { text: 'Wait, wait, wait. Slow down.', isFinal: true, turnSeq: 2, itemId: 'gen-2', latencySec: 0.4 } },
    { type: 'processor.analysis', ts: 3000, data: { turnSeq: 1, itemId: 'gen-1', lexemes: [], srsUpdates: [] } },
  ]);

  const agentTurns = fixed.turns.filter((t) => t.kind === 'agent') as AgentTurn[];
  const userTurns = fixed.turns.filter((t) => t.kind === 'user') as UserTurn[];

  assert(agentTurns.length === 2, `[itemId] expected 2 distinct agent bubbles, got ${agentTurns.length}`);
  assert(
    agentTurns[0]?.text.startsWith('Olá!') && agentTurns[1]?.text.startsWith('Lembras-te'),
    '[itemId] both greeting items should survive as separate bubbles in arrival order',
  );
  assert(userTurns.length === 2, `[itemId] expected 2 segmented user bubbles, got ${userTurns.length}`);
  assert(userTurns[0]?.id === 'user-item-gen-1', `[itemId] expected user-item-gen-1, got ${userTurns[0]?.id}`);
  assert(userTurns[1]?.id === 'user-item-gen-2', `[itemId] expected user-item-gen-2, got ${userTurns[1]?.id}`);
  assert(
    userTurns[0]?.hasAnalysis === true && userTurns[1]?.hasAnalysis === false,
    '[itemId] processor.analysis should attach to gen-1 only',
  );
  assert(
    fixed.pendingUserQueue.length === 1 && fixed.pendingUserQueue[0] === 'user-item-gen-2',
    `[itemId] gen-2 should still await analysis, queue=${JSON.stringify(fixed.pendingUserQueue)}`,
  );
}

// ============================================================================
// Test 6: live partial transcripts (realtime) — 2026-09-09
//
// The plugin streams partial input transcription while the learner speaks.
// These used to be dropped server-side, so words only appeared after the
// turn closed. Now they upsert a dimmed interim bubble that the final
// transcript replaces in place.
// ============================================================================

function testLivePartialTranscript() {
  const state = replay([
    { type: 'user.transcript.partial', ts: 1000, data: { text: 'Estou', itemId: 'gen-1' } },
    { type: 'user.transcript.partial', ts: 1200, data: { text: 'Estou um pouco', itemId: 'gen-1' } },
    { type: 'user.transcript', ts: 1500, data: { text: 'Estou um pouco mal', turnSeq: 1, itemId: 'gen-1' } },
    { type: 'processor.analysis', ts: 2000, data: { turnSeq: 1, itemId: 'gen-1', lexemes: [], srsUpdates: [] } },
  ]);
  const users = state.turns.filter((t) => t.kind === 'user') as UserTurn[];

  assert(users.length === 1, `[partial] expected ONE bubble through the whole span, got ${users.length}`);
  assert(users[0]?.id === 'user-item-gen-1', `[partial] id: ${users[0]?.id}`);
  assert(users[0]?.interim === false, '[partial] bubble must be finalized');
  assert(users[0]?.text === 'Estou um pouco mal', `[partial] final text: "${users[0]?.text}"`);
  assert(users[0]?.hasAnalysis === true, '[partial] analysis should attach to the finalized bubble');
  assert(state.pendingUserQueue.length === 0, `[partial] queue should be drained, got ${JSON.stringify(state.pendingUserQueue)}`);

  // A late partial must never overwrite a finalized turn.
  const after = applyStreamEvent(state, {
    type: 'user.transcript.partial',
    ts: 2500,
    data: { text: 'Estou um pouco mal e', itemId: 'gen-1' },
  });
  const afterUsers = after.turns.filter((t) => t.kind === 'user') as UserTurn[];
  assert(afterUsers[0]?.text === 'Estou um pouco mal', '[partial] late partial ignored after final');

  // Partial-only (no final yet) must not queue for analysis.
  const onlyPartial = replay([
    { type: 'user.transcript.partial', ts: 1, data: { text: 'oi', itemId: 'gen-9' } },
  ]);
  assert(onlyPartial.pendingUserQueue.length === 0, '[partial] partial alone must not queue for analysis');

  // Barge-in: a second span in the same generation carries a suffixed id, so
  // it must create its own bubble rather than being dropped as a duplicate.
  const barge = replay([
    { type: 'user.transcript.partial', ts: 1, data: { text: 'No, I thought', itemId: 'gen-7' } },
    { type: 'user.transcript', ts: 2, data: { text: 'No, I thought it was', turnSeq: 1, itemId: 'gen-7' } },
    { type: 'user.transcript', ts: 3, data: { text: 'Wait, wait, slow down.', turnSeq: 2, itemId: 'gen-7#1' } },
  ]);
  const bargeUsers = barge.turns.filter((t) => t.kind === 'user') as UserTurn[];
  assert(bargeUsers.length === 2, `[partial] barge-in should yield 2 bubbles, got ${bargeUsers.length}`);
  assert(bargeUsers[1]?.id === 'user-item-gen-7#1', `[partial] barge-in id: ${bargeUsers[1]?.id}`);

  // Legacy realtime workers sometimes suffixed the partial id but not the
  // final id. The final must still replace the interim bubble in place.
  const mismatchedIds = replay([
    { type: 'user.transcript.partial', ts: 1, data: { text: 'Я хочу', itemId: 'gen-legacy#1' } },
    { type: 'user.transcript', ts: 2, data: { text: 'Я хочу кофе', turnSeq: 1, itemId: 'gen-legacy' } },
  ]);
  const mismatchedUsers = mismatchedIds.turns.filter((t) => t.kind === 'user') as UserTurn[];
  assert(mismatchedUsers.length === 1, '[partial] suffixed partial id must not create a second bubble');
  assert(mismatchedUsers[0]?.text === 'Я хочу кофе' && mismatchedUsers[0]?.interim === false, '[partial] suffixed partial must finalize in place');
}

function testAgentToolResultDeduplication() {
  const state = replay([
    { type: 'agent.reply', ts: 1000, data: {
      turnSeq: 9,
      itemId: 'tool-item',
      text: 'get_semantic_neighbors Результат: умница (0.165), отлично (0.252).\n\nДа, "молодец" тоже можно.',
    } },
    { type: 'agent.reply', ts: 1100, data: {
      turnSeq: 9,
      itemId: 'spoken-item',
      text: 'Да, "молодец" тоже можно.',
    } },
  ]);
  const agents = state.turns.filter((t) => t.kind === 'agent') as AgentTurn[];
  assert(agents.length === 1, `[tool result] expected one visible bubble, got ${agents.length}`);
  assert(agents[0]?.text === 'Да, "молодец" тоже можно.', '[tool result] internal result should be stripped');
}

function testSessionBoundary() {
  const state = replay([
    { type: 'user.transcript', ts: 1, data: { text: 'old', turnSeq: 1 } },
    { type: 'agent.reply', ts: 2, data: { text: 'old reply', turnSeq: 1 } },
    { type: 'session.start', ts: 3, data: {} },
    { type: 'user.transcript', ts: 4, data: { text: 'new', turnSeq: 1 } },
  ]);
  assert(state.turns.length === 1, `[session] expected old transcript to be cleared, got ${state.turns.length} turns`);
  assert(state.turns[0]?.kind === 'user' && state.turns[0]?.text === 'new', '[session] expected new session turn');
}

// ============================================================================
// Run
// ============================================================================

testNoDuplicateAgentReply();
testDelayedProcessorAnalysisOrdering();
testFallbackFifoMatchingWithoutTurnSeq();
testOverlappingTurnKeepsStableTurnSeq();
testRealtimeItemIdKeying();
testLivePartialTranscript();
testAgentToolResultDeduplication();
testSessionBoundary();

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
