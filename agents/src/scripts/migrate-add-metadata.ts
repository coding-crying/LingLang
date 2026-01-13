/**
 * Migration: Add metadata and updatedAt to users table
 *
 * Run with: pnpm tsx src/scripts/migrate-add-metadata.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

async function migrate() {
  console.log('[Migration] Adding metadata and updatedAt columns to users table...');

  try {
    // Check if columns already exist
    const tableInfo = await db.all(sql`PRAGMA table_info(users)`);
    const hasMetadata = tableInfo.some((col: any) => col.name === 'metadata');
    const hasUpdatedAt = tableInfo.some((col: any) => col.name === 'updated_at');

    if (!hasUpdatedAt) {
      console.log('[Migration] Adding updated_at column...');
      await db.run(sql`ALTER TABLE users ADD COLUMN updated_at INTEGER`);
      console.log('[Migration] ✅ updated_at column added');
    } else {
      console.log('[Migration] ⏭️  updated_at column already exists');
    }

    if (!hasMetadata) {
      console.log('[Migration] Adding metadata column...');
      await db.run(sql`ALTER TABLE users ADD COLUMN metadata TEXT`);
      console.log('[Migration] ✅ metadata column added');
    } else {
      console.log('[Migration] ⏭️  metadata column already exists');
    }

    console.log('[Migration] Migration complete!');
  } catch (err) {
    console.error('[Migration] Migration failed:', err);
    process.exit(1);
  }
}

migrate();
