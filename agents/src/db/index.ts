import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL || 'postgresql://linglang:linglang_dev@localhost:5433/linglang';

console.log(`[DB] Connecting to PostgreSQL at: ${connectionString.replace(/:[^:@]+@/, ':****@')}`);

const client = postgres(connectionString);

export const db = drizzle(client, { schema });

// Export schema helper types
export type Unit = typeof schema.units.$inferSelect;
export type Lexeme = typeof schema.lexemes.$inferSelect;
export type GrammarRule = typeof schema.grammarRules.$inferSelect;
export type UserVocabulary = typeof schema.userVocabulary.$inferSelect;
export type ReviewLog = typeof schema.reviewLogs.$inferSelect;