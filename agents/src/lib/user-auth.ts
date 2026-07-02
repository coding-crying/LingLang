/**
 * Per-user authentication helpers.
 *
 * 2026-06-25: replaces the single shared DASHBOARD_PASSWORD env var with
 * per-user scrypt-hashed credentials stored on the users table.
 *
 * - hashPassword: scrypt with a static salt (sufficient for this app's threat
 *   model — see SECURITY.md for the rationale).
 * - verifyPassword: constant-time compare.
 * - createUser: insert a new user with a hashed password.
 * - authenticateByUsername: lookup by username (case-insensitive in the UI,
 *   exact match in the DB; the UI lowercases before sending).
 */

import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

const HASH_KEYLEN = 64;
const HASH_SALT = process.env.DASHBOARD_PASSWORD_SALT || 'linglang-dashboard-2026';

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, HASH_SALT, HASH_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const hash = await hashPassword(password);
  // Both are 64-byte hex strings — same length, so timingSafeEqual is safe.
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

export interface CreateUserOpts {
  id: string;
  username: string;
  password: string;
  targetLanguage?: string;
  nativeLanguage?: string;
  proficiencyLevel?: string;
}

export async function createUser(opts: CreateUserOpts): Promise<void> {
  const passwordHash = await hashPassword(opts.password);
  await db.insert(users).values({
    id: opts.id,
    username: opts.username,
    passwordHash,
    targetLanguage: opts.targetLanguage || 'ru',
    nativeLanguage: opts.nativeLanguage || 'en',
    proficiencyLevel: opts.proficiencyLevel || 'beginner',
  });
}

export async function authenticateByUsername(
  username: string,
  password: string,
): Promise<{ id: string; username: string } | null> {
  // Case-insensitive lookup: the UI form is human-typed, so we want
  // "will" / "Will" / "WILL" to all work. Postgres `=` on `text` is
  // case-sensitive, but `LOWER(a) = LOWER(b)` matches equivalently and
  // lets us keep the stored value in its original case for display.
  const user = await db.query.users.findFirst({
    where: sql`LOWER(${users.username}) = LOWER(${username})`,
  });
  if (!user || !user.passwordHash) return null;
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;
  return { id: user.id, username: user.username! };
}
