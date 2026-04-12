# LingLang FSRS + pgvector Migration — Implementation Log

**Date:** 2026-04-11  
**Branch:** `feat/pgvector-fsrs`

## What was done

Migrated LingLang's SRS system from SQLite + Leitner boxes (levels 0-5) to **PostgreSQL 16 + pgvector + FSRS (Free Spaced Repetition Scheduler)** with continuous grading and semantic ripple effects.

### Infrastructure
- **Docker:** Added `docker-compose.yml` with `pgvector/pgvector:pg16` container on port 5433
- **Embed server:** llama-swap on port 8091 with 3 models: nomic-embed-text-v1.5 (768d, OpenClaw), bge-m3 (1024d, LingLang), jina-v5-small (1024d, backup)
- **Verified:** pgvector 0.8.2 extension, HNSW indexes, BGE-M3 returns 1024d vectors

### Database Schema (`agents/src/db/schema.ts`)
- Switched from `drizzle-orm/sqlite-core` → `drizzle-orm/pg-core`
- **Replaced** `learningProgress` table (Leitner: srsLevel 0-5, nextReview, lastSeen, encounters, correctUses) with:
  - `userVocabulary` — FSRS continuous tracking: `state` (0-3), `due` (timestamp), `stability`, `difficulty`, `elapsedDays`, `scheduledDays`, `reps`, `lapses`, `lastReview`, `avgPronunciationScore`
  - `reviewLogs` — per-review snapshots for FSRS optimizer: grade 1-4, state/stability/difficulty snapshots, `escalationLevelUsed`, `pronunciationScore`, `durationMs`
- **Added** `embedding vector(1024)` column on `lexemes` and `grammarRules`
- **Added** HNSW indexes for nearest-neighbor semantic search
- **Changed** timestamps from `integer` (epoch ms) → `timestamp with time zone` with `defaultNow()`
- **Changed** auto-increment IDs to UUID (`defaultRandom()`) for `userVocabulary` and `reviewLogs`
- Kept: `units`, `users`, `duolingoMetadata`, `activeGoals` (minimal changes)

### DB Driver (`agents/src/db/index.ts`)
- Switched from `better-sqlite3` → `postgres` (postgres.js)
- Connection via `DATABASE_URL` env var, default `postgresql://linglang:linglang_dev@localhost:5433/linglang`

### FSRS Algorithm (`agents/src/lib/fsrs.ts`)
- **`fsrsReview(card, grade)`** — core algorithm using FSRS v5 parameters
- **`voiceToGrade(performance)`** — maps voice performance to FSRS grades 1-4:
  - Grade 1 (Again): `recall_fail` or `wrong_use`, failed even at escalation level 3
  - Grade 2 (Hard): `correct_use` after escalation 2, or poor pronunciation/latency
  - Grade 3 (Good): `correct_use` at level 1 (default pass)
  - Grade 4 (Easy): `correct_use` unprompted with fluent pronunciation
- **`leitnerToFSRS(level)`** — converts Leitner 0-5 to approximate FSRS initial state (for migration)

### Supervisor (`agents/src/tools/supervisor-functions.ts`)
- Replaced Leitner box logic with FSRS grading
- Each review: maps performance → FSRS grade → `fsrsReview()` → update `userVocabulary`
- Logs review snapshots to `reviewLogs` before updating state
- **Semantic ripple**: after a word review, finds 5 nearest neighbors via `lexemes.embedding` HNSW, applies fractional stability adjustments (±0.02) scaled by cosine distance

### Duolingo Integration (duolingo.ts)
- `mapStrengthToFSRS()`: Duolingo strength (0.0-1.0) → approximate FSRS (state, stability, difficulty)
- **Guard**: Duolingo sync creates entries with `reps: 0`. Voice tutor sets `reps ≥ 1`. Future Duolingo syncs skip words where `reps > 0`, preserving tutor-refined state.

### Context Manager (context.ts)
- Due reviews: `userVocabulary.due <= now()` instead of `learningProgress.nextReview`
- New vocabulary: `userVocabulary.state = 0` instead of `learningProgress.srsLevel = 0`
- Struggling words: `userVocabulary.state = 1` (Learning) instead of `srsLevel = 1`
- **New:** `getSemanticNeighbors(lexemeId, limit)` — pgvector HNSW nearest-neighbor query

### Dashboard
- State distribution: `state` (New/Learning/Review/Relearning) instead of `srsLevel` (0-5)
- Word display: shows FSRS state label + stability/difficulty instead of SRS level
- Activity feed: uses `lastReview` timestamps instead of `lastSeen` epoch ms

### Embedding Pipeline (`agents/src/scripts/embed-lexemes.ts`)
- Batch embeds all lexemes via BGE-M3 on localhost:8091
- Input: `lemma + translation`, 50-100 per batch
- Updates `lexemes.embedding` column (vector 1024d)

### Key Decisions
- **No `semantic_vector` on `userVocabulary`** — embeddings live on `lexemes.embedding` (shared, not duplicated per user). Ripple queries JOIN through the FK.
- **BGE-M3 over Jina v5** — Jina requires task-specific prefix tokens (`Retrieve: `) that don't work through llama.cpp. BGE-M3 works out of the box with 0.91 cross-lingual similarity for Russian.
- **Duolingo as seeder, not overwriter** — `reps: 0` flag prevents Duolingo from overwriting voice-tutor-refined FSRS state.
- **Timestamps are `Date` objects** — not epoch numbers. The schema uses `timestamp with time zone` with `defaultNow()`. All `createdAt: Date.now()` calls removed; omitted columns get server defaults.

### Not Yet Done
- `seed.ts` — still references SQLite API, needs PG rewrite
- `migrate.ts` — old SQLite migration script, uses `db.run()` (PG incompatible)
- Dashboard CSS — `srs-badge` styles may need updating for state labels vs numbered levels
- Front-end testing — no text mode agent test harness yet