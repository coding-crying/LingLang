// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * LingLang Universal Schema — Cross-compatible between SQLite (edge) and PostgreSQL (cloud).
 *
 * Design principles:
 * - All columns are scalar types (no JSONB, no arrays, no vectors)
 * - Timestamps as Unix epoch integers (works identically in SQLite and PG)
 * - Single primary key per table (no composite PKs that need SQLite workarounds)
 * - pgvector and cloud-only features live in SEPARATE tables joined by word ID
 * - Drizzle ORM generates both SQLite and PG DDL from this one definition
 *
 * Usage:
 *   Cloud:  import { pgTable, ... } from 'drizzle-orm/pg-core'
 *   Edge:   import { sqliteTable, ... } from 'drizzle-orm/sqlite-core'
 *
 * Strategy: define each table as a function that takes the table constructor:
 *   const words = makeWordsTable(pgTable)   // cloud
 *   const words = makeWordsTable(sqliteTable) // edge
 */

import type { ColumnBuilder, TableFn } from './table-types';

// ---------------------------------------------------------------------------
// USERS — Learner profiles
// ---------------------------------------------------------------------------
export function makeUsersTable(t: TableFn) {
  return t('users', {
    id: t.text('id').primaryKey(), // UUID on cloud, random string on edge
    nativeLanguage: t.text('native_language').notNull().default('en'),
    // Null until the learner explicitly chooses a target language.
    targetLanguage: t.text('target_language'),
    proficiencyLevel: t.text('proficiency_level').notNull().default('A1'),
    createdAt: t.integer('created_at').notNull(), // unix epoch
    updatedAt: t.integer('updated_at').notNull(),
  });
}

// ---------------------------------------------------------------------------
// WORDS — Core vocabulary (syncs between edge ↔ cloud)
// ---------------------------------------------------------------------------
export function makeWordsTable(t: TableFn) {
  return t('words', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    word: t.text('word').notNull(),
    language: t.text('language').notNull(), // ISO 639-1: 'en', 'es', 'fr', etc.
    cefrLevel: t.text('cefr_level').notNull(), // A1, A2, B1, B2, C1, C2
    pos: t.text('pos'), // part of speech: noun, verb, adj, etc.
    lemma: t.text('lemma'), // canonical form
    frequencyRank: t.integer('frequency_rank'), // position in frequency list
    definition: t.text('definition'), // brief definition in native language
    // Sync metadata
    lastModified: t.integer('last_modified').notNull(), // unix epoch for sync
  });
}

// ---------------------------------------------------------------------------
// USER_VOCABULARY — FSRS spaced repetition state per word per user
// ---------------------------------------------------------------------------
export function makeUserVocabularyTable(t: TableFn) {
  return t('user_vocabulary', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    userId: t.text('user_id').notNull(),
    wordId: t.integer('word_id').notNull(), // FK to words.id
    // FSRS v5 core parameters
    difficulty: t.real('difficulty').notNull().default(0),
    stability: t.real('stability').notNull().default(0),
    retrievability: t.real('retrievability').notNull().default(0), // computed from stability + elapsed
    // FSRS scheduling
    nextReview: t.integer('next_review').notNull(), // unix epoch
    reps: t.integer('reps').notNull().default(0), // successful repetitions
    lapses: t.integer('lapses').notNull().default(0), // forgotten count
    elapsedDays: t.integer('elapsed_days').notNull().default(0),
    scheduledDays: t.integer('scheduled_days').notNull().default(0),
    // Edge-specific signals (extracted from single LLM response)
    lastErrorType: t.text('last_error_type'), // 'gender', 'conjugation', 'spelling', 'syntax'
    lastPronunciationScore: t.real('last_pronunciation_score'), // 0.0–1.0
    encounterCount: t.integer('encounter_count').notNull().default(0),
    // Context
    language: t.text('language').notNull(),
    // Sync
    lastModified: t.integer('last_modified').notNull(),
  });
}

// ---------------------------------------------------------------------------
// REVIEW_LOGS — History of reviews for FSRS analytics
// ---------------------------------------------------------------------------
export function makeReviewLogsTable(t: TableFn) {
  return t('review_logs', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    userId: t.text('user_id').notNull(),
    wordId: t.integer('word_id').notNull(),
    // FSRS review result
    rating: t.integer('rating').notNull(), // 1=Again, 2=Hard, 3=Good, 4=Easy
    state: t.text('state').notNull(), // 'new', 'learning', 'review', 'relearning'
    elapsedDays: t.integer('elapsed_days').notNull(),
    scheduledDays: t.integer('scheduled_days').notNull(),
    // Edge signals
    errorType: t.text('error_type'),
    pronunciationScore: t.real('pronunciation_score'),
    // Context at time of review
    cefrLevel: t.text('cefr_level'),
    sessionType: t.text('session_type').default('conversation'), // 'conversation', 'review', 'guided'
    // Timestamps
    reviewTime: t.integer('review_time').notNull(), // unix epoch
    lastModified: t.integer('last_modified').notNull(),
  });
}

// ---------------------------------------------------------------------------
// ACTIVE_GOALS — Goal Seeking Cycle (simplified for edge)
// ---------------------------------------------------------------------------
export function makeActiveGoalsTable(t: TableFn) {
  return t('active_goals', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    userId: t.text('user_id').notNull(),
    // Goal targeting
    goalType: t.text('goal_type').notNull(), // 'remediation', 'vocabulary', 'grammar'
    targetWordId: t.integer('target_word_id'), // word this goal targets
    targetErrorType: t.text('target_error_type'), // 'gender', 'conjugation', etc.
    priority: t.integer('priority').notNull().default(0), // lower = higher priority
    // Goal state
    status: t.text('status').notNull().default('active'), // 'active', 'completed', 'abandoned'
    successCount: t.integer('success_count').notNull().default(0), // consecutive successes
    failCount: t.integer('fail_count').notNull().default(0),
    // Completion: 2+ consecutive reps with success
    requiredSuccesses: t.integer('required_successes').notNull().default(2),
    // Metadata
    language: t.text('language').notNull(),
    createdAt: t.integer('created_at').notNull(),
    lastModified: t.integer('last_modified').notNull(),
  });
}

// ---------------------------------------------------------------------------
// SESSION_SUMMARIES — Cross-session memory
// ---------------------------------------------------------------------------
export function makeSessionSummariesTable(t: TableFn) {
  return t('session_summaries', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    userId: t.text('user_id').notNull(),
    language: t.text('language').notNull(),
    // Summary content
    topics: t.text('topics'), // comma-separated topic tags
    errorsSummary: t.text('errors_summary'), // brief error patterns observed
    nextSessionHint: t.text('next_session_hint'), // what to focus on next time
    wordsIntroduced: t.text('words_introduced'), // comma-separated word IDs
    wordsStruggled: t.text('words_struggled'), // comma-separated word IDs
    // Timing
    sessionStart: t.integer('session_start').notNull(),
    sessionEnd: t.integer('session_end').notNull(),
    lastModified: t.integer('last_modified').notNull(),
  });
}

// ---------------------------------------------------------------------------
// USER_NOTES — Durable learner insights (capped per category)
// ---------------------------------------------------------------------------
export function makeUserNotesTable(t: TableFn) {
  return t('user_notes', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    userId: t.text('user_id').notNull(),
    language: t.text('language').notNull(),
    category: t.text('category').notNull(), // 'weakness', 'strength', 'pattern', 'tip'
    content: t.text('content').notNull(),
    supersededById: t.integer('superseded_by_id'), // self-referential for supersession
    createdAt: t.integer('created_at').notNull(),
    lastModified: t.integer('last_modified').notNull(),
  });
}

// ---------------------------------------------------------------------------
// CEFR_WORD_LISTS — Pre-bundled vocabulary lists for edge (static data)
// ---------------------------------------------------------------------------
export function makeCefrWordListsTable(t: TableFn) {
  return t('cefr_word_lists', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    language: t.text('language').notNull(),
    cefrLevel: t.text('cefr_level').notNull(), // A1, A2, B1, B2, C1, C2
    // Word entry
    word: t.text('word').notNull(),
    lemma: t.text('lemma'),
    pos: t.text('pos'),
    definition: t.text('definition'), // in English (native language for target)
    frequencyRank: t.integer('frequency_rank'),
    // Edge: this table is read-only, shipped with the app
  });
}

// ===========================================================================
// CLOUD-ONLY TABLES (PostgreSQL + pgvector, not synced to edge)
// ===========================================================================

// ---------------------------------------------------------------------------
// WORD_EMBEDDINGS — pgvector semantic search (cloud only)
// ---------------------------------------------------------------------------
export function makeWordEmbeddingsTable(t: TableFn) {
  return t('word_embeddings', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    wordId: t.integer('word_id').notNull().unique(), // FK to words.id
    language: t.text('language').notNull(),
    // embedding vector is NOT included here — it's cloud-only
    // and requires pgvector which SQLite doesn't support
    // On cloud, add: embedding vector(1024) with HNSW index
    updatedAt: t.integer('updated_at').notNull(),
  });
}

// ---------------------------------------------------------------------------
// SUPERVISOR_ANALYSES — Structured LLM analysis output (cloud only)
// ---------------------------------------------------------------------------
export function makeSupervisorAnalysesTable(t: TableFn) {
  return t('supervisor_analyses', {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    userId: t.text('user_id').notNull(),
    sessionId: t.text('session_id').notNull(),
    turnIndex: t.integer('turn_index').notNull(),
    // Raw supervisor output
    detectedLanguage: t.text('detected_language'),
    languageConfidence: t.real('language_confidence'),
    // Where this analysis was produced
    source: t.text('source').notNull().default('cloud_supervisor'), // vs 'edge_extracted'
    createdAt: t.integer('created_at').notNull(),
  });
}

// ===========================================================================
// INDEXES (declared separately for PG/SQLite compatibility)
// ===========================================================================

/**
 * Cloud-only indexes (PostgreSQL + pgvector):
 *
 * words: CREATE INDEX idx_words_language_cefr ON words(language, cefr_level);
 * words: CREATE INDEX idx_words_frequency ON words(language, frequency_rank);
 * user_vocabulary: CREATE INDEX idx_uv_user_lang ON user_vocabulary(user_id, language);
 * user_vocabulary: CREATE INDEX idx_uv_next_review ON user_vocabulary(user_id, next_review);
 * user_vocabulary: CREATE INDEX idx_uv_last_modified ON user_vocabulary(user_id, last_modified);
 * active_goals: CREATE INDEX idx_goals_user_status ON active_goals(user_id, status, priority);
 * cefr_word_lists: CREATE INDEX idx_cefr_lang_level ON cefr_word_lists(language, cefr_level);
 * cefr_word_lists: CREATE INDEX idx_cefr_word ON cefr_word_lists(language, word);
 * word_embeddings: CREATE INDEX idx_emb_lang ON word_embeddings(language);
 * -- pgvector HNSW index added separately in cloud migration:
 * -- CREATE INDEX idx_emb_vector ON word_embeddings USING hnsw (embedding vector_cosine_ops);
 */

// ===========================================================================
// SYNC STRATEGY
// ===========================================================================

/**
 * Edge → Cloud sync:
 * 1. Each sync-capable table has `lastModified` (unix epoch)
 * 2. Edge app queues local writes with timestamp
 * 3. On sync: PUT /sync with rows where lastModified > lastSyncTime
 * 4. Cloud merges with last-write-wins per row
 * 5. Cloud returns updated rows (e.g., words discovered via vector expansion)
 * 6. Edge upserts returned rows
 *
 * Cloud-only data (word_embeddings, supervisor_analyses) never syncs to edge.
 * Edge uses CEFR word lists + LLM metadata extraction instead.
 *
 * Conflict resolution: last-write-wins on `lastModified`.
 * Auto-increment IDs are local-only; sync uses (userId, wordId, language) as natural keys.
 */