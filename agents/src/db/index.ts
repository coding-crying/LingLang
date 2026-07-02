import * as dotenv from 'dotenv';
// 2026-06-30: db/index.ts is imported transitively (user-auth → db) and
// ES module hoisting means it evaluates BEFORE the dashboard/agent's
// top-level dotenv.config() runs. Also, the env vars set by `source
// .env.local` in the launch shell don't always propagate to long-lived
// background processes. Load .env.local here so the connection string
// is correct regardless of import order or how the process was started.
dotenv.config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL || 'postgresql://linglang:***@localhost:5433/linglang';

console.log(`[DB] Connecting to PostgreSQL at: ${connectionString.replace(/:[^:@]+@/, ':****@')}`);

const client = postgres(connectionString);

export const db = drizzle(client, { schema });

// Export schema helper types
export type Unit = typeof schema.units.$inferSelect;
export type Lexeme = typeof schema.lexemes.$inferSelect;
export type GrammarRule = typeof schema.grammarRules.$inferSelect;
export type UserVocabulary = typeof schema.userVocabulary.$inferSelect;
export type ReviewLog = typeof schema.reviewLogs.$inferSelect;