/**
 * ChunkBrowserSheet — "jump to any part" list for a source, reached from
 * CurriculumSheet's "Browse parts" button.
 *
 * Backed by GET /api/content-sources/:id/chunks (curriculum.ts's
 * listSourceChunks) — every chunk in reading order, each with the
 * learner's live vocab coverage computed for any already-distilled chunk
 * (even one they've never visited), so they can tell which parts they
 * probably already know before jumping. For youtube/movie sources,
 * `title` is a real time range ("12:30-15:00") rather than "Untitled
 * (part N)" — see ingest.ts's segmentTimedText.
 *
 * Most rows will show `distilled: false` — distillation (the summary
 * line, coverage %) is lazy (ingest.ts's ensureChunkDistilled), only
 * happening the first time a chunk actually becomes someone's active
 * chunk, not for the whole source up front. Tapping an undistilled row
 * still works — the jump itself triggers distillation synchronously
 * before activating (curriculum.ts's activateChunk), just with no coverage
 * preview beforehand.
 *
 * Tapping a row POSTs /api/content-sources/:id/chunks/:chunkId/activate —
 * an explicit override of coverage-based auto-placement, same trust-the-
 * user precedent as the voice "let's move on" trigger. Jumping to an
 * already-`done` chunk is allowed (re-activates it), same as re-reading a
 * chapter you already finished.
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, Chip, ProgressBar, Typography } from '@heroui/react';
import { apiFetch } from '../lib/api';

interface ChunkNavItem {
  chunkId: string;
  ord: number;
  title: string;
  summary: string | null;
  startSec: number | null;
  endSec: number | null;
  coverage: number | null;
  distilled: boolean;
  status: 'active' | 'done' | 'queued' | 'not_started';
}

interface ChunkBrowserSheetProps {
  sourceId: string;
  sourceTitle: string;
  onJumped: () => void;
}

const STATUS_LABEL: Record<ChunkNavItem['status'], string | null> = {
  active: 'Now here',
  done: 'Done',
  queued: null,
  not_started: null,
};

export default function ChunkBrowserSheet({ sourceId, sourceTitle, onJumped }: ChunkBrowserSheetProps) {
  const [chunks, setChunks] = useState<ChunkNavItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jumpingId, setJumpingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/content-sources/${sourceId}/chunks`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setChunks(data);
      } catch {
        if (!cancelled) setError('Could not load the parts of this source.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  const jumpTo = useCallback(async (chunkId: string) => {
    if (jumpingId) return;
    setJumpingId(chunkId);
    setError(null);
    try {
      const res = await apiFetch(`/api/content-sources/${sourceId}/chunks/${chunkId}/activate`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onJumped();
    } catch {
      setError('Could not jump there — try again.');
      setJumpingId(null);
    }
  }, [sourceId, jumpingId, onJumped]);

  return (
    <div className="flex max-h-[70vh] flex-col gap-3">
      <Typography.Heading level={4}>{sourceTitle}</Typography.Heading>

      {chunks === null && !error && (
        <Typography color="muted" type="body-sm">Loading…</Typography>
      )}
      {error && <Typography type="body-sm" className="text-danger">{error}</Typography>}

      {chunks && (
        <div className="flex flex-col gap-2 overflow-y-auto">
          {chunks.map((c) => {
            const pct = c.coverage !== null ? Math.round(c.coverage * 100) : null;
            const statusLabel = STATUS_LABEL[c.status];
            const isJumping = jumpingId === c.chunkId;
            const isActive = c.status === 'active';
            const isClickable = !isActive && !isJumping;
            return (
              <Card
                key={c.chunkId}
                variant="secondary"
                className={isClickable ? 'flex-col gap-1 p-3 cursor-pointer transition-transform hover:scale-[1.01]' : 'flex-col gap-1 p-3'}
                style={isActive ? { boxShadow: '0 0 0 2px var(--accent)', opacity: 1 } : { opacity: isJumping ? 0.6 : 1 }}
                role="button"
                tabIndex={isClickable ? 0 : -1}
                aria-pressed={isActive}
                aria-disabled={!isClickable}
                aria-label={`${c.title}${statusLabel ? ` (${statusLabel})` : ''}`}
                onClick={() => isClickable && jumpTo(c.chunkId)}
                onKeyDown={(e) => {
                  if (isClickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    jumpTo(c.chunkId);
                  }
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <Typography type="body-sm" className="font-medium">{c.title}</Typography>
                  {statusLabel && (
                    <Chip size="sm" color={c.status === 'active' ? 'accent' : undefined}>
                      <Chip.Label>{statusLabel}</Chip.Label>
                    </Chip>
                  )}
                </div>
                <Typography color="muted" type="body-xs">
                  {c.summary ?? 'Not previewed yet — tap to see what\'s here.'}
                </Typography>
                {pct !== null && (
                  <div className="flex items-center gap-2">
                    <ProgressBar aria-label={`${c.title} coverage`} value={pct} size="sm" className="flex-1">
                      <ProgressBar.Track>
                        <ProgressBar.Fill />
                      </ProgressBar.Track>
                    </ProgressBar>
                    <Typography color="muted" type="body-xs">{pct}% known</Typography>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
