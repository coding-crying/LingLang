import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueVoiceTicket, verifyVoiceTicket } from './pipecat-session-ticket.js';
const secret = 'test-only-signing-secret-32-characters-long';
const scope = { sessionId: 'session-1', userId: 'fixture-user', language: 'ar', transport: 'smallwebrtc' as const };
test('ticket preserves server-selected identity and transport, with bounded expiry', () => {
 const ticket = issueVoiceTicket(scope, secret, 1000);
 assert.deepEqual(verifyVoiceTicket(ticket, secret, 1001), {...scope, purpose:'pipecat-session', version:1, issuedAt:1000, expiresAt:1060});
 assert.throws(()=>verifyVoiceTicket(ticket,secret,1060));
 assert.throws(()=>verifyVoiceTicket(ticket,secret,999));
});
test('forged identity, wrong secret and malformed tickets fail closed', () => {
 const ticket=issueVoiceTicket(scope,secret,1000);
 const [body,signature]=ticket.split('.');
 const altered=JSON.parse(Buffer.from(body!,'base64url').toString());altered.userId='victim';
 assert.throws(()=>verifyVoiceTicket(Buffer.from(JSON.stringify(altered)).toString('base64url')+'.'+signature,secret,1001));
 assert.throws(()=>verifyVoiceTicket(ticket,secret+'wrong',1001));
 for(const bad of ['', 'abc', ticket+'.extra', 'x'.repeat(8193)]) assert.throws(()=>verifyVoiceTicket(bad,secret,1001));
});
test('issuer rejects weak secrets and invalid scope rather than guessing identity', () => {
 assert.throws(()=>issueVoiceTicket(scope,'short',1000));
 assert.throws(()=>issueVoiceTicket({...scope,userId:''},secret,1000));
 assert.throws(()=>issueVoiceTicket({...scope,transport:'anything' as any},secret,1000));
});
