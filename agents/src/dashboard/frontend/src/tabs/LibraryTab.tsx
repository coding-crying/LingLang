// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Button, Modal } from '@heroui/react';
import {
  ArrowRight,
  AudioLines,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Film,
  Headphones,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AddMaterialDialog from '../components/AddMaterialDialog';
import ContentProfileSheet from '../components/ContentProfileSheet';
import IconButton from '../components/IconButton';
import KnownWordsCard from '../components/KnownWordsCard';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';
import { apiFetch } from '../lib/api';
import { type ContentSource, MATERIAL_KINDS, PENDING_STATUSES } from '../lib/materials';
import '../library.css';
import '../material-courses.css';
import { groupMaterials } from '../lib/material-groups';
import { useAppState } from '../state/AppState';

const KIND_ICONS = {
  textbook: BookOpen,
  audio: Headphones,
  youtube: Film,
  movie: Film,
  text: FileText,
};

function SourceIcon({ kind, size = 23 }: { kind: string; size?: number }) {
  const Icon = KIND_ICONS[kind as keyof typeof KIND_ICONS] ?? FileText;
  return <Icon size={size} aria-hidden="true" />;
}

function sourceStatus(source: ContentSource) {
  if (source.status === 'failed') return 'Import failed';
  if (PENDING_STATUSES.has(source.status))
    return source.status === 'uploaded' ? 'Queued' : 'Processing';
  if (source.reconcileError) return 'Learning setup failed';
  if (source.needsProfile) return 'Needs details';
  if (source.reconciling) return 'Preparing practice';
  if (source.isActive) return 'In practice';
  if (source.progress >= 1) return 'Practice completed';
  return source.started ? 'In progress' : 'Ready to start';
}

export default function LibraryTab({
  userId,
  targetLang = 'en',
}: {
  userId: string | null;
  targetLang?: string;
}) {
  const { bumpContentVersion, contentVersion, setTab, openSheet } = useAppState();
  const [sources, setSources] = useState<ContentSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [view, setView] = useState<'materials' | 'words'>('materials');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [language, setLanguage] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('recent');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [profileSourceId, setProfileSourceId] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (replace = true) => {
    if (!replace && request.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRefreshing(true);
    try {
      const response = await apiFetch('/api/content-sources', { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: ContentSource[] = await response.json();
      if (!controller.signal.aborted) {
        setSources(data);
        setError(null);
      }
    } catch {
      if (!controller.signal.aborted) setError('Could not load your library. Please try again.');
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
      if (request.current === controller) request.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load, contentVersion]);
  const hasPending = sources?.some(
    (source) => PENDING_STATUSES.has(source.status) || source.reconciling,
  );
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void load(false), 4000);
    return () => clearInterval(timer);
  }, [hasPending, load]);

  const selectSource = async (source: ContentSource) => {
    if (source.reconciling || source.reconcileError) return;
    if (source.language !== targetLang) {
      setDetailId(null);
      openSheet({ kind: 'language' });
      return;
    }
    if (source.needsProfile) {
      setDetailId(null);
      setProfileSourceId(source.id);
      return;
    }
    if (selectingId) return;
    setSelectingId(source.id);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/content-sources/${encodeURIComponent(source.id)}/select`,
        { method: 'POST' },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (response.status === 409) {
          await load();
          if (body.needsProfile) {
            setDetailId(null);
            setProfileSourceId(source.id);
          } else {
            setNotice(body.error || 'Preparing your starting point. Please wait a moment.');
          }
          return;
        }
        throw new Error(body.error || 'Could not start this material. Try again.');
      }
      setDetailId(null);
      setNotice(`${source.title} is now in practice.`);
      bumpContentVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not select material.');
    } finally {
      setSelectingId(null);
    }
  };

  const retrySource = async (source: ContentSource) => {
    if (retryingId) return;
    setRetryingId(source.id);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/content-sources/${encodeURIComponent(source.id)}/retry`,
        { method: 'POST' },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Could not retry this import. Try again.');
      }
      setNotice(
        source.reconcileError
          ? `${source.title} is queued for learning preparation.`
          : `${source.title} is queued for another import attempt.`,
      );
      await load();
      bumpContentVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not retry this import.');
    } finally {
      setRetryingId(null);
    }
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const result = (sources ?? []).filter(
      (source) =>
        (!query || source.title.toLocaleLowerCase().includes(query)) &&
        (!kind || source.kind === kind) &&
        (!language || source.language === language) &&
        (!status ||
          (status === 'active'
            ? source.isActive
            : status === 'needsProfile'
              ? source.needsProfile
              : status === 'ingesting'
                ? PENDING_STATUSES.has(source.status) || source.reconciling
                : status === 'failed'
                  ? source.status === 'failed' || !!source.reconcileError
                  : source.status === status)),
    );
    if (sort === 'title') result.sort((a, b) => a.title.localeCompare(b.title));
    return result;
  }, [sources, search, kind, language, status, sort]);
  const active = sources?.find(
    (source) =>
      source.isActive &&
      source.language === targetLang &&
      source.status === 'ready' &&
      !source.reconciling &&
      !source.reconcileError,
  );
  const detail = sources?.find((source) => source.id === detailId);
  const filterCount = [kind, language, status].filter(Boolean).length;
  const clearFilters = () => {
    setSearch('');
    setKind('');
    setLanguage('');
    setStatus('');
  };

  return (
    <div className="library-tab">
      <div className="library-workspace">
        <header className="library-heading">
          <div>
            <span className="page-eyebrow">YOUR LEARNING SPACE</span>
            <h1>Library</h1>
          </div>
          <Button onPress={() => setAddOpen(true)} className="add-material-button">
            <Plus size={18} />
            Add material
          </Button>
        </header>
        <div className="library-tabs" role="tablist" aria-label="Library">
          <button
            id="materials-tab"
            role="tab"
            aria-selected={view === 'materials'}
            aria-controls="materials-panel"
            tabIndex={view === 'materials' ? 0 : -1}
            onClick={() => setView('materials')}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                setView('words');
                document.getElementById('words-tab')?.focus();
              }
            }}
          >
            <BookOpen size={17} />
            Materials{sources && <span>{groupMaterials(sources).length}</span>}
          </button>
          <button
            id="words-tab"
            role="tab"
            aria-selected={view === 'words'}
            aria-controls="words-panel"
            tabIndex={view === 'words' ? 0 : -1}
            onClick={() => setView('words')}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                setView('materials');
                document.getElementById('materials-tab')?.focus();
              }
            }}
          >
            <AudioLines size={17} />
            Word bank
          </button>
        </div>

        <div role="status" className="library-notice" hidden={!notice}>
          <Check size={17} />
          <span>{notice}</span>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            aria-label="Dismiss notification"
            onPress={() => setNotice('')}
          >
            <X size={16} />
          </Button>
        </div>
        {error && (
          <div className="library-error" role="alert">
            <CircleAlert size={19} />
            <span>{error}</span>
            <Button variant="ghost" size="sm" onPress={() => void load()}>
              <RefreshCw size={16} />
              Retry
            </Button>
          </div>
        )}

        {view === 'words' ? (
          <section id="words-panel" role="tabpanel" aria-labelledby="words-tab">
            <KnownWordsCard userId={userId} onAddContent={() => setAddOpen(true)} />
          </section>
        ) : (
          <section id="materials-panel" role="tabpanel" aria-labelledby="materials-tab">
            {active && (
              <div className="active-material">
                <div className="active-material-icon">
                  <SourceIcon kind={active.kind} />
                </div>
                <div className="active-material-copy">
                  <span className="active-label">
                    <span />
                    IN PRACTICE
                  </span>
                  <h2>{active.title}</h2>
                  <p>
                    {LANGUAGE_NAMES[active.language] ?? active.language} ·{' '}
                    {Math.round(active.progress * 100)}% practiced
                  </p>
                </div>
                <Button variant="secondary" onPress={() => setTab('voice')}>
                  Continue
                  <ArrowRight size={17} />
                </Button>
              </div>
            )}

            <div className="materials-section-heading">
              <h2>All materials</h2>
              <span>{groupMaterials(sources ?? []).length} library items</span>
            </div>
            <div className="library-toolbar">
              <div className="library-search">
                <Search size={18} aria-hidden="true" />
                <input
                  aria-label="Search materials"
                  placeholder="Search your materials..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <IconButton
                    label="Clear search"
                    size="sm"
                    className="library-clear-search"
                    onPress={() => setSearch('')}
                  >
                    <X size={16} />
                  </IconButton>
                )}
              </div>
              <IconButton
                label={`${filtersOpen ? 'Hide' : 'Show'} filters${filterCount ? `, ${filterCount} active` : ''}`}
                variant="secondary"
                aria-expanded={filtersOpen}
                aria-controls="material-filters"
                className={filterCount ? 'filter-button has-filters' : 'filter-button'}
                onPress={() => setFiltersOpen(!filtersOpen)}
              >
                <SlidersHorizontal size={17} />
                {filterCount > 0 && (
                  <span className="filter-count" aria-hidden="true">
                    {filterCount}
                  </span>
                )}
              </IconButton>
              <div className="material-layout-toggle" role="group" aria-label="Material layout">
                <IconButton
                  label="Grid view"
                  aria-pressed={layout === 'grid'}
                  onPress={() => setLayout('grid')}
                >
                  <LayoutGrid size={18} />
                </IconButton>
                <IconButton
                  label="List view"
                  aria-pressed={layout === 'list'}
                  onPress={() => setLayout('list')}
                >
                  <List size={19} />
                </IconButton>
              </div>
              <IconButton
                label="Refresh materials"
                isDisabled={refreshing}
                onPress={() => void load()}
              >
                <RefreshCw size={17} className={refreshing ? 'material-spinner' : ''} />
              </IconButton>
            </div>
            {filtersOpen && (
              <div id="material-filters" className="material-filters">
                <label>
                  Type
                  <select value={kind} onChange={(event) => setKind(event.target.value)}>
                    <option value="">All types</option>
                    {Object.entries(MATERIAL_KINDS).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Language
                  <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                    <option value="">All languages</option>
                    {Object.entries(LANGUAGE_NAMES).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Status
                  <select value={status} onChange={(event) => setStatus(event.target.value)}>
                    <option value="">Any status</option>
                    <option value="active">In practice</option>
                    <option value="ready">Ready</option>
                    <option value="needsProfile">Needs details</option>
                    <option value="ingesting">Processing</option>
                    <option value="failed">Failed</option>
                  </select>
                </label>
                <label>
                  Sort
                  <select value={sort} onChange={(event) => setSort(event.target.value)}>
                    <option value="recent">Newest first</option>
                    <option value="title">Title A-Z</option>
                  </select>
                </label>
                {!!filterCount && (
                  <IconButton label="Clear material filters" size="sm" onPress={clearFilters}>
                    <X size={15} />
                  </IconButton>
                )}
              </div>
            )}

            {!sources ? (
              error ? null : (
                <div className="material-skeletons" aria-label="Loading materials" role="status">
                  {[1, 2, 3].map((item) => (
                    <div key={item} />
                  ))}
                </div>
              )
            ) : filtered.length === 0 ? (
              <div className="library-empty">
                <BookOpen size={34} aria-hidden="true" />
                <h3>{sources.length ? 'No matching materials' : 'A little more you.'}</h3>
                <p>
                  {sources.length
                    ? 'No materials match these filters.'
                    : 'Your stories, your interests, your next conversation.'}
                </p>
                <Button
                  variant={sources.length ? 'secondary' : 'primary'}
                  onPress={sources.length ? clearFilters : () => setAddOpen(true)}
                >
                  {sources.length ? (
                    <X size={16} aria-label="Clear filters" />
                  ) : (
                    <>
                      <Plus size={17} />
                      Add your first material
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <div className={`material-collection ${layout}`}>
                {groupMaterials(filtered).map((group) => {
                  const lessons = group.sources.map((source) => (
                  <button
                    key={source.id}
                    className={`material-item${source.isActive ? ' is-active' : ''}`}
                    onClick={() => setDetailId(source.id)}
                    aria-label={`Open ${source.title}, ${MATERIAL_KINDS[source.kind] ?? 'material'}`}
                  >
                    <div
                      className={`material-cover material-kind-${source.kind}`}
                      title={MATERIAL_KINDS[source.kind] ?? 'Material'}
                    >
                      <SourceIcon kind={source.kind} size={29} />
                      <span className="sr-only" title={MATERIAL_KINDS[source.kind] ?? 'Material'}>
                        {MATERIAL_KINDS[source.kind] ?? 'Material'}
                      </span>
                      {source.isActive && (
                        <span className="material-cover-active">
                          <Check size={15} />
                        </span>
                      )}
                    </div>
                    <div className="material-item-body">
                      <h3>{group.course ? source.title.match(/Unit \d+/)?.[0] ?? source.title : source.title}</h3>
                      <p>
                        {LANGUAGE_NAMES[source.language] ?? source.language}
                        {source.chunkCount > 0 && ` · ${source.chunkCount} parts`}
                      </p>
                      <div
                        className={`material-status status-${source.reconcileError ? 'failed' : source.reconciling ? 'ingesting' : source.status}${source.isActive ? ' active' : ''}`}
                      >
                        {PENDING_STATUSES.has(source.status) || source.reconciling ? (
                          <LoaderCircle size={13} className="material-spinner" />
                        ) : source.status === 'failed' || source.reconcileError ? (
                          <CircleAlert size={13} />
                        ) : (
                          <span className="status-dot" />
                        )}
                        {sourceStatus(source)}
                      </div>
                      {source.started && source.status === 'ready' && (
                        <progress
                          aria-label={`${source.title} progress`}
                          max={1}
                          value={Math.max(0, Math.min(1, source.progress))}
                        />
                      )}
                    </div>
                    <ChevronRight className="material-item-arrow" size={18} />
                  </button>
                  ));
                  if (!group.course) return lessons;
                  const total = groupMaterials(sources).find((item) => item.id === group.id)?.sources.length ?? group.sources.length;
                  return (
                    <details className="material-course" key={group.id}>
                      <summary className="material-course-summary">
                        <Headphones size={28} aria-hidden="true" />
                        <div>
                          <h3>{group.title}</h3>
                          <p>{LANGUAGE_NAMES[group.sources[0].language] ?? group.sources[0].language} · {total} lessons</p>
                          {group.sources.length < total && <p>{group.sources.length} matching lessons</p>}
                          {group.sources.some((source) => source.isActive) && <p>In practice</p>}
                          <span className="material-course-hint">Explore lessons in order</span>
                        </div>
                        <ChevronRight className="material-course-chevron" size={18} aria-hidden="true" />
                      </summary>
                      <div className="material-course-lessons" aria-label={`${group.title} lessons`}>
                        {lessons}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
            {sources && filtered.length > 0 && (
              <p className="materials-count">
                {groupMaterials(filtered).length} of {groupMaterials(sources).length} library items
              </p>
            )}
          </section>
        )}
      </div>

      {addOpen && (
        <AddMaterialDialog
          targetLang={targetLang}
          onClose={() => setAddOpen(false)}
          onAdded={(sourceId) => {
            setNotice('Material added. Preparing it for your library.');
            setView('materials');
            setProfileSourceId(sourceId);
            bumpContentVersion();
          }}
        />
      )}
      <ContentProfileSheet
        sourceId={profileSourceId}
        isOpen={profileSourceId !== null}
        onClose={() => setProfileSourceId(null)}
        onCompleted={() => {
          setNotice('Learning details saved.');
          bumpContentVersion();
        }}
      />
      <Modal.Backdrop
        isOpen={!!detail}
        isDismissable={!selectingId && !retryingId}
        onOpenChange={(open) => !open && !selectingId && !retryingId && setDetailId(null)}
      >
        <Modal.Container placement="auto">
          <Modal.Dialog className="material-dialog">
            <Modal.CloseTrigger isDisabled={!!selectingId || !!retryingId} />
            <Modal.Header>
              <span className="dialog-eyebrow">
                {detail ? (MATERIAL_KINDS[detail.kind] ?? 'MATERIAL') : ''}
              </span>
              <Modal.Heading>{detail?.title}</Modal.Heading>
            </Modal.Header>
            {detail && (
              <>
                <Modal.Body className="material-dialog-body">
                  <dl className="material-detail-meta">
                    <div>
                      <dt>Language</dt>
                      <dd>{LANGUAGE_NAMES[detail.language] ?? detail.language}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{sourceStatus(detail)}</dd>
                    </div>
                    <div>
                      <dt>Parts</dt>
                      <dd>{detail.chunkCount}</dd>
                    </div>
                    <div>
                      <dt>Practice progress</dt>
                      <dd>{Math.round(detail.progress * 100)}%</dd>
                    </div>
                  </dl>
                  {detail.status === 'failed' && (
                    <p className="material-form-error" role="alert">
                      {detail.ingestError ||
                        'This material could not be imported. Retry the import to try again.'}
                    </p>
                  )}
                  {detail.reconcileError && (
                    <p className="material-form-error" role="alert">
                      We could not finish preparing your practice. {detail.reconcileError}
                    </p>
                  )}
                  {detail.reconciling && (
                    <p className="material-detail-note" role="status">
                      Preparing practice from your starting point and learning preferences.
                    </p>
                  )}
                  {PENDING_STATUSES.has(detail.status) && (
                    <p className="material-detail-note" role="status">
                      {detail.status === 'uploaded'
                        ? 'Your material is queued. You can leave this page while we prepare it.'
                        : 'Extracting the text and organizing its chapters or timestamps. You can leave this page while we prepare it.'}
                    </p>
                  )}
                  {detail.needsProfile && detail.status === 'ready' && (
                    <p className="material-detail-note">
                      A few details about your experience with this material are still needed.
                    </p>
                  )}
                  {detail.language !== targetLang && (
                    <p className="material-detail-note">
                      Your conversation language is {LANGUAGE_NAMES[targetLang] ?? targetLang}. This
                      material is in {LANGUAGE_NAMES[detail.language] ?? detail.language}.
                    </p>
                  )}
                  {error && (
                    <p className="material-form-error" role="alert">
                      {error}
                    </p>
                  )}
                </Modal.Body>
                <Modal.Footer>
                  {detail.status === 'ready' && !detail.needsProfile && (
                    <Button
                      variant="secondary"
                      isDisabled={!!selectingId}
                      onPress={() => {
                        setDetailId(null);
                        setProfileSourceId(detail.id);
                      }}
                    >
                      Learning details
                    </Button>
                  )}
                  {detail.status === 'ready' &&
                    !detail.needsProfile &&
                    !detail.reconciling &&
                    !detail.reconcileError &&
                    detail.language === targetLang && (
                      <Button
                        variant="secondary"
                        isDisabled={!!selectingId}
                        onPress={() => {
                          setDetailId(null);
                          openSheet({
                            kind: 'chunkBrowser',
                            sourceId: detail.id,
                            sourceTitle: detail.title,
                          });
                        }}
                      >
                        <List size={16} />
                        Browse parts
                      </Button>
                    )}
                  {detail.status === 'ready' && !detail.reconcileError ? (
                    <Button
                      isPending={selectingId === detail.id}
                      isDisabled={!!detail.reconciling}
                      onPress={() => {
                        if (detail.language !== targetLang) {
                          setDetailId(null);
                          openSheet({ kind: 'language' });
                        } else if (detail.isActive && !detail.needsProfile) {
                          setDetailId(null);
                          setTab('voice');
                        } else void selectSource(detail);
                      }}
                    >
                      {detail.reconciling
                        ? 'Preparing practice...'
                        : detail.language !== targetLang
                          ? 'Change language'
                          : detail.needsProfile
                            ? 'Complete details'
                            : detail.isActive
                              ? 'Continue'
                              : 'Use in practice'}
                      <ArrowRight size={17} />
                    </Button>
                  ) : detail.status === 'failed' || detail.reconcileError ? (
                    <Button
                      isPending={retryingId === detail.id}
                      onPress={() => void retrySource(detail)}
                    >
                      <RefreshCw size={16} />
                      {detail.reconcileError ? 'Retry preparation' : 'Retry import'}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      onPress={() => {
                        setDetailId(null);
                        setProfileSourceId(detail.id);
                      }}
                    >
                      Set learning details
                    </Button>
                  )}
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
