import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

async function main() {
  try {
    console.log('Ensuring unique index on duolingo_metadata(user_id)...');
    await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS duolingo_metadata_user_id_unique ON duolingo_metadata (user_id)`);
    
    console.log('Adding duolingo_password column to duolingo_metadata...');
    try {
        await db.run(sql`ALTER TABLE duolingo_metadata ADD COLUMN duolingo_password TEXT`);
        console.log('✅ Column added successfully');
    } catch (e: any) {
        if (e.message.includes('duplicate column name')) {
            console.log('ℹ️ Column already exists');
        } else {
            throw e;
        }
    }
  } catch (e) {
    console.error('❌ Failed to create index:', e);
    process.exit(1);
  }
  process.exit(0);
}

main();
