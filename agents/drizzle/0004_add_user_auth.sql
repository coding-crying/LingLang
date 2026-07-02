-- Add username + password_hash for per-user dashboard auth.
-- Migration: 2026-06-25
-- Replaces the single shared DASHBOARD_PASSWORD env var with per-user
-- scrypt-hashed credentials stored in the users table.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text UNIQUE;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;

CREATE UNIQUE INDEX IF NOT EXISTS "users_username_idx" ON "users" ("username");
