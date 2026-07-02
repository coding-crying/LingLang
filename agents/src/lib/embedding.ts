/**
 * Shared embedding utility for LingLang.
 *
 * Uses BGE-M3 via a local or remote OpenAI-compatible embedding endpoint.
 * Used by:
 *   - Processor (auto-embed on lexeme creation)
 *   - embed-lexemes.ts (batch backfill)
 *   - Content ingestion (future)
 */

const EMBED_URL = process.env.EMBED_URL || 'http://localhost:8091/v1/embeddings';
const EMBED_MODEL = process.env.EMBED_MODEL || 'BAAI/bge-m3';
const EMBED_KEY = process.env.EMBED_KEY || '';

/**
 * Embed a single text string. Returns the embedding vector.
 * Falls back to a zero vector if the embedding service is unavailable.
 */
export async function embedText(text: string): Promise<number[]> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (EMBED_KEY) headers['Authorization'] = `Bearer ${EMBED_KEY}`;

    const response = await fetch(EMBED_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
    });

    if (!response.ok) {
      console.warn(`[Embed] API error ${response.status}, falling back to zero vector`);
      return [];
    }

    const data = await response.json() as any;
    return data.data?.[0]?.embedding ?? [];
  } catch (err) {
    console.warn(`[Embed] Failed: ${String(err).slice(0, 100)}, falling back to no embedding`);
    return [];
  }
}

/**
 * Embed multiple texts in a batch. Returns array of embedding vectors.
 * Empty arrays for any that fail.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (EMBED_KEY) headers['Authorization'] = `Bearer ${EMBED_KEY}`;

    const response = await fetch(EMBED_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });

    if (!response.ok) {
      console.warn(`[Embed] Batch API error ${response.status}`);
      return texts.map(() => []);
    }

    const data = await response.json() as any;
    const sorted = (data.data || []).sort((a: any, b: any) => a.index - b.index);
    return texts.map((_, i) => sorted[i]?.embedding ?? []);
  } catch (err) {
    console.warn(`[Embed] Batch failed: ${String(err).slice(0, 100)}`);
    return texts.map(() => []);
  }
}

/**
 * Embed a lexeme for DB storage: "lemma (lang): translation"
 * Same format as the existing embed-lexemes.ts script.
 */
export function lexemeEmbedText(lemma: string, language: string, translation: string): string {
  return `${lemma} (${language}): ${translation}`;
}