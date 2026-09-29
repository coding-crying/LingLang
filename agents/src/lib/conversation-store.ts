// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { sql } from 'drizzle-orm';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/index.js';
import { type ArchivedEvent, ConversationArchive } from './conversation-archive.js';

export async function storeConversationEvent(event: ArchivedEvent): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${event.userId}),hashtext(${event.sessionId}))`,
    );
    const deleted = await tx.execute(
      sql`SELECT 1 FROM conversation_tombstones WHERE user_id=${event.userId} AND session_id=${event.sessionId}`,
    );
    if (deleted.length) return;
    // Account deletion also revokes pending source retention. Drop only confirmed
    // missing owners; connection failures still throw and preserve the outbox.
    const owner = await tx.execute(sql`SELECT id FROM users WHERE id=${event.userId}`);
    if (!owner.length) return;
    await tx.execute(sql`INSERT INTO conversation_events
    (id,user_id,session_id,turn_id,role,language,occurred_at,captured_at,status,payload)
    VALUES (${event.id},${event.userId},${event.sessionId},${event.turnId},${event.role},${event.language},
      ${event.occurredAt}::timestamptz,${event.capturedAt}::timestamptz,${event.status},${JSON.stringify(event)}::jsonb)
    ON CONFLICT (id) DO NOTHING`);
  });
}
export function createConversationArchive() {
  return new ConversationArchive(
    process.env.CONVERSATION_OUTBOX_DIR ||
      join(homedir(), '.local/state/linglang/conversation-outbox'),
    storeConversationEvent,
  );
}
export const conversationReads = {
  async remove(userId: string, sessionId: string) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${userId}),hashtext(${sessionId}))`,
      );
      await tx.execute(
        sql`INSERT INTO conversation_tombstones(user_id,session_id) VALUES (${userId},${sessionId}) ON CONFLICT DO NOTHING`,
      );
      await tx.execute(
        sql`DELETE FROM conversation_events WHERE user_id=${userId} AND session_id=${sessionId}`,
      );
    });
  },
  async sessions(userId: string, before: string) {
    return [
      ...(await db.execute(sql`SELECT session_id AS "sessionId", min(seq)::text AS cursor, min(occurred_at) AS "startedAt",
      max(occurred_at) AS "endedAt", count(*)::int AS "eventCount", array_agg(DISTINCT language) AS languages
      FROM conversation_events WHERE user_id=${userId}
      GROUP BY session_id HAVING min(seq)<${before}::bigint
      ORDER BY min(seq) DESC LIMIT 51`)),
    ];
  },
  async events(userId: string, sessionId: string, after: string) {
    return [
      ...(await db.execute(sql`SELECT seq::text AS cursor,payload FROM conversation_events
      WHERE user_id=${userId} AND session_id=${sessionId} AND seq>${after}::bigint ORDER BY seq LIMIT 501`)),
    ];
  },
};
