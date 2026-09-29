import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../../../');
const server = readFileSync(resolve(root, 'src/dashboard/server.ts'), 'utf8');
const voiceTab = readFileSync(
  resolve(root, 'src/dashboard/frontend/src/tabs/VoiceTab.tsx'),
  'utf8',
);
const stream = readFileSync(
  resolve(root, 'src/dashboard/frontend/src/hooks/useConversationStream.ts'),
  'utf8',
);

assert.match(server, /sessionId query parameter is required/);
assert.match(server, /sessionId does not belong to the authenticated user/);
assert.match(server, /event\.sessionId !== requestedSessionId/);
assert.match(server, /eventSessionId: `room-\$\{roomName\}-\$\{userId\}`/);
assert.match(voiceTab, /useConversationStream\(eventSessionId\)/);
assert.match(voiceTab, /setEventSessionId\(sid\)/);
assert.match(
  stream,
  /apiEventSource\(`\/api\/events\?sessionId=\$\{encodeURIComponent\(sessionId\)\}`\)/,
);
assert.match(stream, /es\.onerror/);

console.log('session-scoped SSE contract: 8 assertions passed');
