// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { validateGuidance } from './profile.js';

export interface PromptProfile {
  revision: number;
  guidance: string | null;
  evaluationId: string | null;
  createdAt?: string;
}
const fallback: PromptProfile = { revision: 0, guidance: null, evaluationId: null };
export async function readProfile(userId: string, key: string): Promise<PromptProfile> {
  const rows =
    await db.execute(sql`SELECT revision,guidance,evaluation_id AS "evaluationId",created_at AS "createdAt"
    FROM model_prompt_versions WHERE user_id=${userId} AND profile_key=${key} ORDER BY revision DESC LIMIT 1`);
  return rows[0] ? (rows[0] as unknown as PromptProfile) : { ...fallback };
}
export async function profileHistory(userId: string, key: string) {
  return [
    ...(await db.execute(sql`SELECT revision,guidance,evaluation_id AS "evaluationId",created_at AS "createdAt"
    FROM model_prompt_versions WHERE user_id=${userId} AND profile_key=${key} ORDER BY revision DESC LIMIT 20`)),
  ];
}
export async function saveProfile(
  userId: string,
  key: string,
  guidance: string | null,
  expectedRevision: number,
  evaluationId: string | null = null,
): Promise<PromptProfile> {
  const value = guidance === null ? null : validateGuidance(guidance);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}),hashtext(${key}))`);
    const rows = await tx.execute(
      sql`SELECT revision FROM model_prompt_versions WHERE user_id=${userId} AND profile_key=${key} ORDER BY revision DESC LIMIT 1`,
    );
    const revision = Number(rows[0]?.revision ?? 0);
    if (revision !== expectedRevision) throw new Error('Profile changed; reload before applying');
    await tx.execute(sql`INSERT INTO model_prompt_versions(user_id,profile_key,revision,guidance,evaluation_id)
      VALUES (${userId},${key},${revision + 1},${value},${evaluationId})`);
    return { revision: revision + 1, guidance: value, evaluationId };
  });
}
