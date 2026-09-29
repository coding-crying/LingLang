import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { fsrsReview } from './fsrs.js';
const now = new Date();
const result = fsrsReview({state:2,difficulty:3,stability:2,elapsedDays:0,scheduledDays:2,reps:2,lapses:0,due:now,lastReview:new Date(now.getTime()-1234567)},3);
assert.ok(result.elapsedDays>0 && result.elapsedDays<1, 'scheduler keeps sub-day precision');
const source=readFileSync(new URL('../tools/supervisor-functions.ts',import.meta.url),'utf8');
const fields=[...source.matchAll(/elapsedDays:\s*([^\n]*result\.elapsedDays[^\n]*),/g)];
assert.ok(fields.length>=2,'exercise all scheduler result persistence sites');
try {
 for(const field of fields) {
  const value=new Function('result',`return ${field[1]}`)(result);
  const rows=await db.execute(sql`SELECT ${value}::integer AS elapsed_days`);
  assert.equal(Number(rows[0].elapsed_days),0);
 }
 console.log(`elapsed-days persistence: ${fields.length} production field expressions accepted by real PostgreSQL; fractional scheduling preserved`);
} finally {await db.$client.end();}
