import dotenv from 'dotenv';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';

test('dashboard sessions survive new store instances, expire and revoke without storing bearer tokens', async () => {
  assert.ok(
    existsSync(new URL('./dashboard-sessions.ts', import.meta.url)),
    'a restart-persistent session store is required',
  );
  const { DashboardSessions, SESSION_MAX_AGE_MS } = await import('./dashboard-sessions.js');
  dotenv.config({ path: '.env.local', quiet: true });
  assert.ok(process.env.DATABASE_URL, 'real PostgreSQL required');
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const rollback = new Error('rollback fixture');
  try {
    await assert.rejects(
      client.begin(async (tx) => {
        // Isolate DDL/FK locks from other integration tests and real learners.
        // The schema and all fixtures disappear when the transaction rolls back.
        const schema = `qa_sessions_${randomUUID().replaceAll('-', '')}`;
        await tx`CREATE SCHEMA ${tx(schema)}`;
        await tx`SET LOCAL search_path TO ${tx(schema)}`;
        await tx`CREATE TABLE users (id text PRIMARY KEY)`;
        await tx.unsafe(
          readFileSync(
            new URL('../../drizzle/0021_dashboard_sessions.sql', import.meta.url),
            'utf8',
          ),
        );
        const user = `qa_sessions_${randomUUID()}`;
        await tx`INSERT INTO users (id) VALUES (${user})`;
        const database = {
          execute(q: SQL) {
            const query = new PgDialect().sqlToQuery(q);
            return tx.unsafe(
              query.sql,
              query.params.map((p) => {
                assert.equal(typeof p, 'string');
                return p as string;
              }),
            );
          },
        };
        let now = Date.now();
        const first = new DashboardSessions(
          (q) => database.execute(q),
          () => now,
        );
        const token = await first.create(user);
        assert.match(token, /^[a-f0-9]{64}$/);
        const second = new DashboardSessions(
          (q) => database.execute(q),
          () => now,
        );
        assert.deepEqual(await second.get(token), { userId: user });
        const [saved] = await tx`SELECT token_hash FROM dashboard_sessions WHERE user_id=${user}`;
        assert.notEqual(
          saved.token_hash,
          token,
          'database must not contain reusable bearer credentials',
        );
        assert.equal(await second.get('made-up-cookie'), null);
        assert.equal(await second.get('a'.repeat(64)), null);
        now += SESSION_MAX_AGE_MS;
        assert.equal(await second.get(token), null, 'expires at the boundary');
        const fresh = await second.create(user);
        await first.revoke(fresh);
        assert.equal(await second.get(fresh), null, 'logout revokes across instances');
        const removed = await second.create(user);
        await tx`DELETE FROM users WHERE id=${user}`;
        assert.equal(await first.get(removed), null, 'deleted users cannot retain access');
        throw rollback;
      }),
      (error) => error === rollback,
    );
  } finally {
    await client.end();
  }
});
