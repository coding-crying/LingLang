// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvidenceRouter } from './api.js';

test('evidence API rejects unauthenticated reads and ignores caller-supplied tenant IDs', async () => {
  const app = express();
  const seen: string[] = [];
  app.use((req, _res, next) => {
    if (req.headers['x-fixture-user']) Object.assign(req, { user: { id: 'owner' } });
    next();
  });
  app.use(
    '/api/learning-evidence',
    createEvidenceRouter(
      async (uid) => {
        seen.push(uid);
        return [];
      },
      () => 'shadow',
    ),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const url = `http://127.0.0.1:${addr.port}/api/learning-evidence`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(`${url}?userId=victim&language=pt`, {
      headers: { 'x-fixture-user': 'owner' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ['owner']);
    assert.equal((await response.json()).mode, 'shadow');
    assert.equal(
      (await fetch(`${url}?language=../../`, { headers: { 'x-fixture-user': 'owner' } })).status,
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
