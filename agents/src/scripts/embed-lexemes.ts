/**
 * Embed all lexemes that don't have vectors yet.
 *
 * Uses the shared embedding utility (lib/embedding.ts) which supports
 * both local (BGE-M3 via llama-swap) and cloud endpoints.
 *
 * Usage:
 *   EMBED_URL=http://localhost:8091/v1/embeddings npx tsx src/scripts/embed-lexemes.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq, isNull } from 'drizzle-orm';
import { embedBatch, lexemeEmbedText } from '../lib/embedding.js';

const BATCH_SIZE = 50;

async function main() {
  console.log('[Embed] Fetching lexemes without embeddings...');

  const lexemesWithoutEmbeddings = await db.select({
    id: schema.lexemes.id,
    lemma: schema.lexemes.lemma,
    translation: schema.lexemes.translation,
    language: schema.lexemes.language,
  }).from(schema.lexemes)
    .where(isNull(schema.lexemes.embedding));

  console.log(`[Embed] Found ${lexemesWithoutEmbeddings.length} lexemes to embed`);

  if (lexemesWithoutEmbeddings.length === 0) {
    console.log('[Embed] All lexemes already have embeddings!');
    process.exit(0);
  }

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < lexemesWithoutEmbeddings.length; i += BATCH_SIZE) {
    const batch = lexemesWithoutEmbeddings.slice(i, i + BATCH_SIZE);
    const texts = batch.map(l => lexemeEmbedText(l.lemma, l.language, l.translation || l.lemma));

    try {
      const embeddings = await embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const emb = embeddings[j];
        if (emb && emb.length > 0) {
          await db.update(schema.lexemes)
            .set({ embedding: emb })
            .where(eq(schema.lexemes.id, batch[j].id));
        }
      }

      processed += batch.length;
      console.log(`[Embed] Processed ${processed}/${lexemesWithoutEmbeddings.length} (${failed} failed)`);
    } catch (err) {
      console.error(`[Embed] Batch ${i}-${i + batch.length} failed:`, err);
      failed += batch.length;
    }
  }

  console.log(`[Embed] Done! ${processed} embedded, ${failed} failed`);
  process.exit(0);
}

main().catch(err => {
  console.error('[Embed] Error:', err);
  process.exit(1);
});