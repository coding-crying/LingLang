/**
 * Pure mic-status logic for VoiceControl (Task: hands-free/PTT usability).
 *
 * Split out of the component so the *honesty* property can be unit-tested
 * without a browser: the status text must never claim the microphone is live
 * when LiveKit reports it is not, and must never claim it is muted when it
 * is actually on. The component feeds these functions the REAL
 * `useLocalParticipant().isMicrophoneEnabled` value and the REAL
 * `useVoiceAssistant().state` — nothing here guesses.
 *
 * No mic control lives in this file. Enabling/muting the microphone is still
 * owned solely by VoiceControl's connectionState-gated effect and
 * PttButton's pointer handlers (one pipeline controls the mic).
 */

export type VoiceControlMode = 'ptt' | 'handsFree';

export type MicStatusTone = 'idle' | 'live' | 'warn';

export interface MicStatusInput {
  mode: VoiceControlMode;
  /** LiveKit's actual local-participant mic state, not an assumption. */
  micEnabled: boolean;
  /** PTT pointer is down. */
  holding: boolean;
  /** PTT press has been swiped past the cancel threshold. */
  cancelling: boolean;
  /** Agent turn state from useVoiceAssistant().state. */
  agentState: string;
}

const AGENT_LABELS: Record<string, string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  'pre-connect-buffering': 'buffering…',
  initializing: 'starting…',
  idle: 'listening',
  listening: 'listening',
  thinking: 'thinking…',
  speaking: 'speaking',
  failed: 'failed',
};

export function agentStateLabel(state: string): string {
  return AGENT_LABELS[state] ?? state;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Status line shown under the control. One line, one source of truth: the
 * mic clause is derived from `micEnabled`, the rest from mode/hold/agent.
 */
export function micStatusText(i: MicStatusInput): string {
  if (i.mode === 'ptt') {
    if (i.holding) {
      if (!i.micEnabled) return i.cancelling ? 'Mic off · release to cancel' : 'Opening microphone…';
      return i.cancelling ? 'Mic live · release to cancel' : 'Mic live · release to send';
    }
    // Not holding in PTT: the mic is supposed to be muted. If it is not,
    // say so plainly rather than pretending.
    return i.micEnabled ? 'Mic still live · release to mute' : 'Mic muted · hold to talk';
  }
  if (!i.micEnabled) {
    return 'Mic is off · allow the microphone, then pick Hands-free';
  }
  return `Mic live · ${agentStateLabel(i.agentState)}`;
}

export function micStatusTone(i: MicStatusInput): MicStatusTone {
  if (i.mode === 'ptt') {
    if (i.holding) return i.micEnabled ? 'live' : 'warn';
    return i.micEnabled ? 'warn' : 'idle';
  }
  return i.micEnabled ? 'live' : 'warn';
}

/** Real input level (0..1 from useTrackVolume) as a rounded 0..100 percent. */
export function inputLevelPercent(level: number): number {
  return Math.round(clamp01(level) * 100);
}

/**
 * Per-bar scale for the PTT button's meter, so the bars show the learner's
 * ACTUAL input level (taller in the middle, shorter at the edges) instead of
 * a decorative loop animation. A silent mic leaves the bars at the resting
 * height — which is the honest reading.
 */
export function barScale(level: number, index: number, count: number): number {
  const l = clamp01(level);
  const center = (count - 1) / 2;
  const distance = center === 0 ? 0 : Math.abs(index - center) / center;
  const shape = 1 - 0.4 * distance;
  return Number(Math.min(1, Math.max(0.18, l * shape * 1.15)).toFixed(3));
}