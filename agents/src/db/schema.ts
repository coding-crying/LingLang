import { pgTable, text, integer, real, boolean, timestamp, uuid, index, uniqueIndex, vector, primaryKey } from 'drizzle-orm/pg-core';
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
  id: text('id').primaryKey(), // UUID or 'lang:lemma:pos'
  lemma: text('lemma').notNull(),
  pos: text('pos').notNull(), // 'NOUN', 'VERB', etc.
  language: text('language').notNull(),
  translation: text('translation').notNull(), // target-language translation (or English meaning for target-lang entries)
  gender: text('gender'), // 'masc', 'fem', 'neuter', null
  morphFeatures: text('morph_features'), // JSON: detailed features from analysis
  unitId: text('unit_id').references(() => units.id),
  embedding: vector('embedding', { dimensions: 1024 }), // BGE-M3 1024d embedding
  frequencyRank: integer('frequency_rank'), // Lower = more common (1 = most frequent word in language)
  nativeLemma: text('native_lemma'), // Cross-language link: the user's native-language word this maps to (e.g. 'hello' → 'привет')
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
  // 2026-06-25: proficiencyLevel kept as a fallback default but the
  // tutor now reads from userLanguageLevels for per-language resolution.
  proficiencyLevel: text('proficiency_level').default('beginner'),

  // 2026-06-25: per-user auth. `username` is unique display name used at
  // login (case-insensitive). `passwordHash` is scrypt output (hex). Both
  // nullable so legacy rows continue to work; new users are created via
  // /api/register or src/scripts/seed-*.ts scripts.
  username: text('username').unique(),
  passwordHash: text('password_hash'),

  // 2026-07-16: self-serve signup (/api/signup). Not the login identifier
  // (username still is) — collected for contact/account-recovery purposes.
  // Nullable so pre-existing rows and admin-created (/api/register) users
  // without an email stay valid; Postgres UNIQUE allows multiple NULLs.
  email: text('email').unique(),

  // 2026-07-17: per-user Google API key (BYO) + a usage budget for anyone
  // riding on the shared/admin key instead — see lib/google-budget.ts.
  // Encrypted at rest (AES-256-GCM via lib/crypto.ts), never returned to
  // the client. Null = user is on the shared key.
  googleApiKeyEncrypted: text('google_api_key_encrypted'),
  // Accumulated estimated cost against the SHARED key this billing
  // period, in micros (millionths of a USD — avoids float rounding).
  // Only incremented for users with no key of their own; BYO-key users
  // are unlimited and this stays 0 for them.
  googleUsageMicros: integer('google_usage_micros').notNull().default(0),
  // Per-user override of the shared-key budget; null = use the
  // GOOGLE_SHARED_KEY_LIMIT_MICROS env default.
  googleUsageLimitMicros: integer('google_usage_limit_micros'),
  // Start of the current billing window; usage resets when this ages past
  // GOOGLE_USAGE_RESET_DAYS (lazy reset on read, no cron needed).
  googleUsagePeriodStart: timestamp('google_usage_period_start', { withTimezone: true }).notNull().defaultNow(),
});

// 2026-06-25: per-language proficiency replaces the global field for
// tutor-level lookups. The global `users.proficiencyLevel` is kept as
// a fallback only. Source of truth is this table.
export const usersRelations = relations(users, ({ many }) => ({
  progress: many(userVocabulary),
  activeGoals: many(activeGoals),
  sessionSummaries: many(sessionSummaries),
  userNotes: many(userNotes),
  languageLevels: many(userLanguageLevels),
  onboarding: many(userOnboarding),
}));

export const userLanguageLevels = pgTable('user_language_levels', {
  userId: text('user_id').notNull().references(() => users.id),
  languageCode: text('language_code').notNull(),         // 'pt', 'ru', 'es', ...
  proficiencyLevel: text('proficiency_level').notNull().default('pre_a1'),
  // 0.0..1.0 — how confident the inference is (vs manual override or onboarding)
  confidence: real('confidence').notNull().default(0.0),
  source: text('source').notNull().default('inferred'),  // 'inferred' | 'onboarding' | 'manual'
  inferredAt: timestamp('inferred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.languageCode] }),
}));

// --- User Style (personality mirroring) ---
// Detected from the user's turns over time. The processor emits a style signal
// per turn, which we EMA into the user's style profile. The conversation
// prompt reads this and tells the LLM to mirror the user's style.
export const userStyle = pgTable('user_style', {
  userId: text('user_id').notNull().references(() => users.id),
  styleKey: text('style_key').notNull(),  // 'humor' | 'pacing' | 'register' | 'profanity' | 'preamble' | 'bsCallouts'
  styleValue: text('style_value').notNull(),
  // 0.0..1.0 — EMA confidence. Starts at 0 (no signal) and grows with samples.
  confidence: real('confidence').notNull().default(0.0),
  sampleSize: integer('sample_size').notNull().default(0),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.styleKey] }),
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
  nativeSubstitutionCount: integer('native_substitution_count').notNull().default(0), // Times user used native word instead of target

  // Review meta
  lastReview: timestamp('last_review', { withTimezone: true }),
  avgPronunciationScore: real('avg_pronunciation_score'),

  // Receptive knowledge (2026-07-10, learner-field spec §3.1) — comprehension
  // exposure tracked separately from FSRS production evidence. Not scheduled;
  // just a count + rolling signal used to build the introduction queue (words
  // heard/read but never produced).
  receptiveExposures: integer('receptive_exposures').notNull().default(0),
  lastExposure: timestamp('last_exposure', { withTimezone: true }),
  comprehensionSignal: real('comprehension_signal').notNull().default(0), // rolling -1..+1

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

  // 2026-07-10, learner-field spec §3.2 — evidence weight/trust source.
  // 'probe': selector-directed elicitation, closed-form judgment (highest
  // trust). 'conversation': passive inference from open dialogue (default,
  // legacy rows backfill to this). 'echo': should not normally reach
  // review_logs at all (the echo gate in updateSRSFromAnalysis intercepts
  // before grading) — value exists for completeness/debugging only.
  provenance: text('provenance').notNull().default('conversation'),
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

  // 2026-07-02: goals were unscoped by language, so a Portuguese remediation
  // goal ("preservativo") surfaced in a Russian session's planner prompt
  // (confirmed live). Nullable like session_summaries.language_code:
  // existing rows are backfilled from their target lexeme's language where
  // resolvable; unresolvable rows stay null and drop out of per-language
  // queries.
  languageCode: text('language_code'),
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

// --- Session Summaries (cross-session memory) ---
export const sessionSummaries = pgTable('session_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id),
  // 2026-07-02: nullable because pre-existing rows predate this column and
  // have no recorded language — they're excluded from per-language queries
  // rather than backfilled (unrecoverable which language they were in).
  // Without this, a user who has ever tested/studied multiple target
  // languages gets summaries from ALL of them mixed into one language's
  // planner context (confirmed live: Russian vocabulary hints "use привет"
  // bleeding into a Portuguese session).
  languageCode: text('language_code'),

  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
  durationMinutes: integer('duration_minutes').notNull(),

  topicsCovered: text('topics_covered'),      // free-form: "food, restaurant phrases"
  wordsWorked: text('words_worked'),           // JSON array of lexeme IDs
  errorsPattern: text('errors_pattern'),       // "struggled with accusative case"
  summary: text('summary').notNull(),          // 2-3 sentence narrative
  nextSessionHint: text('next_session_hint'),  // what to focus on next time

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('session_summaries_user_idx').on(table.userId),
  index('session_summaries_user_lang_idx').on(table.userId, table.languageCode),
]);

export const sessionSummariesRelations = relations(sessionSummaries, ({ one }) => ({
  user: one(users, {
    fields: [sessionSummaries.userId],
    references: [users.id],
  }),
}));

// --- User Notes (durable learner insights) ---
export const userNotes = pgTable('user_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id),

  category: text('category').notNull(),  // 'preference', 'level', 'frustration', 'goal', 'engagement'
  content: text('content').notNull(),     // one sentence
  source: text('source').notNull(),       // 'onboarding', 'observed', 'user_stated'

  supersededById: uuid('superseded_by_id').references((): any => userNotes.id),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('user_notes_user_category_idx').on(table.userId, table.category),
]);

export const userNotesRelations = relations(userNotes, ({ one }) => ({
  user: one(users, {
    fields: [userNotes.userId],
    references: [users.id],
  }),
  supersededBy: one(userNotes, {
    fields: [userNotes.supersededById],
    references: [userNotes.id],
    relationName: 'superseded',
  }),
}));

// --- User Persona (adaptive conversation shell) ---
// The writable layer of the conversation agent's prompt.
// Supervisor, user voice, and UI can all write here.
// language_code = 'all' means applies to all languages for this user.
export const userPersona = pgTable('user_persona', {
  userId: text('user_id').notNull().references(() => users.id),
  languageCode: text('language_code').notNull(),  // 'pt' | 'ru' | 'all'

  // Free-text persona override — replaces the default base persona line when set.
  personaOverride: text('persona_override'),

  // Structured teaching style
  tone: text('tone'),               // 'roast' | 'warm' | 'neutral' | 'formal' | 'drill-sergeant'
  correctionStyle: text('correction_style'), // 'immediate' | 'gentle' | 'ignore' | 'end-of-turn'
  teachingMode: text('teaching_mode'),       // 'conversational' | 'drill' | 'roleplay' | 'storytelling'
  extraInstructions: text('extra_instructions'), // freeform: "always use tu form", "pretend we're at a café"

  source: text('source').notNull().default('system'), // 'system' | 'supervisor' | 'user_voice' | 'ui'
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.languageCode] }),
}));

// ── Onboarding ──────────────────────────────────────────────────────────────
// One row per (user, language). Tracks background, goals, and the anchored
// level produced by either the UI form or the voice onboarding flow.
// The supervisor reads this to know whether to run onboarding nudges.
// The processor writes onboarding_signal triggers when it detects background
// or goal statements in the user's speech.
export const userOnboarding = pgTable('user_onboarding', {
  userId:           text('user_id').notNull().references(() => users.id),
  languageCode:     text('language_code').notNull(),
  // completion flags — either path counts
  uiComplete:       boolean('ui_complete').notNull().default(false),
  voiceComplete:    boolean('voice_complete').notNull().default(false),
  // captured background
  priorStudy:       text('prior_study'),       // 'none'|'self_taught'|'class'|'immersion'|'heritage'
  studyDetails:     text('study_details'),     // "Duolingo 6 months", "Pimsleur level 2"
  goals:            text('goals').array(),     // ['travel','work','heritage','media','academic','other']
  goalDetails:      text('goal_details'),
  selfRatedLevel:   text('self_rated_level'),  // user's own CEFR estimate
  // Legacy — written by the removed commitOnboardingLevel (learner-field
  // spec §6.5, 2026-07-10). No longer written; kept for historical rows,
  // not read by any current code path.
  anchoredLevel:    text('anchored_level'),
  anchorConfidence: real('anchor_confidence'),
  anchorEvidence:   text('anchor_evidence'),
  startedAt:        timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt:      timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.languageCode] }),
}));

export const userOnboardingRelations = relations(userOnboarding, ({ one }) => ({
  user: one(users, { fields: [userOnboarding.userId], references: [users.id] }),
}));

// ── Curriculum ──────────────────────────────────────────────────────────────
// See docs/superpowers/specs/2026-07-06-curriculum-design.md. Ingested
// content (textbooks, audio, YouTube) is chunked and distilled offline;
// chunk_lexemes joins to the EXISTING lexemes table so FSRS, the dictionary
// gate, embeddings, and the frontier all see curriculum vocab for free —
// vocab that isn't a lexeme row is invisible to the rest of the loop.
export const contentSources = pgTable('content_sources', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id), // null = shared/global catalog
  language: text('language').notNull(),
  kind: text('kind').notNull(), // 'textbook' | 'audio' | 'youtube' | 'text'
  title: text('title').notNull(),
  originalRef: text('original_ref'), // file path / URL
  status: text('status').notNull().default('uploaded'), // 'uploaded' | 'ingesting' | 'ready' | 'failed'
  ingestError: text('ingest_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contentSourcesRelations = relations(contentSources, ({ one, many }) => ({
  owner: one(users, { fields: [contentSources.ownerId], references: [users.id] }),
  chunks: many(contentChunks),
}));

export const contentChunks = pgTable('content_chunks', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => contentSources.id),
  ord: integer('ord').notNull(), // reading order within source
  parentTitle: text('parent_title'), // chapter, for grouping in UI
  title: text('title').notNull(),
  body: text('body').notNull(), // cleaned chunk text, ~500-1500 tokens
  // summary/card/grammarPoints/difficulty/embedding are all null until
  // ensureChunkDistilled() runs (lib/ingest.ts) — lazily, the first time a
  // learner actually reaches this chunk, not eagerly at ingestion. See
  // distilledAt below.
  summary: text('summary'), // 2-3 sentences, planner-facing
  card: text('card'), // distilled lesson card, <=200 tokens, prompt-ready
  grammarPoints: text('grammar_points'), // JSON: [{rule, example, explanation}]
  difficulty: text('difficulty'),
  // Only set for timed sources (youtube/movie) — see lib/ingest.ts's
  // segmentTimedText. Null for text/textbook/audio, where `title` comes
  // from heading detection instead of a time range.
  startSec: real('start_sec'),
  endSec: real('end_sec'),
  embedding: vector('embedding', { dimensions: 1024 }), // BGE-M3, same as lexemes
  // Set once ensureChunkDistilled() has run for this chunk — the signal
  // that summary/card/chunk_lexemes/embedding are actually populated,
  // distinct from "genuinely has no vocab" (computeCoverage would
  // otherwise read an undistilled chunk's empty vocab list as trivially
  // 100% covered — see curriculum.ts's listSourceChunks).
  distilledAt: timestamp('distilled_at', { withTimezone: true }),
}, (table) => [
  index('content_chunks_source_ord_idx').on(table.sourceId, table.ord),
  index('content_chunks_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const contentChunksRelations = relations(contentChunks, ({ one, many }) => ({
  source: one(contentSources, { fields: [contentChunks.sourceId], references: [contentSources.id] }),
  lexemeLinks: many(chunkLexemes),
  progress: many(userContentProgress),
}));

export const chunkLexemes = pgTable('chunk_lexemes', {
  chunkId: text('chunk_id').notNull().references(() => contentChunks.id),
  lexemeId: text('lexeme_id').notNull().references(() => lexemes.id),
  salience: real('salience').notNull().default(0.5), // how central to the chunk, 0-1
}, (t) => ({
  pk: primaryKey({ columns: [t.chunkId, t.lexemeId] }),
}));

export const chunkLexemesRelations = relations(chunkLexemes, ({ one }) => ({
  chunk: one(contentChunks, { fields: [chunkLexemes.chunkId], references: [contentChunks.id] }),
  lexeme: one(lexemes, { fields: [chunkLexemes.lexemeId], references: [lexemes.id] }),
}));

export const userContentProgress = pgTable('user_content_progress', {
  userId: text('user_id').notNull().references(() => users.id),
  chunkId: text('chunk_id').notNull().references(() => contentChunks.id),
  status: text('status').notNull().default('queued'), // 'queued' | 'active' | 'done' | 'skipped'
  coverage: real('coverage').notNull().default(0), // computed, see lib/curriculum.ts
  cardOverride: text('card_override'), // planner-adapted card, see design doc §3/§6
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.chunkId] }),
  activeIdx: index('user_content_progress_active_idx').on(t.userId, t.status),
}));

export const userContentProgressRelations = relations(userContentProgress, ({ one }) => ({
  user: one(users, { fields: [userContentProgress.userId], references: [users.id] }),
  chunk: one(contentChunks, { fields: [userContentProgress.chunkId], references: [contentChunks.id] }),
}));

// ── Discourse memory & grammar analytics ────────────────────────────────────
// The word layer (user_vocabulary, review_logs) is already durable. What's
// missing is the utterance/discourse level above it — which sentence, which
// grammar context, which conversation an error happened in. Written
// fire-and-forget from runProcessor's completion hook; nothing reads these
// yet (Phase M is record-only by design — zero behavioral risk).
export const utterances = pgTable('utterances', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id),
  sessionId: text('session_id').notNull(),
  turnSeq: integer('turn_seq').notNull(),
  language: text('language').notNull(),
  transcript: text('transcript').notNull(), // the cascade's clean pass-1 output
  analysis: text('analysis'), // JSON: processor result for this turn
  embedding: vector('embedding', { dimensions: 1024 }), // BGE-M3, same service as lexemes
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('utterances_user_idx').on(table.userId, table.createdAt),
  index('utterances_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const utterancesRelations = relations(utterances, ({ one, many }) => ({
  user: one(users, { fields: [utterances.userId], references: [users.id] }),
  errors: many(errorObservations),
}));

// Canonical-tag mapping is the linchpin: the processor's free-text rule
// labels ("genitive after negation" / "wrong case after не") never
// aggregate on their own. ruleId maps each label to its nearest grammar_rules
// row (via that table's existing, currently-unused embeddings); below a
// cosine threshold, ruleId stays null and ruleText is kept as-is. Once
// mapped, "weak grammar patterns" is a plain GROUP BY, no LLM in the read
// path — the processor's extraction fidelity is what bounds this table's
// quality, hence a two-pass cascade there matters more than clever queries
// here.
export const errorObservations = pgTable('error_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id),
  language: text('language').notNull(),
  ruleId: text('rule_id').references(() => grammarRules.id), // canonical tag, nullable until mapped
  ruleText: text('rule_text').notNull(), // processor's raw free-text label
  lexemeId: text('lexeme_id').references(() => lexemes.id),
  snippet: text('snippet'), // the offending fragment
  utteranceId: uuid('utterance_id').references(() => utterances.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('error_observations_user_rule_idx').on(table.userId, table.ruleId),
]);

export const errorObservationsRelations = relations(errorObservations, ({ one }) => ({
  user: one(users, { fields: [errorObservations.userId], references: [users.id] }),
  rule: one(grammarRules, { fields: [errorObservations.ruleId], references: [grammarRules.id] }),
  lexeme: one(lexemes, { fields: [errorObservations.lexemeId], references: [lexemes.id] }),
  utterance: one(utterances, { fields: [errorObservations.utteranceId], references: [utterances.id] }),
}));
