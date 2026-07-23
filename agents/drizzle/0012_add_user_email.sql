-- Add email for self-serve signup (/api/signup).
-- Migration: 2026-07-16
-- Not the login identifier (username still is) -- collected for
-- contact/account-recovery. Nullable so existing rows stay valid.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text UNIQUE;

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email");
