/**
 * Per-user authentication helpers.
 *
 * 2026-06-25: replaces the single shared DASHBOARD_PASSWORD env var with
 * per-user scrypt-hashed credentials stored on the users table.
 * 2026-07-03: switched to a random per-user salt (stored as "salt:hash" in
 * the same column) after a security review flagged the old static salt —
 * one leaked salt used to mean every password in the table was crackable
 * together. Old-format hashes (no colon) still verify against the legacy
 * static salt so existing accounts aren't locked out; anything hashed from
 * now on gets a fresh random salt.
 *
 * - hashPassword: scrypt with a random salt, returned as "salt:hash".
 * - verifyPassword: constant-time compare; always pays the scrypt cost even
 *   for a nonexistent user (see authenticateByUsername) so response timing
 *   doesn't leak which usernames exist.
 * - createUser: insert a new user with a hashed password.
 * - authenticateByUsername: lookup by username (case-insensitive in the UI,
 *   exact match in the DB; the UI lowercases before sending).
 */

import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

const HASH_KEYLEN = 64;
// Only used to verify pre-2026-07-03 hashes that predate per-user salts.
const LEGACY_SALT = process.env.DASHBOARD_PASSWORD_SALT || 'linglang-dashboard-2026';
// Constant stand-in hash so a lookup miss still pays for one scrypt call.
const DUMMY_HASH = `${LEGACY_SALT}:${'0'.repeat(HASH_KEYLEN * 2)}`;

function scryptHash(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, HASH_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptHash(password, salt);
  return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const sepIdx = stored.indexOf(':');
  const salt = sepIdx === -1 ? LEGACY_SALT : stored.slice(0, sepIdx);
  const hash = sepIdx === -1 ? stored : stored.slice(sepIdx + 1);
  const candidate = await scryptHash(password, salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface CreateUserOpts {
  id: string;
  username: string;
  password: string;
  email?: string;
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
    email: opts.email || null,
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
  // Always pay the scrypt cost, even when the username doesn't exist or has
  // no password set, so a timing side-channel can't be used to enumerate
  // valid usernames.
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !valid) return null;
  return { id: user.id, username: user.username! };
}
