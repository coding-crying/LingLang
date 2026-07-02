// One-off DB inspection for multi-user readiness.
import { db } from '../db/index.js';
import { users, userVocabulary, userLanguageLevels, userStyle } from '../db/schema.js';
import { sql, isNotNull } from 'drizzle-orm';

async function main() {
  const total = await db.select({ c: sql<number>`count(*)::int` }).from(users);
  const withAuth = await db.select({ c: sql<number>`count(*)::int` }).from(users).where(isNotNull(users.passwordHash));
  const withUsername = await db.select({ c: sql<number>`count(*)::int` }).from(users).where(isNotNull(users.username));
  const langLvl = await db.select({ c: sql<number>`count(*)::int` }).from(userLanguageLevels);
  const style = await db.select({ c: sql<number>`count(*)::int` }).from(userStyle);
  const vocab = await db.select({ c: sql<number>`count(*)::int` }).from(userVocabulary);

  console.log('=== Counts ===');
  console.log(`  users total:                  ${total[0].c}`);
  console.log(`  users with username:          ${withUsername[0].c}`);
  console.log(`  users with passwordHash:      ${withAuth[0].c}`);
  console.log(`  user_language_levels rows:    ${langLvl[0].c}`);
  console.log(`  user_style rows:              ${style[0].c}`);
  console.log(`  user_vocabulary rows:         ${vocab[0].c}`);

  console.log('\n=== FK constraints to users ===');
  const fks: any = await db.execute(sql`
    SELECT tc.table_name AS table_name, kcu.column_name AS column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage ccu
        WHERE ccu.constraint_name = tc.constraint_name
          AND ccu.table_name = 'users'
      )
    ORDER BY tc.table_name, kcu.column_name;
  `);
  const fkRows: Array<{ table_name: string; column_name: string }> =
    Array.isArray(fks) ? fks : (fks.rows ?? []);
  for (const r of fkRows) {
    console.log(`  ${r.table_name}.${r.column_name}`);
  }

  console.log('\n=== Indexes on users ===');
  const idx: any = await db.execute(sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'users'
    ORDER BY indexname;
  `);
  const idxRows: Array<{ indexname: string; indexdef: string }> =
    Array.isArray(idx) ? idx : (idx.rows ?? []);
  for (const r of idxRows) {
    console.log(`  ${r.indexname}: ${r.indexdef}`);
  }

  console.log('\n=== Users with auth ===');
  const authed = await db.query.users.findMany({
    where: isNotNull(users.username),
    orderBy: (u, { asc }) => [asc(u.id)],
  });
  for (const u of authed) {
    console.log(`  ${u.id} | username=${u.username} | target=${u.targetLanguage} | native=${u.nativeLanguage}`);
  }

  console.log('\n=== user_language_levels by user ===');
  const levels: any = await db.execute(sql`
    SELECT user_id, language_code, proficiency_level, confidence, source
    FROM user_language_levels
    ORDER BY user_id, language_code;
  `);
  const lvlRows: Array<{ user_id: string; language_code: string; proficiency_level: string; confidence: number; source: string }> =
    Array.isArray(levels) ? levels : (levels.rows ?? []);
  for (const r of lvlRows) {
    console.log(`  ${r.user_id} | ${r.language_code} | ${r.proficiency_level} | conf=${r.confidence} | ${r.source}`);
  }

  console.log('\n=== Cross-user vocab leak check ===');
  const topVocab: any = await db.execute(sql`
    SELECT user_id, COUNT(*)::int AS n
    FROM user_vocabulary
    GROUP BY user_id
    ORDER BY n DESC
    LIMIT 15;
  `);
  const tvRows: Array<{ user_id: string; n: number }> =
    Array.isArray(topVocab) ? topVocab : (topVocab.rows ?? []);
  for (const r of tvRows) {
    console.log(`  ${r.user_id}: ${r.n} vocab rows`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
