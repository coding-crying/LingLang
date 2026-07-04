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

export type VoiceControlMode = 'ptt' | 'handsFree';

interface VoiceControlProps {
  mode: VoiceControlMode;
  onModeChange: (mode: VoiceControlMode) => void;
  onDisconnect: () => void;
  /** Fired once, at PTT release, with the measured hold duration in ms —
   *  used by VoiceTab to give the very next pending user-turn bubble a
   *  real (rather than ticking-since-arrival-proxy) duration. Not called
   *  in hands-free mode (no discrete "turn" to measure) — VoiceTab's
   *  existing Task 4b ticking-clock proxy is the accepted fallback there,
   *  per the brief's "short fixed placeholder ... matching the existing
   *  behavior" wording. */
  onPttRelease?: (durationMs: number) => void;
}

/** 42x24px track+knob toggle switch, per brief item 1. */
function ModeSwitch({ mode, onModeChange }: { mode: VoiceControlMode; onModeChange: (m: VoiceControlMode) => void }) {
  const isHandsFree = mode === 'handsFree';
  return (
    <div className="voicectl-modeswitch">
      <span className={`voicectl-modelabel ${!isHandsFree ? 'active' : ''}`}>Push to talk</span>
      <button
        type="button"
        role="switch"
        aria-checked={isHandsFree}
        aria-label="Toggle push-to-talk / hands-free mode"
        className="voicectl-switch"
        onClick={() => onModeChange(isHandsFree ? 'ptt' : 'handsFree')}
      >
        <span className="voicectl-switch-track" data-on={isHandsFree}>
          <span className="voicectl-switch-knob" data-on={isHandsFree} />
        </span>
      </button>
      <span className={`voicectl-modelabel ${isHandsFree ? 'active' : ''}`}>Hands-free</span>
    </div>
  );
}

function formatMmSs(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** PTT circular button: mic starts muted; pointerdown enables + animates,
 *  all release-equivalent pointer events (up/leave/cancel) re-mute. */
function PttButton({ onPttRelease }: { onPttRelease?: (durationMs: number) => void }) {
  const room = useRoomContext();
  const [held, setHeld] = useState(false);
  const [elapsedLabel, setElapsedLabel] = useState('0:00');
  const pressStartRef = useRef<number | null>(null);
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
    releasedRef.current = false;
    setHeld(true);
    pressStartRef.current = Date.now();
    setElapsedLabel('0:00');
    void room.localParticipant.setMicrophoneEnabled(true);
    clearTimer();
    intervalRef.current = setInterval(() => {
      const start = pressStartRef.current;
      if (start === null) return;
      setElapsedLabel(formatMmSs(Date.now() - start));
    }, 250);
  }, [room]);

  const handleRelease = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    if (releasedRef.current) return; // already released — ignore duplicate event
    releasedRef.current = true;
    setHeld(false);
    clearTimer();
    void room.localParticipant.setMicrophoneEnabled(false);
    const start = pressStartRef.current;
    pressStartRef.current = null;
    if (start !== null) onPttRelease?.(Date.now() - start);
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
      {held && (
        <>
          <span className="voicectl-pulse-ring" style={{ animationDelay: '0ms' }} />
          <span className="voicectl-pulse-ring" style={{ animationDelay: '400ms' }} />
        </>
      )}
      <button
        type="button"
        className={`voicectl-ptt-btn ${held ? 'held' : ''}`}
        onPointerDown={handlePress}
        onPointerUp={handleRelease}
        onPointerLeave={handleRelease}
        onPointerCancel={handleRelease}
        onContextMenu={(e) => e.preventDefault()}
        aria-pressed={held}
        aria-label="Hold to talk"
      >
        <span className="voicectl-ptt-bars">
          <span className="voicectl-ptt-bar" style={{ animationDelay: '0ms' }} />
          <span className="voicectl-ptt-bar" style={{ animationDelay: '150ms' }} />
          <span className="voicectl-ptt-bar" style={{ animationDelay: '300ms' }} />
        </span>
      </button>
      <div className="voicectl-hint">{held ? `${elapsedLabel} — release to send` : 'Hold to talk'}</div>
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
  }, [mode, room, connectionState]);

  return (
    <div className="voicectl">
      <ModeSwitch mode={mode} onModeChange={onModeChange} />
      <div className="voicectl-stage">
        {mode === 'ptt' ? <PttButton onPttRelease={onPttRelease} /> : <HandsFreeOrb />}
      </div>
      <button type="button" className="btn-danger voicectl-disconnect" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}
