// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { packetSchema } from './contract.js';
import { observe } from './observer.js';

const packet = packetSchema.parse({
  userId: 'u',
  sessionId: 's',
  turnId: 'l',
  language: 'pt',
  source: 'typed',
  occurredAt: '2026-09-10T12:00:00Z',
  turns: [
    { id: 't', role: 'tutor', text: 'Say café.' },
    { id: 'l', role: 'learner', text: 'café' },
  ],
});
test('HTTP observer grounds real transport responses and rejects hallucinated quotes', async () => {
  let invented = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const request = JSON.parse(body);
    assert.match(request.messages[0].content, /unavailable/);
    assert.match(request.messages[1].content, /Say café/);
    assert.equal(request.response_format.type, 'json_schema');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                observations: [
                  {
                    lemma: 'café',
                    form: 'café',
                    language: 'pt',
                    kind: 'production',
                    assistance: 'answer_supplied',
                    outcome: 'succeeded',
                    errorDomain: 'none',
                    fluency: 'unavailable',
                    ambiguity: null,
                    evidence: [{ turnId: 'l', quote: invented ? 'banana' : 'café' }],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = (ms) => {
    timeouts.push(ms);
    return originalTimeout(ms);
  };
  try {
    const endpoint = { url: `http://127.0.0.1:${addr.port}/v1`, model: 'fixture', key: 'secret' };
    const result = await observe(packet, endpoint);
    assert.equal(result.status, 'accepted');
    assert.equal(timeouts[0], 45_000, 'background budget covers measured provider tail latency');
    assert.equal(result.observations[0]?.assistance, 'answer_supplied');
    assert.ok(!JSON.stringify(result).includes('secret'));
    invented = true;
    assert.equal((await observe(packet, endpoint)).status, 'rejected');
  } finally {
    AbortSignal.timeout = originalTimeout;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
