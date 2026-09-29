// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import postgres from 'postgres';
import { packetSchema } from './contract.js';
import { endpointFingerprint } from './policy.js';
import { EvidenceStore } from './store.js';

dotenv.config({ path: '.env.local', quiet: true });
test('Postgres migration, idempotency, immutable inputs, tenant reads, deletion and projection isolation', async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const rollback = new Error('intentional test rollback');
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(await readFile('drizzle/0020_learning_evidence.sql', 'utf8'));
      const uid = `evidence-test-${crypto.randomUUID()}`;
      await tx`INSERT INTO users (id) VALUES (${uid})`;
      const store = new EvidenceStore(tx);
      const p = packetSchema.parse({
        userId: uid,
        sessionId: 's',
        turnId: 'l',
        language: 'pt',
        occurredAt: new Date().toISOString(),
        source: 'typed',
        turns: [
          { id: 't', role: 'tutor', text: 'Say café.' },
          { id: 'l', role: 'learner', text: 'café' },
        ],
      });
      const identity = {
        fingerprint: endpointFingerprint('http://localhost/v1'),
        model: 'fixture',
        language: 'pt',
      };
      const a = await store.claim(p, identity, []);
      assert.equal(a.claimed, true);
      const b = await store.claim(p, identity, []);
      assert.equal(b.claimed, false);
      assert.equal(a.id, b.id);
      await assert.rejects(
        store.claim(
          { ...p, turns: [p.turns[0]!, { id: 'l', role: 'learner', text: 'different' }] },
          identity,
          [],
        ),
        /immutable/i,
      );
      await store.complete(
        a.id,
        {
          status: 'accepted',
          observations: [],
          model: 'fixture',
          fingerprint: identity.fingerprint,
          promptVersion: 'observer-text-v1',
          contractVersion: 'evidence-v1',
          exampleVersion: 'contrasts-v1',
          elapsedMs: 1,
          error: null,
        },
        [],
        a.token,
      );
      assert.equal((await store.recent(uid, 'pt')).length, 1);
      assert.equal((await store.recent(uid, 'ru')).length, 0);
      assert.equal((await store.recent('someone-else', 'pt')).length, 0);
      assert.equal(await store.capability(identity), null);
      await store.upsertCapability(
        identity,
        true,
        ['production', 'assistance'],
        '{"certified":true}',
        new Date(Date.now() + 60_000).toISOString(),
      );
      const capability = await store.capability(identity);
      assert.equal(capability?.approved, true);
      assert.deepEqual(capability?.capabilities, ['production', 'assistance']);
      assert.equal(capability?.report, '{"certified":true}');
      await store.upsertCapability(
        identity,
        false,
        [],
        '{"certified":false}',
        new Date().toISOString(),
      );
      assert.equal((await store.capability(identity))?.approved, false);
      assert.deepEqual((await store.capability(identity))?.capabilities, []);
      assert.equal(
        (await tx`SELECT count(*)::int AS n FROM user_vocabulary WHERE user_id=${uid}`)[0]!.n,
        0,
      );
      await tx`DELETE FROM users WHERE id=${uid}`;
      assert.equal((await store.recent(uid, 'pt')).length, 0);
      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  } finally {
    await sql.end();
  }
});
