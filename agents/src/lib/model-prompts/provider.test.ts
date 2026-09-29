// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectBounded } from './provider.js';

test('connecting realtime calls obey cancellation and close late sockets', async () => {
  const controller = new AbortController();
  let resolve!: (session: { close(): void }) => void;
  let closed = false;
  const result = connectBounded(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    controller.signal,
    1000,
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(result);
  resolve({
    close() {
      closed = true;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closed, true);
});
test('realtime connection timeout is bounded even before a session exists', async () => {
  await assert.rejects(
    connectBounded(() => new Promise(() => {}), new AbortController().signal, 5),
    /timed out/,
  );
});
