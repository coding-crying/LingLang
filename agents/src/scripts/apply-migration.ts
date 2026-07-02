// Apply a SQL migration using the project's DB connection.
import { readFileSync } from 'fs';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: tsx apply-migration.ts <path-to-sql>');
    process.exit(1);
  }
  const text = readFileSync(file, 'utf-8');
  console.log(`Applying ${file}...`);
  // drizzle's execute() doesn't run multi-statement SQL by default; split on
  // semicolons that terminate a line.
  const statements = text
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    console.log(`  → ${stmt.split('\n')[0]?.slice(0, 60) ?? stmt}...`);
    await db.execute(sql.raw(stmt));
  }
  console.log('Done.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
