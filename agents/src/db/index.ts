import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema.js';

const dbPath = './tutor.db';
const sqlite = new Database(dbPath);

export const db: ReturnType<typeof drizzle<typeof schema>> = drizzle(sqlite, { schema });

// Export schema helper types
export type Unit = typeof schema.units.$inferSelect;
export type Lexeme = typeof schema.lexemes.$inferSelect;
export type GrammarRule = typeof schema.grammarRules.$inferSelect;
export type LearningProgress = typeof schema.learningProgress.$inferSelect;
