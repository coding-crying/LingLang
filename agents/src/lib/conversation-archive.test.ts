// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConversationArchive, type ConversationEvent } from './conversation-archive.js';

test('duplicate finals share identity; corrections and rejections retain separate provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-revisions-'));
  const events: ConversationEvent[] = [];
  const archive = new ConversationArchive(directory, async (e) => {
    events.push(e);
  });
  const turn = {
    userId: 'fixture',
    sessionId: 'session',
    turnId: 'u1',
    language: 'es',
    occurredAt: '2026-09-18T00:00:00.000Z',
    source: 'test',
    interrupted: null,
    role: 'learner' as const,
    text: 'holá',
    status: 'final' as const,
  };
  const id = await archive.record(turn);
  assert.equal(await archive.record({ ...turn, occurredAt: '2026-09-18T00:00:01.000Z' }), id);
  await archive.record({ ...turn, text: 'hola', status: 'corrected', revisionOf: id });
  await archive.record({ ...turn, status: 'rejected', reason: 'tutor echo', revisionOf: id });
  await archive.drain();
  assert.equal(events.length, 3);
  assert.equal(events.filter((e) => e.revisionOf === id).length, 2);
  await assert.rejects(archive.record({ ...turn, text: '' }), /Invalid/);
});

test('a failed sink retains both roles durably through recorder restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-outbox-'));
  const received: ConversationEvent[] = [];
  const broken = new ConversationArchive(directory, async () => {
    throw new Error('offline');
  });
  const base = {
    userId: 'fixture',
    sessionId: 'session',
    language: 'es',
    occurredAt: '2026-09-18T00:00:00.000Z',
    source: 'test',
    interrupted: false,
  };
  await broken.record({ ...base, turnId: 'u1', role: 'learner', text: 'Hola', status: 'final' });
  await broken.record({ ...base, turnId: 'a1', role: 'tutor', text: 'Hello', status: 'final' });
  assert.equal((await broken.drain()).pending, 2);
  for (const file of await readdir(directory))
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  const restarted = new ConversationArchive(directory, async (event) => {
    received.push(event);
  });
  assert.deepEqual(await restarted.drain(), { delivered: 2, pending: 0 });
  assert.deepEqual(new Set(received.map((e) => e.role)), new Set(['learner', 'tutor']));
});
