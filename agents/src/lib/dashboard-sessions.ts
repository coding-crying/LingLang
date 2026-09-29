import { type SQL, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';

// Preserve the existing absolute lifetime; persistence does not extend access.
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
type Execute = (query: SQL) => PromiseLike<readonly Record<string, unknown>[]>;
const validToken = (token: string) => /^[a-f0-9]{64}$/.test(token);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export class DashboardSessions {
  constructor(
    private readonly execute: Execute,
    private readonly now = Date.now,
  ) {}

  async create(userId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + SESSION_MAX_AGE_MS).toISOString();
    // Bounded by login frequency; no timer or new service is needed.
    await this.execute(sql`DELETE FROM dashboard_sessions WHERE expires_at <= ${createdAt}`);
    await this
      .execute(sql`INSERT INTO dashboard_sessions (token_hash, user_id, created_at, expires_at)
      VALUES (${digest(token)}, ${userId}, ${createdAt}, ${expiresAt})`);
    return token;
  }

  async get(token: string): Promise<{ userId: string } | null> {
    if (!validToken(token)) return null;
    const rows = await this.execute(sql`SELECT user_id FROM dashboard_sessions
      WHERE token_hash = ${digest(token)} AND expires_at > ${new Date(this.now()).toISOString()} LIMIT 1`);
    return typeof rows[0]?.user_id === 'string' ? { userId: rows[0].user_id } : null;
  }

  async revoke(token: string): Promise<void> {
    if (validToken(token))
      await this.execute(sql`DELETE FROM dashboard_sessions WHERE token_hash = ${digest(token)}`);
  }
}
