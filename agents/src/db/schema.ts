import { sqliteTable, text, integer, blob, real } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

// --- Units (The curriculum structure) ---
export const units = sqliteTable('units', {
  id: text('id').primaryKey(), // e.g., 'nl-unit-1'
  title: text('title').notNull(),
  description: text('description'),
  language: text('language').notNull(), // 'nl', 'ru'
  order: integer('order').notNull(),
  difficulty: text('difficulty'), // 'beginner', 'intermediate'
  estimatedHours: integer('estimated_hours'),
  prerequisites: text('prerequisites', { mode: 'json' }), // Array of unit IDs
});

export const unitsRelations = relations(units, ({ many }) => ({
  lexemes: many(lexemes),
  grammarRules: many(grammarRules),
}));

// --- Lexemes (Vocabulary) ---
export const lexemes = sqliteTable('lexemes', {
  id: text('id').primaryKey(), // UUID or 'lemma-pos'
  lemma: text('lemma').notNull(),
  pos: text('pos').notNull(), // 'NOUN', 'VERB', etc.
  language: text('language').notNull(),
  translation: text('translation').notNull(),
  gender: text('gender'), // 'masc', 'fem', 'neuter', null
  morphFeatures: text('morph_features', { mode: 'json' }), // Detailed features from analysis
  unitId: text('unit_id').references(() => units.id),
});

export const lexemesRelations = relations(lexemes, ({ one, many }) => ({
  unit: one(units, {
    fields: [lexemes.unitId],
    references: [units.id],
  }),
  progress: many(learningProgress),
}));

// --- Grammar Rules (Graph/Vector Hybrid) ---
export const grammarRules = sqliteTable('grammar_rules', {
  id: text('id').primaryKey(),
  rule: text('rule').notNull(),
  description: text('description'),
  example: text('example'),
  unitId: text('unit_id').references(() => units.id),
  embedding: blob('embedding'), // Vector embedding for semantic search
});

export const grammarRulesRelations = relations(grammarRules, ({ one }) => ({
  unit: one(units, {
    fields: [grammarRules.unitId],
    references: [units.id],
  }),
}));

// --- Users ---
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),

  // Language preferences
  targetLanguage: text('target_language').notNull().default('ru'),
  nativeLanguage: text('native_language').notNull().default('en'),
  proficiencyLevel: text('proficiency_level').default('beginner'),
});

export const usersRelations = relations(users, ({ many }) => ({
  progress: many(learningProgress),
  activeGoals: many(activeGoals),
}));

// --- Learning Progress (The SRS state) ---
export const learningProgress = sqliteTable('learning_progress', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id),
  lexemeId: text('lexeme_id').notNull().references(() => lexemes.id),
  
  srsLevel: integer('srs_level').notNull().default(0), // Leitner box 0-5
  nextReview: integer('next_review').notNull(), // Timestamp
  lastSeen: integer('last_seen').notNull(), // Timestamp
  
  encounters: integer('encounters').notNull().default(0),
  correctUses: integer('correct_uses').notNull().default(0),
  
  // Detailed history of specific form usage
  formStats: text('form_stats', { mode: 'json' }), 
});

export const learningProgressRelations = relations(learningProgress, ({ one }) => ({
  user: one(users, {
    fields: [learningProgress.userId],
    references: [users.id],
  }),
  lexeme: one(lexemes, {
    fields: [learningProgress.lexemeId],
    references: [lexemes.id],
  }),
}));

// --- Active Goals (Thesis "Goal Seeking Cycle") ---
export const activeGoals = sqliteTable('active_goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id),
  
  type: text('type').notNull(), // 'vocab', 'grammar', 'remediation'
  targetId: text('target_id').notNull(), // lexemeId or ruleId
  status: text('status').notNull().default('active'), // 'active', 'completed', 'failed'
  
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const activeGoalsRelations = relations(activeGoals, ({ one }) => ({
  user: one(users, {
    fields: [activeGoals.userId],
    references: [users.id],
  }),
}));

// --- Duolingo Metadata (For Duolingo Integration) ---
export const duolingoMetadata = sqliteTable('duolingo_metadata', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().unique().references(() => users.id),

  // Duolingo credentials
  duolingoUsername: text('duolingo_username').notNull(),
  duolingoPassword: text('duolingo_password'),
  duolingoJWT: text('duolingo_jwt'),

  // Sync tracking
  lastSyncTimestamp: integer('last_sync_timestamp'),
  syncStatus: text('sync_status').default('pending'), // 'pending', 'success', 'failed'
  syncError: text('sync_error'),

  // Duolingo-specific IDs
  duolingoUserId: text('duolingo_user_id'),
  learningLanguage: text('learning_language').notNull(), // 'ru', 'es', etc.

  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const duolingoMetadataRelations = relations(duolingoMetadata, ({ one }) => ({
  user: one(users, {
    fields: [duolingoMetadata.userId],
    references: [users.id],
  }),
}));