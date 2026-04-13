import { pgTable, text, integer, real, timestamp, uuid, index, uniqueIndex, vector } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { relations } from 'drizzle-orm';

// --- Units (The curriculum structure) ---
export const units = pgTable('units', {
  id: text('id').primaryKey(), // e.g., 'nl-unit-1'
  title: text('title').notNull(),
  description: text('description'),
  language: text('language').notNull(), // 'nl', 'ru'
  order: integer('order').notNull(),
  difficulty: text('difficulty'), // 'beginner', 'intermediate'
  estimatedHours: integer('estimated_hours'),
  prerequisites: text('prerequisites'), // JSON array of unit IDs
});

export const unitsRelations = relations(units, ({ many }) => ({
  lexemes: many(lexemes),
  grammarRules: many(grammarRules),
}));

// --- Lexemes (Vocabulary) ---
export const lexemes = pgTable('lexemes', {
  id: text('id').primaryKey(), // UUID or 'lemma-pos'
  lemma: text('lemma').notNull(),
  pos: text('pos').notNull(), // 'NOUN', 'VERB', etc.
  language: text('language').notNull(),
  translation: text('translation').notNull(),
  gender: text('gender'), // 'masc', 'fem', 'neuter', null
  morphFeatures: text('morph_features'), // JSON: detailed features from analysis
  unitId: text('unit_id').references(() => units.id),
  embedding: vector('embedding', { dimensions: 1024 }), // BGE-M3 1024d embedding
}, (table) => [
  index('lexemes_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const lexemesRelations = relations(lexemes, ({ one, many }) => ({
  unit: one(units, {
    fields: [lexemes.unitId],
    references: [units.id],
  }),
  progress: many(userVocabulary),
}));

// --- Grammar Rules (Graph/Vector Hybrid) ---
export const grammarRules = pgTable('grammar_rules', {
  id: text('id').primaryKey(),
  rule: text('rule').notNull(),
  description: text('description'),
  example: text('example'),
  unitId: text('unit_id').references(() => units.id),
  embedding: vector('embedding', { dimensions: 1024 }),
});

export const grammarRulesRelations = relations(grammarRules, ({ one }) => ({
  unit: one(units, {
    fields: [grammarRules.unitId],
    references: [units.id],
  }),
}));

// --- Users ---
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  // Language preferences
  targetLanguage: text('target_language').notNull().default('ru'),
  nativeLanguage: text('native_language').notNull().default('en'),
  proficiencyLevel: text('proficiency_level').default('beginner'),
});

export const usersRelations = relations(users, ({ many }) => ({
  progress: many(userVocabulary),
  activeGoals: many(activeGoals),
}));

// --- User Vocabulary (FSRS state - replaces learning_progress) ---
export const userVocabulary = pgTable('user_vocabulary', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id),
  lexemeId: text('lexeme_id').notNull().references(() => lexemes.id),

  // FSRS Core Fields
  state: integer('state').notNull().default(0),          // 0: New, 1: Learning, 2: Review, 3: Relearning
  due: timestamp('due', { withTimezone: true }).notNull().defaultNow(),
  stability: real('stability').notNull().default(0),      // Memory stability (S)
  difficulty: real('difficulty').notNull().default(0),     // Inherent difficulty (D)
  elapsedDays: integer('elapsed_days').notNull().default(0),
  scheduledDays: integer('scheduled_days').notNull().default(0),
  reps: integer('reps').notNull().default(0),              // Total times reviewed
  lapses: integer('lapses').notNull().default(0),         // Total times forgotten (Grade 1)
  scaffoldedCount: integer('scaffolded_count').notNull().default(0),  // Times used correctly but scaffolded

  // Review meta
  lastReview: timestamp('last_review', { withTimezone: true }),
  avgPronunciationScore: real('avg_pronunciation_score'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_vocabulary_user_lexeme_idx').on(table.userId, table.lexemeId),
  index('user_vocabulary_due_idx').on(table.userId, table.due),
]);

export const userVocabularyRelations = relations(userVocabulary, ({ one }) => ({
  user: one(users, {
    fields: [userVocabulary.userId],
    references: [users.id],
  }),
  lexeme: one(lexemes, {
    fields: [userVocabulary.lexemeId],
    references: [lexemes.id],
  }),
}));

// --- Review Logs (FSRS history for optimizer) ---
export const reviewLogs = pgTable('review_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userVocabularyId: uuid('user_vocabulary_id').notNull().references(() => userVocabulary.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),

  // The Review Event
  grade: integer('grade').notNull(), // 1: Again, 2: Hard, 3: Good, 4: Easy
  reviewDate: timestamp('review_date', { withTimezone: true }).notNull().defaultNow(),

  // State Snapshot (what the state was before this review)
  state: integer('state').notNull(),
  stability: real('stability').notNull(),
  difficulty: real('difficulty').notNull(),
  elapsedDays: integer('elapsed_days').notNull(),
  scheduledDays: integer('scheduled_days').notNull(),

  // Voice App Specifics
  escalationLevelUsed: integer('escalation_level_used'),  // Did they get it at level 1, 2, or 3?
  pronunciationScore: real('pronunciation_score'),          // STT confidence for this review
  durationMs: integer('duration_ms'),                       // How long did it take them to recall?
}, (table) => [
  index('review_logs_vocab_idx').on(table.userVocabularyId),
]);

export const reviewLogsRelations = relations(reviewLogs, ({ one }) => ({
  userVocabulary: one(userVocabulary, {
    fields: [reviewLogs.userVocabularyId],
    references: [userVocabulary.id],
  }),
}));

// --- Active Goals (Thesis "Goal Seeking Cycle") ---
export const activeGoals = pgTable('active_goals', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: text('user_id').notNull().references(() => users.id),

  type: text('type').notNull(), // 'vocab', 'grammar', 'remediation'
  targetId: text('target_id').notNull(), // lexemeId or ruleId
  status: text('status').notNull().default('active'), // 'active', 'completed', 'failed'
  priority: integer('priority').notNull().default(5),    // 1=urgent(remediation), 5=normal(vocab), 9=low(suggestion)
  grammarContext: text('grammar_context'),               // The grammar rule / hint from analysis
  pattern: text('pattern'),                              // Error pattern: 'conjugation', 'case', 'copula_omission'

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const activeGoalsRelations = relations(activeGoals, ({ one }) => ({
  user: one(users, {
    fields: [activeGoals.userId],
    references: [users.id],
  }),
}));

// --- Duolingo Metadata (For Duolingo Integration) ---
export const duolingoMetadata = pgTable('duolingo_metadata', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: text('user_id').notNull().unique().references(() => users.id),

  // Duolingo credentials
  duolingoUsername: text('duolingo_username').notNull(),
  duolingoPassword: text('duolingo_password'),
  duolingoJWT: text('duolingo_jwt'),

  // Sync tracking
  lastSyncTimestamp: timestamp('last_sync_timestamp', { withTimezone: true }),
  syncStatus: text('sync_status').default('pending'), // 'pending', 'success', 'failed'
  syncError: text('sync_error'),

  // Duolingo-specific IDs
  duolingoUserId: text('duolingo_user_id'),
  learningLanguage: text('learning_language').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const duolingoMetadataRelations = relations(duolingoMetadata, ({ one }) => ({
  user: one(users, {
    fields: [duolingoMetadata.userId],
    references: [users.id],
  }),
}));