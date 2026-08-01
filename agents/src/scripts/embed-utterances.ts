/**
 * Backfill embeddings for utterances that don't have vectors yet.
 *
 * The sibling of embed-lexemes.ts, for the other embedded table. Needed
 * because recordUtterance() treats embedding as best-effort: if the embed
 * service is down or misconfigured it logs a warning, writes the row with a
 * NULL vector, and the session carries on. That's the right call live —
 * nobody's conversation should break because a search index is unavailable —
 * but it means an outage leaves a silent hole that only shows up later as
 * search_utterances quietly having less to search. This fills the hole.
 *
 * Embeds the bare transcript, exactly as recordUtterance does. That match
 * matters: embedding backfilled rows differently from live ones would put
 * two incompatible vector populations in one index, and cosine distance
 * between them would be meaningless.
 *
 * Idempotent — only touches rows WHERE embedding IS NULL, so re-running
 * after a partial failure resumes rather than redoing work.
 *
 * Usage (from agents/):
 *   npx tsx src/scripts/embed-utterances.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq, isNull } from 'drizzle-orm';
import { embedBatch } from '../lib/embedding.js';

const BATCH_SIZE = 50;

async function main() {
  console.log('[Embed] Fetching utterances without embeddings...');

  const rows = await db.select({
    id: schema.utterances.id,
    transcript: schema.utterances.transcript,
  }).from(schema.utterances)
    .where(isNull(schema.utterances.embedding));

  console.log(`[Embed] Found ${rows.length} utterances to embed`);
  if (rows.length === 0) {
    console.log('[Embed] All utterances already have embeddings!');
    process.exit(0);
  }

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    try {
      const embeddings = await embedBatch(batch.map((r) => r.transcript));

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const emb = embeddings[j];
        // embedBatch returns an empty array per text it couldn't embed
        // rather than throwing, so count those instead of writing a
        // zero-length vector the column would reject anyway.
        if (row && emb && emb.length > 0) {
          await db.update(schema.utterances)
            .set({ embedding: emb })
            .where(eq(schema.utterances.id, row.id));
        } else {
          failed++;
        }
      }

      processed += batch.length;
      console.log(`[Embed] Processed ${processed}/${rows.length} (${failed} failed)`);
    } catch (err) {
      failed += batch.length;
      console.error(`[Embed] Batch at ${i} failed:`, String(err).slice(0, 200));
    }
  }

  console.log(`[Embed] Done! ${processed - failed} embedded, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[Embed] Fatal:', err);
  process.exit(1);
});
