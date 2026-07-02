/**
 * Seed Robert as a new user with username=Robert, password=Robert,
 * targetLanguage=ar (Arabic — which is already in LANGUAGES, so the
 * tutor config will work out of the box).
 *
 * Also backfills Will's row with username=will, password=will so the
 * existing shared password still works for him.
 *
 * Idempotent: if the user already exists, just verifies the password
 * matches what's expected.
 */
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { authenticateByUsername, createUser, hashPassword } from '../lib/user-auth.js';

const TARGET_PASSWORD = 'Robert';

async function ensureUser(opts: {
  id: string;
  username: string;
  password: string;
  targetLanguage: string;
  nativeLanguage: string;
}): Promise<void> {
  const existing = await db.query.users.findFirst({ where: eq(users.id, opts.id) });

  if (existing) {
    console.log(`[seed] User ${opts.id} already exists. Row:`, {
      id: existing.id,
      username: existing.username,
      targetLanguage: existing.targetLanguage,
      nativeLanguage: existing.nativeLanguage,
      hasPassword: !!existing.passwordHash,
    });

    // Backfill username/password if missing or mismatched.
    if (!existing.passwordHash || !existing.username) {
      const passwordHash = await hashPassword(opts.password);
      await db
        .update(users)
        .set({ username: opts.username, passwordHash })
        .where(eq(users.id, opts.id));
      console.log(`[seed] Backfilled auth for ${opts.id}.`);
    }

    const ok = await authenticateByUsername(opts.username, opts.password);
    if (ok) {
      console.log(`[seed] ✓ Login as ${opts.username}/${opts.password} works.`);
    } else {
      console.warn(`[seed] ✗ Login as ${opts.username}/${opts.password} FAILED — check password.`);
    }
    return;
  }

  await createUser(opts);
  console.log(`[seed] ✓ Created user: id=${opts.id} username=${opts.username} password=${opts.password} targetLanguage=${opts.targetLanguage}`);

  const ok = await authenticateByUsername(opts.username, opts.password);
  if (!ok) throw new Error(`Just-created user ${opts.username} failed to authenticate.`);
  console.log(`[seed] ✓ Verified login: ${opts.username}/${opts.password}.`);
}

async function main() {
  // Will: keep him on Portuguese. He was at pt already.
  await ensureUser({
    id: 'will',
    username: 'will',
    password: 'will',
    targetLanguage: 'pt',
    nativeLanguage: 'en',
  });

  // Robert: new user, learning Arabic.
  await ensureUser({
    id: 'robert',
    username: 'Robert',
    password: TARGET_PASSWORD,
    targetLanguage: 'ar',
    nativeLanguage: 'en',
  });

  console.log('\n[seed] All users:');
  const all = await db.query.users.findMany();
  for (const u of all) {
    console.log(`  ${u.id}: username=${u.username} target=${u.targetLanguage} native=${u.nativeLanguage} hasPw=${!!u.passwordHash}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
