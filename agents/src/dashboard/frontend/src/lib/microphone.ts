/**
 * Microphone preflight for the voice room.
 *
 * Why this exists: microphone acquisition happened through LiveKit/VoiceControl
 * after requesting a room token, without this explicit permission preflight. LiveKitRoom connects happily with the mic
 * denied (it connects with a muted track, and VoiceControl is the only thing
 * that later calls setMicrophoneEnabled), so a user who blocked the browser's
 * permission prompt — or whose audio input is held by Zoom, or who opened the
 * page over plain http on a LAN IP, where mediaDevices is undefined entirely —
 * got a room that CONNECTED, played the tutor's greeting perfectly, and then
 * silently ignored everything they said. No error, no transcript, no clue.
 * That reads as "the app is broken", and for a new user it is unfixable
 * without knowing which of those four things went wrong.
 *
 * So: acquire the mic once, up front, and release it immediately. The audio
 * from this call is thrown away — LiveKit opens its own track on connect.
 * The call exists purely to (a) surface the permission prompt at a moment
 * where we can react to it and (b) turn a rejection into an instruction.
 */

/** Map a getUserMedia rejection to something a non-technical user can act on. */
export function describeMicFailure(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return "Your browser is blocking the microphone. Click the padlock (or mic icon) in the address bar, set Microphone to Allow, then press Connect again.";
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Check that a mic or headset is plugged in and selected as your input device, then press Connect again.';
    case 'NotReadableError':
      return 'Your microphone is being used by another app or tab (Zoom, Teams, Meet…). Close it and press Connect again.';
    case 'AbortError':
      return 'The microphone request was interrupted. Press Connect to try again.';
    default:
      return `Could not start your microphone${name ? ` (${name})` : ''}. Check your browser's microphone permission, then press Connect again.`;
  }
}

/**
 * Ensure we can actually capture audio before we spend a room token on it.
 * Returns null when we're good to connect, or a user-facing message.
 */
export async function requestMicrophone(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    // The usual cause is a non-secure origin: getUserMedia is only defined on
    // https:// and localhost. Self-hosters hit this constantly by opening the
    // dashboard at http://<lan-ip>:8392, where the failure is silent.
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return 'Microphone access needs a secure connection. Open this page over https:// (or on localhost), then press Connect again.';
    }
    return 'This browser can’t access the microphone. Try Chrome, Edge, Firefox or Safari on desktop, or Safari/Chrome on your phone.';
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (err) {
    return describeMicFailure(err);
  }
}

/**
 * True when the browser has already granted mic access, so the caller can
 * avoid a redundant prompt. Never throws; false is the safe answer.
 */
export async function hasMicPermission(): Promise<boolean> {
  try {
    const perms = (navigator as { permissions?: Permissions }).permissions;
    if (!perms?.query) return false;
    const status = await perms.query({ name: 'microphone' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false;
  }
}
