-- Lazy chunk distillation: ingestion now only extracts+segments (cheap,
-- local, no LLM calls) and inserts raw chunk rows immediately. The
-- expensive stage (distillChunk + linkChunkVocab + embedChunk) runs later,
-- on demand, only for chunks a learner actually reaches — most chunks in a
-- long source may never be read, so paying for all of them up front was
-- wasted spend on top of a slow first-ready wait.
-- Migration: 2026-07-19

ALTER TABLE "content_chunks" ALTER COLUMN "summary" DROP NOT NULL;
ALTER TABLE "content_chunks" ALTER COLUMN "card" DROP NOT NULL;
ALTER TABLE "content_chunks" ADD COLUMN IF NOT EXISTS "distilled_at" timestamp with time zone;
