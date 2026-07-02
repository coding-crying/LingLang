import { db } from './src/db/index.js';
import { sql } from 'drizzle-orm';
import * as fs from 'fs';

async function main() {
  const migration = fs.readFileSync('./drizzle/0002_add_user_language_levels.sql', 'utf8');
  await db.execute(sql.raw(migration));
  console.log('Migration applied');

  const r = await db.execute(sql`SELECT * FROM user_language_levels ORDER BY user_id, language_code`);
  console.log('Backfilled rows:');
  // postgres-js returns an object with rows
  const rows = (r as any).rows || r;
  if (Array.isArray(rows)) {
    for (const row of rows) console.log('  ' + JSON.stringify(row));
  } else {
    console.log('  (empty)');
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
