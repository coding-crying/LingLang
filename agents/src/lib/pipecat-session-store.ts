import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { issueVoiceTicket, verifyVoiceTicket, type VoiceSessionScope } from './pipecat-session-ticket.js';
type Execute = (query: SQL) => PromiseLike<readonly Record<string, unknown>[]>;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const denied = () => new Error('Voice session unavailable');
/** Shared durable store: credential validation alone never authorizes a session.
 * The caller must authenticate dashboard create/close and private worker routes.
 * No provider keys are stored here or returned to browser clients.
 */
export class PipecatSessionStore {
  constructor(private execute: Execute, private secret: string, private now = () => Math.floor(Date.now()/1000)) {}
  async create(userId: string, language: string, transport: VoiceSessionScope['transport']) {
    const sessionId = randomUUID();
    const now = this.now();
    const ticket = issueVoiceTicket({sessionId,userId,language,transport},this.secret,now);
    await this.execute(sql`INSERT INTO pipecat_sessions(id,user_id,language,transport,expires_at)
      VALUES(${sessionId},${userId},${language},${transport},${now+14400})`);
    return {sessionId,ticket};
  }
  async claim(ticket: string) {
    const scope=verifyVoiceTicket(ticket,this.secret,this.now());
    const workerToken=randomBytes(32).toString('hex');
    const rows=await this.execute(sql`UPDATE pipecat_sessions SET worker_hash=${digest(workerToken)}
      WHERE id=${scope.sessionId} AND user_id=${scope.userId} AND language=${scope.language}
      AND transport=${scope.transport} AND worker_hash IS NULL AND closed_at IS NULL AND expires_at>${this.now()}
      RETURNING id,user_id,language,transport`);
    if (!rows.length) throw denied();
    return {sessionId:scope.sessionId,userId:scope.userId,language:scope.language,transport:scope.transport,workerToken};
  }
  async authorizeWorker(sessionId: string, token: string): Promise<VoiceSessionScope> {
    if (typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) throw denied();
    const rows=await this.execute(sql`SELECT id,user_id,language,transport FROM pipecat_sessions
      WHERE id=${sessionId} AND worker_hash=${digest(token)} AND closed_at IS NULL AND expires_at>${this.now()}`);
    const row=rows[0];if(!row) throw denied();
    return {sessionId:String(row.id),userId:String(row.user_id),language:String(row.language),transport:row.transport as VoiceSessionScope['transport']};
  }
  async close(sessionId: string, authenticatedUserId: string) {
    const rows=await this.execute(sql`UPDATE pipecat_sessions SET closed_at=COALESCE(closed_at,NOW())
      WHERE id=${sessionId} AND user_id=${authenticatedUserId} RETURNING id`);
    if(!rows.length) throw denied();
  }
}
