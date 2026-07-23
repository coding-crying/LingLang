/**
 * VoiceControl — push-to-talk / hands-free mic control (Task 5).
 *
 * Replaces the TEMPORARY always-on mic toggle that Task 4b extracted
 * near-verbatim from VoiceRoom.tsx's `CallControls` (see
 * `../tabs/VoiceTab.tsx`'s old `BottomControls`). This is the real design:
 *
 *   - Push to talk (PTT): mic starts MUTED. Press-and-hold enables the
 *     mic; release re-mutes it. This is the behaviorally risky part per
 *     the task-5 brief — muting the mic between turns is new, unexercised
 *     behavior (the backend agent's VAD/turn-detection has, per the user,
 *     only ever been exercised against hands-free/always-on-mic sessions).
 *     This file cannot be smoke-tested against a live LiveKit room/agent
 *     in this environment — see task-5-report.md for exactly what could
 *     and couldn't be verified.
 *   - Hands-free: mic is enabled once, continuously, exactly like the
 *     always-on toggle Task 4b shipped — just re-skinned as a breathing
 *     orb bound to useVoiceAssistant().state instead of a button.
 *
 * Mode state (`ptt` | `handsFree`) is local to the Voice tab per the
 * brief (item 4) — intentionally NOT lifted into global AppState.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionState, useRoomContext, useVoiceAssistant } from '@livekit/components-react';
import { ConnectionState } from 'livekit-client';
import { Button, Switch } from '@heroui/react';

export type VoiceControlMode = 'ptt' | 'handsFree';

interface VoiceControlProps {
  mode: VoiceControlMode;
  onModeChange: (mode: VoiceControlMode) => void;
  /** Optional reason surfaced to the user (e.g. "Agent disconnected — reconnect to continue")
   *  when this fires from the agent-drop watchdog below, rather than the End button. */
  onDisconnect: (reason?: string) => void;
  /** Fired once, at PTT release, with the measured hold duration in ms —
   *  used by VoiceTab to give the very next pending user-turn bubble a
   *  real (rather than ticking-since-arrival-proxy) duration. Not called
   *  in hands-free mode (no discrete "turn" to measure) — VoiceTab's
   *  existing Task 4b ticking-clock proxy is the accepted fallback there,
   *  per the brief's "short fixed placeholder ... matching the existing
   *  behavior" wording. */
  onPttRelease?: (durationMs: number) => void;
}

/**
 * 42x24px track+knob toggle switch, per brief item 1.
 *
 * Re-laid-out (2026-07-04, user feedback): the control bar used to stack
 * mode-switch / PTT-stage / disconnect in three full-width rows, which
 * made the whole bar too tall. Now it's a single row — this component
 * sits in a narrow left column, so it shows the switch plus ONE label for
 * the currently-active mode (not two side-by-side labels) to stay
 * compact; tapping still toggles either way.
 */
function ModeSwitch({ mode, onModeChange }: { mode: VoiceControlMode; onModeChange: (m: VoiceControlMode) => void }) {
  const isHandsFree = mode === 'handsFree';
  return (
    <div className="flex flex-col items-center gap-1">
      <Switch
        aria-label="Toggle push-to-talk / hands-free mode"
        isSelected={isHandsFree}
        size="sm"
        onChange={(selected) => onModeChange(selected ? 'handsFree' : 'ptt')}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
      {/* Fixed width (longest label, "Push to talk") so the side column
          never reflows/shifts the centered PTT stage when the mode
          switches — this is exactly the class of bug flagged in review:
          the switch used to sit in an auto-width column. */}
      <span className="w-[76px] text-center text-xs font-semibold text-foreground">
        {isHandsFree ? 'Hands-free' : 'Push to talk'}
      </span>
    </div>
  );
}

function formatMmSs(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Vertical drag distance (px) past which a held PTT press is considered
// "swiped up to cancel" — matches common messaging-app voice-note gestures.
const CANCEL_SWIPE_PX = 70;

/** PTT circular button: mic starts muted; pointerdown enables + animates,
 *  all release-equivalent pointer events (up/leave/cancel) re-mute.
 *
 *  Swipe-up-to-cancel: dragging the pointer up past CANCEL_SWIPE_PX while
 *  held, then releasing, mutes the mic (same as a normal release) but
 *  skips `onPttRelease` — so VoiceTab never creates/attributes a pending
 *  transcript bubble for that press. IMPORTANT LIMITATION (documented here
 *  because it's not obvious from the UI): unlike a local voice-note
 *  recorder, this mic streams audio to the LiveKit room live, the whole
 *  time it's enabled — there is no local buffer to discard. Cancelling
 *  suppresses the *frontend's* pending-turn UI and stops sending further
 *  audio; it cannot retroactively un-send audio the agent already
 *  received, and the backend's own VAD/turn-detection may still act on
 *  whatever was said before the cancel gesture. This is an honest
 *  best-effort "stop now and don't show it as a turn," not a true undo. */
function PttButton({ onPttRelease }: { onPttRelease?: (durationMs: number) => void }) {
  const room = useRoomContext();
  const [held, setHeld] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [elapsedLabel, setElapsedLabel] = useState('0:00');
  const pressStartRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const cancellingRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against a stray duplicate release event (e.g. both pointerup
  // AND pointerleave firing for the same physical release) re-triggering
  // setMicrophoneEnabled(false) / onPttRelease twice for one press.
  const releasedRef = useRef(true);

  const clearTimer = () => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const handlePress = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    if (!releasedRef.current) return; // already pressed
    // Pointer capture routes subsequent move/up events to this element
    // regardless of where the pointer physically travels, and suppresses
    // pointerleave/pointerout for the duration — without this, dragging up
    // for the cancel gesture exits the button's small hit area and fires
    // pointerleave (our other release trigger), ending the press before
    // the swipe can ever register as "cancelling."
    e.currentTarget.setPointerCapture(e.pointerId);
    releasedRef.current = false;
    setHeld(true);
    setCancelling(false);
    cancellingRef.current = false;
    pressStartRef.current = Date.now();
    startYRef.current = e.clientY;
    setElapsedLabel('0:00');
    void room.localParticipant.setMicrophoneEnabled(true);
    // Tell the agent a hold is in progress (2026-07-11): without this, the
    // agent can't distinguish "final transcript arrived mid-hold, wait for
    // release" from "transcript arrived with nobody holding — commit it or
    // it strands forever" (live: a turn spoken during a hands-free→PTT
    // mode switch was never committed and the agent just went silent).
    void room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: 'hold' })),
      { reliable: true, topic: 'linglang.ptt' },
    );
    clearTimer();
    intervalRef.current = setInterval(() => {
      const start = pressStartRef.current;
      if (start === null) return;
      setElapsedLabel(formatMmSs(Date.now() - start));
    }, 250);
  }, [room]);

  const handleMove = useCallback((e: React.PointerEvent) => {
    if (releasedRef.current || startYRef.current === null) return;
    const dragUp = startYRef.current - e.clientY;
    const nowCancelling = dragUp > CANCEL_SWIPE_PX;
    if (nowCancelling !== cancellingRef.current) {
      cancellingRef.current = nowCancelling;
      setCancelling(nowCancelling);
    }
  }, []);

  const handleRelease = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    if (releasedRef.current) return; // already released — ignore duplicate event
    releasedRef.current = true;
    setHeld(false);
    clearTimer();
    void room.localParticipant.setMicrophoneEnabled(false);
    const start = pressStartRef.current;
    const wasCancelling = cancellingRef.current;
    pressStartRef.current = null;
    startYRef.current = null;
    cancellingRef.current = false;
    setCancelling(false);
    // Tell the agent the press ended (2026-07-10): in PTT mode the agent
    // runs manual turn detection (see the mode message in VoiceControl
    // below) and only commits the user's turn on this signal — without it,
    // server-side VAD used to fire mid-hold on any pause and send the turn
    // while the user was still talking.
    void room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: wasCancelling ? 'cancel' : 'release' })),
      { reliable: true, topic: 'linglang.ptt' },
    );
    if (start !== null && !wasCancelling) onPttRelease?.(Date.now() - start);
  }, [room, onPttRelease]);

  // Safety net: if the component unmounts (e.g. mode switch away from PTT)
  // while still held, make sure the mic doesn't stay stuck enabled and the
  // interval doesn't leak. The mode-switch effect in VoiceControl below
  // also force-mutes on every mode change, but this covers the raw
  // unmount case defensively.
  useEffect(() => {
    return () => {
      clearTimer();
      if (!releasedRef.current) {
        releasedRef.current = true;
        void room.localParticipant.setMicrophoneEnabled(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hint = !held
    ? 'Hold to talk'
    : cancelling
      ? 'Release to cancel'
      : `${elapsedLabel} — release to send · swipe up to cancel`;

  return (
    <div className="voicectl-ptt-wrap">
      {held && !cancelling && (
        <>
          <span className="voicectl-pulse-ring" style={{ animationDelay: '0ms' }} />
          <span className="voicectl-pulse-ring" style={{ animationDelay: '400ms' }} />
        </>
      )}
      <button
        type="button"
        className={`voicectl-ptt-btn ${held ? 'held' : ''} ${cancelling ? 'cancelling' : ''}`}
        onPointerDown={handlePress}
        onPointerMove={handleMove}
        onPointerUp={handleRelease}
        onPointerLeave={handleRelease}
        onPointerCancel={handleRelease}
        onContextMenu={(e) => e.preventDefault()}
        aria-pressed={held}
        aria-label="Hold to talk, swipe up to cancel"
      >
        <span className="voicectl-ptt-bars">
          <span className="voicectl-ptt-bar" style={{ animationDelay: '0ms' }} />
          <span className="voicectl-ptt-bar" style={{ animationDelay: '150ms' }} />
          <span className="voicectl-ptt-bar" style={{ animationDelay: '300ms' }} />
        </span>
      </button>
      <div className={`voicectl-hint ${cancelling ? 'cancelling' : ''}`}>{hint}</div>
    </div>
  );
}

/** Hands-free breathing orb: mic is enabled once (by VoiceControl's
 *  mode-switch effect, below — not duplicated here) and left continuously
 *  on; visual intensity bound to useVoiceAssistant().state (listening/
 *  thinking/speaking) — the same hook AgentVisualizer/BarVisualizer
 *  already use today, no new LiveKit event wiring needed. */
function HandsFreeOrb() {
  const { state } = useVoiceAssistant();

  const labels: Record<string, string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
    'pre-connect-buffering': 'Buffering…',
    initializing: 'Starting…',
    idle: 'Listening',
    listening: 'Listening',
    thinking: 'Thinking…',
    speaking: 'Speaking',
    failed: 'Failed',
  };

  return (
    <div className="voicectl-handsfree-wrap">
      <div className={`voicectl-orb voicectl-orb-${state}`} aria-label="Hands-free — mic always on" />
      <div className="voicectl-hint">{labels[state] ?? state}</div>
    </div>
  );
}

export default function VoiceControl({ mode, onModeChange, onDisconnect, onPttRelease }: VoiceControlProps) {
  const room = useRoomContext();

  // 2026-07-16: recover automatically when the agent's job process dies
  // mid-session (a real, repeatedly-observed backend bug — see
  // tutor-event-driven.ts's stuckWatchdog / linglang-job-watchdog.service —
  // where the agent's job gets killed out from under a live call). Without
  // this, the LiveKit ROOM connection stays nominally "Connected" (the
  // user is still in the room) even after the agent participant is gone,
  // so the UI just sat frozen showing "Listening" forever with no error
  // and no way to reconnect short of reloading the page. useVoiceAssistant
  // ().state becomes 'disconnected'/'failed' once the agent participant
  // leaves — wasAvailableRef distinguishes that from the NORMAL
  // disconnected→connecting→initializing sequence every session starts
  // with, so this only fires for a real mid-session drop, not startup.
  const { state: agentState } = useVoiceAssistant();
  const agentWasAvailableRef = useRef(false);
  useEffect(() => {
    const isAvailable = agentState === 'listening' || agentState === 'thinking'
      || agentState === 'speaking' || agentState === 'idle';
    if (isAvailable) {
      agentWasAvailableRef.current = true;
      return;
    }
    if (agentWasAvailableRef.current && (agentState === 'disconnected' || agentState === 'failed')) {
      console.warn(`[VoiceControl] Agent went "${agentState}" after being available — disconnecting so the user can reconnect`);
      onDisconnect('The tutor disconnected unexpectedly — tap Connect to start a new session.');
    }
  }, [agentState, onDisconnect]);
  // `room` (the Room instance from context) is a stable reference for the
  // lifetime of this component — it does NOT change when the room finishes
  // connecting. So an effect keyed only on `[mode, room]` runs exactly once
  // at mount (before the room has connected) and then only again on mode
  // switches — it would NEVER re-run just because the connection completed.
  // That was the bug: LiveKitRoom (in VoiceTab.tsx) used to independently
  // re-enable the mic itself when its own `SignalConnected` listener fired
  // post-connect, with nothing here to re-assert the mode's intended state
  // afterward. Now that VoiceTab.tsx no longer passes `audio={true}` (so
  // nothing auto-enables the mic), this effect must instead be the thing
  // that (re)applies mic state once the room actually finishes connecting —
  // so it's keyed on `connectionState` too, gated to only act once
  // `Connected`, guaranteeing it fires (at least once) strictly after
  // signaling/track-publish machinery is ready, superseding any leftover
  // pre-connect state.
  const connectionState = useConnectionState(room);

  // On mount AND on every mode switch AND once the room finishes connecting:
  // force the mic into the correct starting state for the new mode. This is
  // what makes "switch FROM hands-free TO PTT" mute immediately (rather than
  // leaving the mic open until the next press), what makes PTT always start
  // muted rather than inheriting whatever state the previous mode left the
  // mic in, and — critically — what makes hands-free mode's mic actually end
  // up ON once the room is connected (calling setMicrophoneEnabled before
  // the room has a live connection is unreliable; LiveKit's own LiveKitRoom
  // internals wait for `SignalConnected` for exactly this reason).
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return;
    if (mode === 'ptt') {
      void room.localParticipant.setMicrophoneEnabled(false);
    } else {
      void room.localParticipant.setMicrophoneEnabled(true);
    }
    // Tell the agent which turn-taking regime to run (2026-07-10): 'ptt'
    // → manual turn detection on the agent (turn commits only on the
    // release message from PttButton); 'handsFree' → back to automatic
    // VAD/EOU detection. Sent on connect and on every mode switch.
    void room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: 'mode', mode })),
      { reliable: true, topic: 'linglang.ptt' },
    );
  }, [mode, room, connectionState]);

  return (
    <div className="voicectl">
      <div className="voicectl-side voicectl-side-left">
        <ModeSwitch mode={mode} onModeChange={onModeChange} />
      </div>
      <div className="voicectl-stage">
        {mode === 'ptt' ? <PttButton onPttRelease={onPttRelease} /> : <HandsFreeOrb />}
      </div>
      <div className="voicectl-side voicectl-side-right">
        <Button variant="danger" size="sm" onPress={() => onDisconnect()}>
          End
        </Button>
      </div>
    </div>
  );
}
