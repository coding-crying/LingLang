// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationRouter } from './conversation-api.js';

test('archive reads derive owner from auth, validate cursors, and never cache private content', async () => {
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers['x-fixture-user']) (req as any).user = { id: 'alice' };
    next();
  });
  const calls: unknown[][] = [];
  app.use(
    createConversationRouter({
      sessions: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
      events: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal((await fetch(base)).status, 401);
    const response = await fetch(`${base}/?userId=bob`, { headers: { 'x-fixture-user': 'alice' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(calls[0]?.[0], 'alice');
    assert.equal(
      (await fetch(`${base}/session?after=wat`, { headers: { 'x-fixture-user': 'alice' } })).status,
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
