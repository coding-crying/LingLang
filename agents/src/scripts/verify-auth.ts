// Smoke-test the auth lib.
import { authenticateByUsername, createUser, hashPassword, verifyPassword } from '../lib/user-auth.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  const tests: Array<[string, string, string | null]> = [
    ['will', 'will', 'will'],
    ['Will', 'will', 'will'],
    ['WILL', 'will', 'will'],
    ['Robert', 'Robert', 'robert'],
    ['robert', 'Robert', 'robert'],
    ['ROBERT', 'Robert', 'robert'],
    ['will', 'wrong', null],
    ['Robert', 'wrong', null],
    ['nobody', 'x', null],
  ];

  let pass = 0;
  let fail = 0;
  for (const [u, p, expectedId] of tests) {
    const r = await authenticateByUsername(u, p);
    const got = r?.id ?? null;
    const ok = got === expectedId;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '✓' : '✗'} ${u}/${p} → ${got} (expected ${expectedId})`);
  }
  console.log(`\n${pass}/${pass + fail} tests passed.`);

  // Show all authed users
  console.log('\nUsers with auth:');
  const authed = await db.query.users.findMany({
    where: sql`${users.username} IS NOT NULL`,
  });
  for (const u of authed) {
    console.log(`  ${u.id}: username=${u.username} target=${u.targetLanguage}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
