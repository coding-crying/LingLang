/**
 * One-shot script: Embed all lexemes using BGE-M3 via llama-swap on localhost:8091.
 *
 * Usage:
 *   DATABASE_URL="postgresql://linglang:linglang_dev@localhost:5433/linglang" \
 *   npx tsx src/scripts/embed-lexemes.ts
 */

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { isNull, sql as sqlExpr } from 'drizzle-orm';

const EMBED_URL = 'http://localhost:8091/v1/embeddings';
const EMBED_MODEL = 'bge-m3';
const BATCH_SIZE = 50;

async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = await response.json() as any;
  // Sort by index to guarantee order matches input
  const embeddings = data.data.sort((a: any, b: any) => a.index - b.index);
  return embeddings.map((d: any) => d.embedding);
}

async function main() {
  console.log('[Embed] Fetching lexemes without embeddings...');

  // Get all lexemes that don't have embeddings yet
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
    // Embed lemma + translation for richer semantic representation
    const texts = batch.map(l => `${l.lemma} (${l.language}): ${l.translation}`);

    try {
      const embeddings = await embedTexts(texts);

      for (let j = 0; j < batch.length; j++) {
        await db.update(schema.lexemes)
          .set({ embedding: embeddings[j] })
          .where(sqlExpr`${schema.lexemes.id} = ${batch[j].id}`);
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