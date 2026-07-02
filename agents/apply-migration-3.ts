import { db } from './src/db/index.js';
import { sql } from 'drizzle-orm';
import * as fs from 'fs';

async function main() {
  const migration = fs.readFileSync('./drizzle/0003_add_user_style.sql', 'utf8');
  await db.execute(sql.raw(migration));
  console.log('Migration applied');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
