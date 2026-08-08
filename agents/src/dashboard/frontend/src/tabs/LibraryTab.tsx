/**
 * LibraryTab — Spotify-style adaptive grid of the user's content sources
 * (`content_sources` table: textbook/audio/youtube/movie/text). Tapping a
 * tile selects it as the active reading (`POST /api/content-sources/:id/select`,
 * wraps `placeUserInSource`) — the tutor's Planner picks up the active
 * chunk on the next session, same mechanism `curriculum.ts` already used
 * server-side for auto-advance.
 *
 * The "+" button opens a form that POSTs to `/api/content-sources`, which
 * creates the row and kicks off the (multi-minute) ingestion pipeline in
 * the background — the tile shows up immediately in a "Processing…" state
 * and the grid polls until it flips to ready/failed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, Description, FieldError, Input, Label, ListBox, Modal, ProgressBar, Select, TextArea, TextField } from '@heroui/react';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';
import { apiFetch } from '../lib/api';
import { useAppState } from '../state/AppState';
import ContentProfileSheet from '../components/ContentProfileSheet';

interface ContentSource {
  id: string;
  language: string;
  kind: string;
  title: string;
  status: string;
  ingestError?: string;
  chunkCount: number;
  progress: number;
  isActive: boolean;
  started: boolean;
  // Provenance (see lib/content-profile.ts). A source nobody has described
  // yet can be ingested but not placed -- we don't know whether the learner
  // has already worked through it, so we can't say where to start them.
  intent: 'study' | 'known' | 'aspire' | null;
  profileStatus: 'needed' | 'complete' | 'skipped';
  needsProfile: boolean;
  pendingQuestionCount: number;
}

const KIND_GLYPH: Record<string, string> = {
  textbook: '📘',
  audio: '🎧',
  youtube: '▶️',
  movie: '🎬',
  text: '📄',
};

// Kinds a user can add from the frontend today. `textbook`/`audio` still
// exist server-side (CLI-ingested, e.g. file uploads) but have no browser
// upload path yet, so they're left off this list rather than shown broken.
const ADDABLE_KINDS: { value: 'youtube' | 'movie' | 'text'; label: string; refLabel: string; refPlaceholder: string; refDescription: string }[] = [
  { value: 'youtube', label: 'YouTube video', refLabel: 'YouTube URL', refPlaceholder: 'https://youtube.com/watch?v=...', refDescription: 'Pulls the video\'s transcript/captions.' },
  { value: 'movie', label: 'Movie', refLabel: 'Movie title', refPlaceholder: 'e.g. The Matrix 1999', refDescription: 'Looks up subtitles via OpenSubtitles.' },
  { value: 'text', label: 'Paste text', refLabel: 'Text', refPlaceholder: 'Paste an article, story, or transcript…', refDescription: 'Any text in the target language.' },
];

// Deterministic per-tile cover gradient, keyed off the source id so it
// stays stable across refetches instead of reshuffling on every render.
const COVER_GRADIENTS = [
  'linear-gradient(135deg, #6d28d9, #db2777)',
  'linear-gradient(135deg, #0891b2, #4338ca)',
  'linear-gradient(135deg, #b45309, #dc2626)',
  'linear-gradient(135deg, #15803d, #0d9488)',
  'linear-gradient(135deg, #be123c, #7c3aed)',
];

function coverFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return COVER_GRADIENTS[hash % COVER_GRADIENTS.length];
}

const PENDING_STATUSES = new Set(['uploaded', 'ingesting']);

export default function LibraryTab() {
  const { bumpContentVersion } = useAppState();
  const [sources, setSources] = useState<ContentSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [kind, setKind] = useState<'youtube' | 'movie' | 'text'>('youtube');
  const [language, setLanguage] = useState('ru');
  const [title, setTitle] = useState('');
  const [ref, setRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [profileSourceId, setProfileSourceId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/content-sources');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSources(await res.json());
      setError(null);
    } catch {
      setError('Could not load your library.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while anything is still uploading/ingesting so tiles flip to
  // ready/failed without the user needing to manually refresh.
  useEffect(() => {
    const hasPending = sources?.some((s) => PENDING_STATUSES.has(s.status)) ?? false;
    if (hasPending && !pollRef.current) {
      pollRef.current = setInterval(load, 4000);
    } else if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [sources, load]);

  const selectSource = useCallback(async (id: string) => {
    setSelectingId(id);
    try {
      const res = await apiFetch(`/api/content-sources/${id}/select`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
      bumpContentVersion();
    } catch {
      setError('Could not switch your active reading — try again.');
    } finally {
      setSelectingId(null);
    }
  }, [load, bumpContentVersion]);

  // A tile that hasn't been described yet opens the questions instead of
  // selecting. Selecting it would run placeUserInSource against an empty
  // vocabulary and drop the learner at part 1 of a book they may have half
  // finished -- the exact wrong answer this feature exists to prevent.
  const openTile = useCallback((s: ContentSource) => {
    if (s.needsProfile) setProfileSourceId(s.id);
    else selectSource(s.id);
  }, [selectSource]);

  const resetForm = useCallback(() => {
    setTitle('');
    setRef('');
    setFormError(null);
  }, []);

  const submitAdd = useCallback(async () => {
    if (!ref.trim()) {
      setFormError('Paste a link or some text first.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      // Title is optional now -- the server derives one from the reference
      // when it's blank, so adding a video is a paste and a tap.
      const res = await apiFetch('/api/content-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, language, title: title.trim() || undefined, ref: ref.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setAddOpen(false);
      resetForm();
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not add this content.');
    } finally {
      setSubmitting(false);
    }
  }, [kind, language, title, ref, load, resetForm]);

  const activeKindConfig = ADDABLE_KINDS.find((k) => k.value === kind) ?? ADDABLE_KINDS[0];

  return (
    <div className="library-tab p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Library</h2>
        <Button size="sm" variant="secondary" onPress={() => setAddOpen(true)} aria-label="Add content">
          + Add
        </Button>
      </div>

      {error && (
        <p className="mb-3 text-sm" style={{ color: 'var(--danger, #ef4444)' }}>{error}</p>
      )}

      {sources === null ? (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>Loading your library…</div>
      ) : sources.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Nothing in your library yet — tap "+ Add" to pull in a YouTube video,
          movie subtitles, or pasted text to study.
        </p>
      ) : (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
        >
          {sources.map((s) => {
            const pct = Math.round(s.progress * 100);
            const isSelecting = selectingId === s.id;
            const isPending = PENDING_STATUSES.has(s.status);
            const isFailed = s.status === 'failed';
            const isClickable = s.status === 'ready' && !isSelecting;
            const needsInfo = isClickable && s.needsProfile;
            return (
              <Card
                key={s.id}
                variant="secondary"
                className={isClickable ? 'cursor-pointer gap-2 p-3 transition-transform hover:scale-[1.02]' : 'gap-2 p-3'}
                style={s.isActive ? { boxShadow: '0 0 0 2px var(--accent)' } : undefined}
                role="button"
                tabIndex={isClickable ? 0 : -1}
                aria-pressed={s.isActive}
                aria-label={
                  isPending ? `${s.title} (processing)`
                    : isFailed ? `${s.title} (failed)`
                      : needsInfo ? `${s.title} — needs a few details before it can be used`
                        : `Select ${s.title}`
                }
                aria-disabled={!isClickable}
                onClick={() => isClickable && openTile(s)}
                onKeyDown={(e) => {
                  if (isClickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    openTile(s);
                  }
                }}
              >
                <div
                  className="flex items-center justify-center rounded-md text-3xl"
                  style={{
                    aspectRatio: '1 / 1',
                    background: coverFor(s.id),
                    opacity: isSelecting || isPending ? 0.6 : needsInfo ? 0.45 : 1,
                    // Desaturated rather than merely dimmed: "unfinished
                    // setup" should read differently from "still processing".
                    filter: needsInfo ? 'grayscale(0.85)' : undefined,
                  }}
                >
                  {KIND_GLYPH[s.kind] ?? '📄'}
                </div>
                <Card.Header className="gap-0.5 p-0">
                  <Card.Title className="text-sm leading-tight">{s.title}</Card.Title>
                  <Card.Description className="text-xs">
                    {LANGUAGE_NAMES[s.language] ?? s.language}
                    {s.chunkCount > 0 && ` · ${s.chunkCount} ${s.chunkCount === 1 ? 'part' : 'parts'}`}
                  </Card.Description>
                </Card.Header>
                {isPending && (
                  <Chip size="sm">
                    <Chip.Label>{s.status === 'uploaded' ? 'Queued…' : 'Processing…'}</Chip.Label>
                  </Chip>
                )}
                {isFailed && (
                  <Chip color="danger" size="sm">
                    <Chip.Label>Failed</Chip.Label>
                  </Chip>
                )}
                {needsInfo && (
                  <Chip size="sm" color="warning">
                    <Chip.Label>
                      {s.pendingQuestionCount > 0
                        ? `${s.pendingQuestionCount} quick question${s.pendingQuestionCount === 1 ? '' : 's'}`
                        : 'Needs details'}
                    </Chip.Label>
                  </Chip>
                )}
                {s.isActive && (
                  <Chip color="accent" size="sm">
                    <Chip.Label>Now Learning</Chip.Label>
                  </Chip>
                )}
                {s.started && !s.isActive && s.status === 'ready' && (
                  <ProgressBar aria-label={`${s.title} progress`} value={pct} size="sm">
                    <Label className="sr-only">Progress</Label>
                    <ProgressBar.Track>
                      <ProgressBar.Fill />
                    </ProgressBar.Track>
                  </ProgressBar>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Modal.Backdrop
        isOpen={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) resetForm();
        }}
      >
        <Modal.Container placement="auto">
          <Modal.Dialog className="sm:max-w-md">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Add content</Modal.Heading>
              <p className="mt-1.5 text-sm leading-5 text-muted">
                Pull in a YouTube video, movie subtitles, or your own text to study.
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4 p-6">
              <Select
                className="w-full"
                value={kind}
                onChange={(key) => setKind(key as 'youtube' | 'movie' | 'text')}
              >
                <Label>Type</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {ADDABLE_KINDS.map((k) => (
                      <ListBox.Item key={k.value} id={k.value} textValue={k.label}>
                        {k.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <Select
                className="w-full"
                value={language}
                onChange={(key) => setLanguage(key as string)}
              >
                <Label>Language</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {Object.entries(LANGUAGE_NAMES).map(([code, name]) => (
                      <ListBox.Item key={code} id={code} textValue={name}>
                        {name}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <TextField className="w-full" value={title} onChange={setTitle}>
                <Label>Title (optional)</Label>
                <Input placeholder="Leave blank and we'll work one out" />
              </TextField>

              {kind === 'text' ? (
                <TextField className="w-full" value={ref} onChange={setRef} isRequired>
                  <Label>{activeKindConfig.refLabel}</Label>
                  <TextArea placeholder={activeKindConfig.refPlaceholder} rows={5} />
                  <Description>{activeKindConfig.refDescription}</Description>
                </TextField>
              ) : (
                <TextField className="w-full" value={ref} onChange={setRef} isRequired>
                  <Label>{activeKindConfig.refLabel}</Label>
                  <Input placeholder={activeKindConfig.refPlaceholder} />
                  <Description>{activeKindConfig.refDescription}</Description>
                </TextField>
              )}

              {formError && <FieldError>{formError}</FieldError>}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="secondary" isDisabled={submitting}>
                Cancel
              </Button>
              <Button onPress={submitAdd} isDisabled={submitting}>
                {submitting ? 'Adding…' : 'Add'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <ContentProfileSheet
        sourceId={profileSourceId}
        isOpen={profileSourceId !== null}
        onClose={() => setProfileSourceId(null)}
        onCompleted={() => {
          // Reconciliation may have seeded vocabulary and moved the
          // learner's active chunk, so refresh both the grid and anything
          // else reading content state.
          load();
          bumpContentVersion();
        }}
      />
    </div>
  );
}
