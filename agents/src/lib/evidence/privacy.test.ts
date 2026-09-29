// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { packetSchema } from './contract.js';
import { observe } from './observer.js';
import { embedEpisode } from './retrieval.js';

test('assessment and local-only embedding never forward episode bodies through redirects', async () => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirect-target') {
      redirected++;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"observations":[]}' } }],
          data: [{ embedding: [1, 0] }],
        }),
      );
    } else {
      res.writeHead(307, { Location: '/redirect-target' });
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/v1`;
  const prior = process.env.EMBED_URL;
  const p = packetSchema.parse({
    userId: 'fixture',
    sessionId: 's',
    turnId: 'l',
    language: 'pt',
    occurredAt: '2026-09-10T00:00:00Z',
    source: 'typed',
    turns: [{ id: 'l', role: 'learner', text: 'café' }],
  });
  try {
    assert.equal((await observe(p, { url, key: 'fixture', model: 'fixture' })).status, 'error');
    process.env.EMBED_URL = `${url}/embeddings`;
    assert.equal(await embedEpisode(p), null);
    assert.equal(redirected, 0);
  } finally {
    if (prior === undefined) delete process.env.EMBED_URL;
    else process.env.EMBED_URL = prior;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
