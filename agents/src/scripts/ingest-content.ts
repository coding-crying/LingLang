// CLI entry for curriculum ingestion — see src/lib/ingest.ts and
// docs/superpowers/specs/2026-07-06-curriculum-design.md §2.
//
// Usage: tsx src/scripts/ingest-content.ts <kind> <language> <title> <ref> [ownerId]
//   kind: text | textbook | audio | youtube | movie
import { randomUUID } from 'node:crypto';
import { ingestSource, type ContentKind } from '../lib/ingest.js';

async function main() {
  const [kind, language, title, ref, ownerId] = process.argv.slice(2);
  if (!kind || !language || !title || !ref) {
    console.error('Usage: tsx src/scripts/ingest-content.ts <kind> <language> <title> <ref> [ownerId]');
    console.error('  kind: text | textbook | audio | youtube | movie');
    process.exit(1);
  }
  if (!['text', 'textbook', 'audio', 'youtube', 'movie'].includes(kind)) {
    console.error(`Unknown kind "${kind}" — expected text|textbook|audio|youtube|movie`);
    process.exit(1);
  }

  const sourceId = `src-${randomUUID().slice(0, 8)}`;
  console.log(`[Ingest] Source ID: ${sourceId}`);

  const result = await ingestSource({
    sourceId,
    ownerId,
    language,
    kind: kind as ContentKind,
    title,
    ref,
  });

  console.log(`[Ingest] Complete: ${JSON.stringify(result)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[Ingest] Failed:', err);
  process.exit(1);
});
