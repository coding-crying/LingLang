// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import postgres from 'postgres';
import { packetSchema } from './contract.js';
import { runShadow } from './service.js';
import { EvidenceStore } from './store.js';

dotenv.config({ path: '.env.local', quiet: true });
test('complete HTTP observer → PostgreSQL → scoped read path retains evidence without touching vocabulary', async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  let calls = 0;
  const observation = {
    lemma: 'café',
    form: 'café',
    language: 'pt',
    kind: 'production',
    assistance: 'none',
    outcome: 'succeeded',
    errorDomain: 'none',
    fluency: 'unavailable',
    ambiguity: null,
    evidence: [
      { turnId: 'l', quote: 'café' },
      { turnId: 't', quote: 'What would you like?' },
    ],
  };
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ observations: [observation] }) },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    model: 'test-fixture',
    key: '',
  };
  const rollback = new Error('intentional rollback');
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(await readFile('drizzle/0020_learning_evidence.sql', 'utf8'));
      const uid = `evidence-pipeline-${crypto.randomUUID()}`;
      await tx`INSERT INTO users(id) VALUES (${uid})`;
      const store = new EvidenceStore(tx);
      const p = packetSchema.parse({
        userId: uid,
        sessionId: 's',
        turnId: 'l',
        language: 'pt',
        source: 'typed',
        occurredAt: new Date().toISOString(),
        turns: [
          { id: 't', role: 'tutor', text: 'What would you like?' },
          { id: 'l', role: 'learner', text: 'Eu quero café.' },
        ],
      });
      assert.equal((await runShadow(p, endpoint, { mode: 'off', store })).status, 'off');
      assert.equal(calls, 0);
      const first = await runShadow(p, endpoint, { mode: 'shadow', store });
      assert.equal(first.status, 'accepted');
      assert.equal((await runShadow(p, endpoint, { mode: 'shadow', store })).status, 'reused');
      assert.equal(calls, 1);
      const rows = await store.recent(uid, 'pt');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.projections[0].candidateGrade, 3);
      assert.equal(rows[0]!.projections[0].grade, null);
      assert.equal(rows[0]!.projections[0].applied, false);
      assert.equal(
        (await tx`SELECT count(*)::int AS n FROM user_vocabulary WHERE user_id=${uid}`)[0]!.n,
        0,
      );
      assert.equal((await store.history(uid, 'pt', 'caféine', '2099-01-01')).length, 0);
      assert.equal((await store.history(uid, 'pt', 'un café', '2099-01-01')).length, 1);
      await store.saveVector(first.id!, 'fixture-vector', [1, 0]);
      assert.equal(
        (await store.vectorCandidates(uid, 'pt', 'fixture-vector', '2099-01-01')).length,
        1,
      );
      assert.equal(
        (await store.vectorCandidates('someone-else', 'pt', 'fixture-vector', '2099-01-01')).length,
        0,
      );
      assert.equal(
        (await store.vectorCandidates(uid, 'pt', 'fixture-vector', '2000-01-01')).length,
        0,
      );
      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  } finally {
    await sql.end();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
