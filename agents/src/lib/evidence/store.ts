// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  CONTRACT_VERSION,
  PROMPT_VERSION,
  containsForm,
  packetHash,
  packetSchema,
  resultSchema,
} from './contract.js';
import type { EvidencePacket } from './contract.js';
import { EXAMPLE_VERSION } from './observer.js';
import type { ObserverResult } from './observer.js';
import type { CapabilityProfile, ModelIdentity } from './policy.js';

export class EvidenceStore {
  constructor(private sql: postgres.Sql | postgres.TransactionSql) {}
  private json(value: unknown) {
    return this.sql.json(value as postgres.JSONValue);
  }
  async claim(packet: EvidencePacket, identity: ModelIdentity, history: unknown[]) {
    const p = packetSchema.parse(packet),
      hash = packetHash(p),
      sql = this.sql;
    await sql`INSERT INTO learning_evidence_events (user_id,session_id,turn_id,language,occurred_at,packet_hash,packet)
      VALUES (${p.userId},${p.sessionId},${p.turnId},${p.language},${p.occurredAt},${hash},${this.json(p)}) ON CONFLICT (user_id,session_id,turn_id) DO NOTHING`;
    const [event] =
      await sql`SELECT id,packet_hash FROM learning_evidence_events WHERE user_id=${p.userId} AND session_id=${p.sessionId} AND turn_id=${p.turnId}`;
    if (!event || event.packet_hash !== hash) throw new Error('Evidence event input is immutable');
    const revision = createHash('sha256')
      .update(
        JSON.stringify([
          identity.fingerprint,
          identity.model,
          PROMPT_VERSION,
          CONTRACT_VERSION,
          EXAMPLE_VERSION,
        ]),
      )
      .digest('hex');
    const [claimed] =
      await sql`INSERT INTO learning_evidence_assessments (event_id,revision_key,model,fingerprint,prompt_version,contract_version,example_version,status,history)
      VALUES (${event.id},${revision},${identity.model},${identity.fingerprint},${PROMPT_VERSION},${CONTRACT_VERSION},${EXAMPLE_VERSION},'pending',${this.json(history)})
      ON CONFLICT (event_id,revision_key) DO UPDATE SET status='pending',updated_at=now(),attempt_token=gen_random_uuid()::text,attempts=learning_evidence_assessments.attempts+1
      WHERE learning_evidence_assessments.attempts < 3 AND (learning_evidence_assessments.status='error' OR (learning_evidence_assessments.status='pending' AND learning_evidence_assessments.updated_at < now()-interval '2 minutes'))
      RETURNING id,attempt_token,history`;
    const row =
      claimed ??
      (
        await sql`SELECT id,attempt_token,history FROM learning_evidence_assessments WHERE event_id=${event.id} AND revision_key=${revision}`
      )[0]!;
    return {
      id: row.id as string,
      token: row.attempt_token as string,
      claimed: !!claimed,
      history: row.history as unknown[],
    };
  }
  async complete(id: string, result: ObserverResult, projections: unknown[], token?: string) {
    // A lease token prevents a slow abandoned worker overwriting a retried assessment.
    if (!token) throw new Error('Assessment lease token required');
    const rows = await this
      .sql`UPDATE learning_evidence_assessments SET status=${result.status},result=${this.json(result)},projections=${this.json(projections)},updated_at=now()
      WHERE id=${id} AND attempt_token=${token} AND status='pending' RETURNING id`;
    return rows.length === 1;
  }
  async capability(identity: ModelIdentity): Promise<CapabilityProfile | null> {
    const [row] = await this
      .sql`SELECT * FROM learning_evidence_capabilities WHERE fingerprint=${identity.fingerprint} AND model=${identity.model} AND language=${identity.language} AND prompt_version=${PROMPT_VERSION}`;
    if (!row) return null;
    return {
      ...identity,
      promptVersion: row.prompt_version,
      approved: row.approved,
      report: row.report,
      expiresAt: new Date(row.expires_at).toISOString(),
      capabilities: row.capabilities,
    };
  }
  async upsertCapability(
    identity: ModelIdentity,
    approved: boolean,
    capabilities: string[],
    report: string,
    expiresAt: string,
  ) {
    await this.sql`INSERT INTO learning_evidence_capabilities
      (fingerprint,model,language,prompt_version,approved,capabilities,report,expires_at)
      VALUES (${identity.fingerprint},${identity.model},${identity.language},${PROMPT_VERSION},${approved},${this.json(capabilities)},${report},${expiresAt})
      ON CONFLICT (fingerprint,model,language,prompt_version) DO UPDATE SET
        approved=EXCLUDED.approved,
        capabilities=EXCLUDED.capabilities,
        report=EXCLUDED.report,
        expires_at=EXCLUDED.expires_at`;
  }
  async recent(userId: string, language?: string, limit = 20) {
    const sql = this.sql;
    return sql`SELECT e.id AS event_id,e.language,e.occurred_at,e.packet,a.id,a.model,a.status,a.result,a.projections,a.prompt_version,a.updated_at
      FROM learning_evidence_events e JOIN LATERAL (SELECT * FROM learning_evidence_assessments WHERE event_id=e.id ORDER BY created_at DESC,id DESC LIMIT 1) a ON true
      WHERE e.user_id=${userId} AND (${language ?? null}::text IS NULL OR e.language=${language ?? null})
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`;
  }
  async history(
    userId: string,
    language: string,
    text: string,
    before: string,
  ): Promise<readonly unknown[]> {
    // Exact observed forms only; retrieval is not a memory update or a gold label.
    const rows = await this.sql`SELECT e.id,e.packet,a.result FROM learning_evidence_events e
      JOIN LATERAL (SELECT result FROM learning_evidence_assessments a WHERE a.event_id=e.id AND a.status='accepted' ORDER BY a.created_at DESC LIMIT 1) a ON true
      WHERE e.user_id=${userId} AND e.language=${language} AND e.occurred_at < ${before}
      ORDER BY e.occurred_at DESC LIMIT 200`;
    return rows
      .filter((r) => {
        const parsed = resultSchema.safeParse({ observations: r.result?.observations });
        return parsed.success && parsed.data.observations.some((o) => containsForm(text, o.form));
      })
      .slice(0, 4)
      .map((r) => ({ id: r.id, packet: r.packet }));
  }
  async saveVector(assessmentId: string, model: string, vector: number[]) {
    await this.sql`INSERT INTO learning_evidence_vectors(event_id,model,format_version,embedding)
      SELECT event_id,${model},'episode-v1',${this.json(vector)} FROM learning_evidence_assessments WHERE id=${assessmentId}
      ON CONFLICT DO NOTHING`;
  }
  async vectorCandidates(userId: string, language: string, model: string, before: string) {
    const rows = await this
      .sql`SELECT e.id,e.user_id,e.language,e.occurred_at,e.packet,v.model,v.format_version,v.embedding
      FROM learning_evidence_events e JOIN learning_evidence_vectors v ON v.event_id=e.id
      WHERE e.user_id=${userId} AND e.language=${language} AND v.model=${model} AND v.format_version='episode-v1' AND e.occurred_at < ${before}
      ORDER BY e.occurred_at DESC LIMIT 200`;
    return rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      language: r.language as string,
      occurredAt: new Date(r.occurred_at).toISOString(),
      packet: r.packet as unknown,
      model: r.model as string,
      format: r.format_version as string,
      vector: r.embedding as number[],
    }));
  }
  async packetForReplay(userId: string, eventId: string): Promise<EvidencePacket | null> {
    const [row] = await this
      .sql`SELECT packet FROM learning_evidence_events WHERE id=${eventId} AND user_id=${userId}`;
    return row ? packetSchema.parse(row.packet) : null;
  }
}
