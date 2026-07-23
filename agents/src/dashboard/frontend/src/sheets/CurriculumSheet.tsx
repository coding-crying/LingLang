/**
 * CurriculumSheet — detail view for the Voice tab's curriculum pill.
 *
 * Backed by GET /api/users/:userId/active-content, a thin wrapper around
 * lib/learner-view.ts's readLearnerView() — the exact same activeChunk the
 * planner prompt is built from this turn, so this can never show something
 * out of sync with what the tutor is actually using. See curriculum.ts /
 * learner-view.ts for how a chunk becomes "active" (LibraryTab's
 * `POST /api/content-sources/:id/select`) and advances (FSRS coverage
 * crossing the mastery threshold, or an explicit "let's move on").
 */

import { useEffect, useState } from 'react';
import { Button, ProgressBar, Typography } from '@heroui/react';
import { apiFetch } from '../lib/api';

interface ActiveChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  chunkTitle: string;
  card: string;
  coverage: number;
  summary: string;
  ord: number;
  totalChunks: number;
  nextChunk: { title: string; summary: string } | null;
}

interface CurriculumSheetProps {
  userId: string;
  targetLang: string;
  onGoToLibrary: () => void;
  onBrowseParts: (sourceId: string, sourceTitle: string) => void;
}

export default function CurriculumSheet({ userId, targetLang, onGoToLibrary, onBrowseParts }: CurriculumSheetProps) {
  const [chunk, setChunk] = useState<ActiveChunk | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/users/${userId}/active-content?language=${targetLang}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setChunk(data);
      } catch {
        if (!cancelled) setError('Could not load your current reading.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, targetLang]);

  if (chunk === undefined && !error) {
    return (
      <div className="flex flex-col gap-3">
        <Typography.Heading level={4}>Curriculum</Typography.Heading>
        <Typography color="muted" type="body-sm">Loading…</Typography>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <Typography.Heading level={4}>Curriculum</Typography.Heading>
        <Typography type="body-sm" className="text-danger">{error}</Typography>
      </div>
    );
  }

  if (!chunk) {
    return (
      <div className="flex flex-col gap-3">
        <Typography.Heading level={4}>Curriculum</Typography.Heading>
        <Typography color="muted" type="body-sm">
          Nothing active yet — pick something in your Library to give the
          tutor a focus for your sessions.
        </Typography>
        <Button variant="secondary" onPress={onGoToLibrary}>Go to Library</Button>
      </div>
    );
  }

  const pct = Math.round(chunk.coverage * 100);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Typography color="muted" type="body-xs">{chunk.sourceTitle}</Typography>
        <Typography.Heading level={4}>{chunk.chunkTitle}</Typography.Heading>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Typography color="muted" type="body-xs">
            Part {chunk.ord} of {chunk.totalChunks}
          </Typography>
          <Typography color="muted" type="body-xs">{pct}% mastered</Typography>
        </div>
        <ProgressBar aria-label="Chunk mastery" value={pct} size="sm">
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      </div>

      <Typography type="body-sm">{chunk.summary}</Typography>

      {chunk.nextChunk && (
        <div className="flex flex-col gap-0.5 border-t border-separator pt-3">
          <Typography color="muted" type="body-xs">Up next</Typography>
          <Typography type="body-sm">{chunk.nextChunk.title}</Typography>
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onPress={() => onBrowseParts(chunk.sourceId, chunk.sourceTitle)}>
          Browse parts
        </Button>
        <Button variant="secondary" className="flex-1" onPress={onGoToLibrary}>Switch reading</Button>
      </div>
    </div>
  );
}
