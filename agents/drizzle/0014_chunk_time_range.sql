-- Per-chunk time range for timed sources (YouTube/movie) — lets ingestion
-- record real start/end offsets instead of collapsing everything to
-- "Untitled (part N)", so a chunk browser can show recognizable labels
-- like "12:30-15:00" for content with no chapter-heading structure.
-- Migration: 2026-07-19

ALTER TABLE "content_chunks" ADD COLUMN IF NOT EXISTS "start_sec" real;
ALTER TABLE "content_chunks" ADD COLUMN IF NOT EXISTS "end_sec" real;
