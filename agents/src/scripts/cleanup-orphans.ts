// 2026-06-25: Cleanup orphan user rows.
// Orphans are users that:
//   1. Have no auth (password_hash IS NULL) — they can never log in
//   2. AND look auto-generated: identity-* prefix, @matrix:... pattern,
//      or any of the named test/debug rows
//
// SAFETY RULES:
//   - Real named humans (e.g. "heather", or anyone with a real-sounding
//     id we don't recognize) are PRESERVED and just listed for review.
//   - Users with significant vocab (>50 rows) are PRESERVED — that's
//     real progress we shouldn't destroy.
//   - Dry-run by default; pass --yes to actually delete.

import { db } from '../db/index.js';
import { users, userVocabulary, userLanguageLevels } from '../db/schema.js';
import { isNull, sql, inArray, eq, and, ne } from 'drizzle-orm';

const APPLY = process.argv.includes('--yes');

// Heuristic for "auto-generated / not a real person"
const AUTO_ID_PATTERN = /^(identity-|@.+:matrix\.|<local-participant>|dashboard-user|eval-beginner-|text-test-user)/i;

interface AuditRow {
  id: string;
  vocabCount: number;
  hasLevels: boolean;
  decision: 'delete' | 'preserve-real' | 'preserve-data';
  reason: string;
}

async function main() {
  // Count vocab per user in one query
  const counts: any = await db.execute(sql`
    SELECT user_id, COUNT(*)::int AS n
    FROM user_vocabulary
    GROUP BY user_id;
  `);
  const countRows: Array<{ user_id: string; n: number }> =
    Array.isArray(counts) ? counts : (counts.rows ?? []);
  const vocabByUser = new Map(countRows.map((r) => [r.user_id, r.n]));

  // Get all users with no auth
  const all = await db.query.users.findMany({
    where: isNull(users.passwordHash),
    orderBy: (u, { asc }) => [asc(u.id)],
  });

  const audit: AuditRow[] = [];
  const toDelete: string[] = [];
  const preserved: AuditRow[] = [];

  for (const u of all) {
    const vocab = vocabByUser.get(u.id) ?? 0;
    const looksAuto = AUTO_ID_PATTERN.test(u.id);

    let decision: AuditRow['decision'];
    let reason: string;

    if (looksAuto) {
      decision = 'delete';
      reason = `auto-generated id matches ${AUTO_ID_PATTERN}`;
    } else if (vocab > 50) {
      decision = 'preserve-data';
      reason = `${vocab} vocab rows — real progress, needs human review`;
    } else {
      decision = 'preserve-real';
      reason = `looks like a real person (id="${u.id}"), needs human review`;
    }

    audit.push({ id: u.id, vocabCount: vocab, hasLevels: false, decision, reason });
    if (decision === 'delete') toDelete.push(u.id);
    else preserved.push(audit[audit.length - 1]);
  }

  console.log(`\n=== Audit (${audit.length} users with no auth) ===\n`);
  console.log('TO DELETE:');
  for (const r of audit.filter((r) => r.decision === 'delete')) {
    console.log(`  ${r.id}  (vocab=${r.vocabCount})  — ${r.reason}`);
  }
  console.log(`\nPRESERVE (${preserved.length}) — review manually:`);
  for (const r of preserved) {
    console.log(`  ${r.id}  (vocab=${r.vocabCount})  — ${r.reason}`);
  }

  if (!APPLY) {
    console.log(`\n[DRY-RUN] Would delete ${toDelete.length} users.`);
    console.log(`Re-run with --yes to actually delete.`);
    process.exit(0);
  }

  if (toDelete.length === 0) {
    console.log('\nNothing to delete.');
    process.exit(0);
  }

  // FK cascade handles user_vocabulary, user_language_levels, etc. — verify:
  // user_vocabulary.user_id has ON DELETE CASCADE? If not, we need to delete
  // children first. Let's check the FK definition.
  console.log(`\nDeleting ${toDelete.length} users...`);

  // Check if any FK is restrictive (would block the delete)
  const fkCheck: any = await db.execute(sql`
    SELECT conname, confdeltype
    FROM pg_constraint
    WHERE conrelid = 'user_vocabulary'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%users%';
  `);
  const fkRows: Array<{ conname: string; confdeltype: string }> =
    Array.isArray(fkCheck) ? fkCheck : (fkCheck.rows ?? []);
  const restrictiveFks = fkRows.filter((f) => f.confdeltype === 'r');
  if (restrictiveFks.length > 0) {
    console.error(`\n✗ Restrictive FKs found, can't cascade:`, restrictiveFks);
    console.error(`Need to delete children first or relax FK. Aborting.`);
    process.exit(1);
  }
  console.log(`  FK check passed (no restrictive constraints on user_vocabulary).`);

  // Delete in chunks to avoid huge single-statement
  const CHUNK = 50;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK);
    await db.delete(users).where(inArray(users.id, chunk));
    deleted += chunk.length;
    console.log(`  Deleted ${deleted}/${toDelete.length}`);
  }

  // Verify
  const remaining = await db.query.users.findMany({
    where: isNull(users.passwordHash),
  });
  console.log(`\n=== Done ===`);
  console.log(`Users deleted: ${deleted}`);
  console.log(`Users with no auth remaining: ${remaining.length}`);
  for (const r of remaining) {
    console.log(`  ${r.id}`);
  }

  // Final summary
  const totalUsers = await db.query.users.findMany();
  const withAuth = totalUsers.filter((u) => u.passwordHash);
  console.log(`\nTotal users now: ${totalUsers.length} (${withAuth.length} with auth)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
