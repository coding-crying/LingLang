/**
 * VoiceControl — push-to-talk / hands-free mic control.
 *
 * 2026-09-26 (usability pass, user feedback: "the hands free and push to
 * talk modes could feel better now"):
 *
 *   1. MODE SELECTION is two always-visible, LABELLED buttons
 *      ("Hold to talk" / "Hands-free") instead of a switch whose single
 *      label flipped to whatever mode you were in — the old control never
 *      showed both options, so the alternative was invisible, and the
 *      switch had no accessible name for the choice itself. The buttons
 *      are 44px tall, `aria-pressed`-driven, and sit in one column beside
 *      the stage.
 *   2. MIC STATUS is REAL, not decorative. The status line and the
 *      hands-free ring are driven by `useLocalParticipant()
 *      .isMicrophoneEnabled` and the actual input level from
 *      `useTrackVolume()`; the PTT bars show the learner's real level
 *      (resting low on a silent mic) rather than a looping animation. The
 *      text helpers live in `../lib/mic-status.ts` and are unit-tested so
 *      the UI can never claim "Mic live" over a muted mic.
 *   3. The 72px decorative breathing orb is gone — the hands-free stage now
 *      shows a 64px ring that is an input-level meter with the true mic
 *      state inside it.
 *
 * UNCHANGED (deliberately): mic SAFETY and the single control path.
 *   - PTT still starts muted, enables on press, re-mutes on every release
 *     event (up/leave/cancel), and force-mutes on unmount.
 *   - VoiceControl's connectionState-gated effect is still the SOLE
 *     authority that applies mic state on connect and on mode switch, and
 *     it still publishes the same `linglang.ptt` mode/hold/release/cancel
 *     messages to the agent. No new provider, prompt or backend behaviour.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useConnectionState, useLocalParticipant, useRoomContext, useTrackVolume, useVoiceAssistant } from '@livekit/components-react';
import { ConnectionState } from 'livekit-client';
import { Button, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { Ear, Hand, Mic, MicOff, PhoneOff } from 'lucide-react';
import { barScale, inputLevelPercent, micStatusText, micStatusTone } from '../lib/mic-status';

export type VoiceControlMode = 'ptt' | 'handsFree';

interface VoiceControlProps {
  mode: VoiceControlMode;
  onModeChange: (mode: VoiceControlMode) => void;
  /** Optional reason surfaced to the user (e.g. "Agent disconnected — reconnect to continue")
   *  when this fires from the agent-drop watchdog below, rather than the End button. */
  onDisconnect: (reason?: string) => void;
  /** Fired once, at PTT release, with the measured hold duration in ms — used
   *  by VoiceTab to give the very next pending user-turn bubble a real
   *  (rather than ticking-since-arrival-proxy) duration. Not called in
   *  hands-free mode (no discrete "turn" to measure). */
  onPttRelease?: (durationMs: number) => void;
}

/** Both modes, always visible, each with its own label and 44px target. */
function ModeSelect({
  mode,
  onModeChange,
}: {
  mode: VoiceControlMode;
  onModeChange: (m: VoiceControlMode) => void;
}) {
  return (
    <ToggleButtonGroup
      selectionMode="single"
      orientation="vertical"
      isDetached
      aria-label="Microphone mode"
      className="voicectl-modes"
      selectedKeys={new Set([mode])}
      onSelectionChange={(keys) => {
        // Ignore an empty selection (react-aria allows deselecting a single
        // selection group) — a mic mode must always be one of the two.
        const next = [...keys][0];
        if (next === 'ptt' || next === 'handsFree') onModeChange(next);
      }}
    >
      <ToggleButton id="ptt" variant="ghost" className="voicectl-mode-btn">
        <Hand size={15} aria-hidden="true" />
        <span>Hold to talk</span>
      </ToggleButton>
      <ToggleButton id="handsFree" variant="ghost" className="voicectl-mode-btn">
        <Ear size={15} aria-hidden="true" />
        <span>Hands-free</span>
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

function formatMmSs(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Shared status line. `role="status"` so a screen reader hears mode and mic
 *  transitions; the ticking hold clock inside it is `aria-hidden` so it does
 *  not announce every 250ms. */
function StatusLine({
  mode,
  micEnabled,
  holding,
  cancelling,
  agentState,
  clock,
}: {
  mode: VoiceControlMode;
  micEnabled: boolean;
  holding: boolean;
  cancelling: boolean;
  agentState: string;
  clock?: string;
}) {
  const input = { mode, micEnabled, holding, cancelling, agentState };
  return (
    <div className="voicectl-status" data-tone={micStatusTone(input)} role="status">
      {clock ? <span className="mono voicectl-status-clock" aria-hidden="true">{clock} · </span> : null}
      {micStatusText(input)}
    </div>
  );
}

// Vertical drag distance (px) past which a held PTT press is considered
// "swiped up to cancel" — matches common messaging-app voice-note gestures.
const CANCEL_SWIPE_PX = 70;

/** PTT circular button: mic starts muted; pointerdown enables + animates,
 *  all release-equivalent pointer events (up/leave/cancel) re-mute.
 *
 *  Swipe-up-to-cancel: dragging the pointer up past CANCEL_SWIPE_PX while
 *  held, then releasing, mutes the mic (same as a normal release) but skips
 *  `onPttRelease` — so VoiceTab never creates/attributes a pending
 *  transcript bubble for that press. IMPORTANT LIMITATION (documented here
 *  because it's not obvious from the UI): unlike a local voice-note
 *  recorder, this mic streams audio to the LiveKit room live, the whole
 *  time it's enabled — there is no local buffer to discard. Cancelling
 *  suppresses the *frontend's* pending-turn UI and stops sending further
 *  audio; it cannot retroactively un-send audio the agent already received,
 *  and the backend's own VAD/turn-detection may still act on whatever was
 *  said before the cancel gesture. This is an honest best-effort "stop now
 *  and don't show it as a turn," not a true undo. */
function PttButton({
  onPttRelease,
  micEnabled,
  agentState,
  level,
}: {
  onPttRelease?: (durationMs: number) => void;
  micEnabled: boolean;
  agentState: string;
  level: number;
}) {
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
        className={`voicectl-ptt-btn ${held ? 'held' : ''} ${cancelling ? 'cancelling' : ''} ${
          !held && micEnabled ? 'unexpected-live' : ''
        }`}
        onPointerDown={handlePress}
        onPointerMove={handleMove}
        onPointerUp={handleRelease}
        onPointerLeave={handleRelease}
        onPointerCancel={handleRelease}
        onContextMenu={(e) => e.preventDefault()}
        aria-pressed={held}
        aria-label="Hold to talk, swipe up to cancel"
      >
        {/* Bars are the learner's REAL input level (0 while muted), not a
            looping animation: on a silent mic they rest at their baseline. */}
        <span className="voicectl-ptt-bars" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="voicectl-ptt-bar"
              style={{ transform: `scaleY(${barScale(held ? level : 0, i, 3)})` }}
            />
          ))}
        </span>
      </button>
      <StatusLine
        mode="ptt"
        micEnabled={micEnabled}
        holding={held}
        cancelling={cancelling}
        agentState={agentState}
        clock={held ? elapsedLabel : undefined}
      />
    </div>
  );
}

/** Hands-free stage: mic is enabled once (by VoiceControl's mode-switch
 *  effect below — not duplicated here) and left continuously on. The ring is
 *  a real input-level meter (conic fill = `useTrackVolume()`), with the
 *  actual mic state inside it — replacing the old decorative breathing orb. */
function HandsFreeStage({
  micEnabled,
  agentState,
  level,
}: {
  micEnabled: boolean;
  agentState: string;
  level: number;
}) {
  const pct = inputLevelPercent(level);
  return (
    <div className="voicectl-handsfree-wrap">
      <div
        className="voicectl-ring"
        data-on={micEnabled ? 'true' : 'false'}
        style={{ '--ll-mic-level': `${micEnabled ? pct : 0}%` } as CSSProperties}
        role="img"
        aria-label={
          micEnabled
            ? `Hands-free microphone live, input level ${pct} percent`
            : 'Hands-free microphone is off'
        }
      >
        {micEnabled ? <Mic size={20} aria-hidden="true" /> : <MicOff size={20} aria-hidden="true" />}
      </div>
      <StatusLine
        mode="handsFree"
        micEnabled={micEnabled}
        holding={false}
        cancelling={false}
        agentState={agentState}
      />
    </div>
  );
}

export default function VoiceControl({ mode, onModeChange, onDisconnect, onPttRelease }: VoiceControlProps) {
  const room = useRoomContext();

  // Real mic state + real input level (both from the live LiveKit track).
  const { isMicrophoneEnabled, microphoneTrack } = useLocalParticipant();
  const level = useTrackVolume(microphoneTrack?.audioTrack);

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
    <div className="voicectl" data-mode={mode}>
      <div className="voicectl-side voicectl-side-left">
        <ModeSelect mode={mode} onModeChange={onModeChange} />
      </div>
      <div className="voicectl-stage">
        {mode === 'ptt' ? (
          <PttButton
            onPttRelease={onPttRelease}
            micEnabled={isMicrophoneEnabled}
            agentState={agentState}
            level={level}
          />
        ) : (
          <HandsFreeStage micEnabled={isMicrophoneEnabled} agentState={agentState} level={level} />
        )}
      </div>
      <div className="voicectl-side voicectl-side-right">
        <Button variant="danger" className="voicectl-end" onPress={() => onDisconnect()}>
          <PhoneOff size={16} aria-hidden="true" />
          End
        </Button>
      </div>
    </div>
  );
}