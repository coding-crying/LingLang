import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VoiceSessionScope {
  sessionId: string;
  userId: string;
  language: string;
  transport: 'smallwebrtc' | 'livekit';
}
export interface VoiceSessionTicket extends VoiceSessionScope {
  purpose: 'pipecat-session';
  version: 1;
  issuedAt: number;
  expiresAt: number;
}
const TTL_SECONDS = 60;
function fail(): never { throw new Error('Invalid or expired voice session ticket'); }
function checkSecret(secret: string) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)
    throw new Error('Voice session signing secret must be at least 32 bytes');
}
function validScope(value: any): value is VoiceSessionScope {
  return value && ['sessionId', 'userId', 'language'].every(key =>
    typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256 && !/[\x00-\x1f]/.test(value[key])) &&
    ['smallwebrtc', 'livekit'].includes(value.transport);
}
function sign(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update('linglang-voice-v1.' + body).digest();
}
/** Issue only after dashboard authentication. Contains no provider credentials.
 * This is a short-lived bootstrap credential, NOT worker authority for events.
 * The session store must atomically claim it once and reject closed/deleted sessions.
 */
export function issueVoiceTicket(scope: VoiceSessionScope, secret: string, now = Math.floor(Date.now()/1000)): string {
  checkSecret(secret);
  if (!validScope(scope) || !Number.isSafeInteger(now) || now < 0) fail();
  const payload: VoiceSessionTicket = {
    sessionId: scope.sessionId, userId: scope.userId, language: scope.language, transport: scope.transport,
    purpose:'pipecat-session', version:1, issuedAt:now, expiresAt:now + TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret).toString('base64url')}`;
}
export function verifyVoiceTicket(ticket: string, secret: string, now = Math.floor(Date.now()/1000)): VoiceSessionTicket {
  checkSecret(secret);
  if (typeof ticket !== 'string' || ticket.length > 8192 || !Number.isSafeInteger(now)) fail();
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!match) fail();
  const body = match[1]!;
  const signature = Buffer.from(match[2]!, 'base64url');
  const expected = sign(body, secret);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) fail();
  let value: VoiceSessionTicket;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { fail(); }
  if (!validScope(value) || value.purpose !== 'pipecat-session' || value.version !== 1 ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt !== value.issuedAt + TTL_SECONDS || now < value.issuedAt || now >= value.expiresAt) fail();
  return value;
}
