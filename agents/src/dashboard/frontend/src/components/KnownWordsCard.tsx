// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Button, Input, Modal, TextField } from '@heroui/react';
import {
  ArrowDown,
  ArrowDownAZ,
  BookOpen,
  BookOpenCheck,
  Calendar,
  ChevronDown,
  ChevronRight,
  Ear,
  Globe,
  Info,
  Languages,
  ListFilter,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';
import { apiFetch } from '../lib/api';
import { wordBankStateAriaLabel } from '../lib/word-bank-ui';
import { useAppState } from '../state/AppState';
import IconButton from './IconButton';
import LearningEvidenceCard from './LearningEvidenceCard';
import './word-bank.css';

interface Buckets {
  new: number;
  learning: number;
  mastered: number;
  relearning: number;
  total: number;
}

interface WordRow {
  lemma: string;
  translation: string;
  pos: string;
  language: string;
  state: number;
  reps: number;
  lapses: number;
  stability: number;
  receptiveExposures: number;
  origin: string;
  lastReview: string | null;
  createdAt: string;
  due?: string | null;
}

interface KnownWordsResponse {
  buckets: Record<string, Buckets>;
  totals: Buckets;
  recent: { week: number; month: number };
  words: WordRow[];
}

interface LoadedWords {
  key: string;
  response: KnownWordsResponse;
  nextOffset: number;
  exhausted: boolean;
}

type Sort = 'lastUsed' | 'due';
type StateFilter = 'all' | 'new' | 'learning' | 'mastered' | 'relearning';

const PAGE_SIZE = 50;
const STATES = [
  { key: 'new', label: 'Heard', state: 0 },
  { key: 'learning', label: 'Learning', state: 1 },
  { key: 'mastered', label: 'Review', state: 2 },
  { key: 'relearning', label: 'Relearning', state: 3 },
] as const;

const STATE_ICONS = {
  new: Ear,
  learning: BookOpenCheck,
  mastered: RotateCcw,
  relearning: RefreshCw,
} as const;

function stateMeta(state: number) {
  return STATES.find((item) => item.state === state);
}

function dateLabel(iso: string | null | undefined): string {
  if (!iso) return 'Not recorded';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function daysFromToday(timestamp: number): number {
  const date = new Date(timestamp);
  const today = new Date();
  return Math.round((date.setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 86_400_000);
}

function lastUsedLabel(word: WordRow): string {
  if (!word.lastReview || word.reps === 0) return 'Not yet practised';
  const timestamp = new Date(word.lastReview).getTime();
  if (Number.isNaN(timestamp)) return 'Not recorded';
  const days = -daysFromToday(timestamp);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

function dueLabel(iso: string | null | undefined): string {
  if (!iso) return 'Not scheduled';
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return 'Not scheduled';
  if (timestamp <= Date.now()) return 'Due now';
  const days = daysFromToday(timestamp);
  if (days === 0) return 'Later today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

async function fetchWords(
  userId: string,
  language: string,
  sort: Sort,
  offset: number,
  signal: AbortSignal,
): Promise<KnownWordsResponse> {
  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
    sort,
  });
  if (language) query.set('language', language);
  // The API searches after pagination, so search and state filters apply to loaded rows only.
  const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}/known-words?${query}`, {
    signal,
  });
  if (!response.ok) throw new Error(`Word bank request failed: ${response.status}`);
  return response.json() as Promise<KnownWordsResponse>;
}

function WordState({ state }: { state: number }) {
  const meta = stateMeta(state);
  return (
    <span className={`wb-state wb-state--${meta?.key ?? 'unknown'}`}>
      <span aria-hidden="true" />
      {meta?.label ?? 'Unclassified'}
    </span>
  );
}

export default function KnownWordsCard({
  userId,
  onAddContent,
}: {
  userId: string | null;
  onAddContent?: () => void;
}) {
  const { contentVersion } = useAppState();
  const [language, setLanguage] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('lastUsed');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<LoadedWords | null>(null);
  const [request, setRequest] = useState({
    key: '',
    pending: false,
    error: false,
  });
  const [languageCatalog, setLanguageCatalog] = useState<{
    userId: string | null;
    languages: string[];
  }>({ userId: null, languages: [] });
  const [selectedWord, setSelectedWord] = useState<WordRow | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const queryKey = JSON.stringify([userId, language, sort, contentVersion, refresh]);
  const data = loaded?.key === queryKey ? loaded : null;
  const pending = request.key === queryKey ? request.pending : true;
  const error = request.key === queryKey && request.error;

  useEffect(() => {
    setLanguage('');
    setSearch('');
    setStateFilter('all');
    setSelectedWord(null);
  }, [userId]);

  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setSelectedWord(null);
    if (!userId) return () => controller.abort();

    setRequest({ key: queryKey, pending: true, error: false });
    void fetchWords(userId, language, sort, 0, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setLoaded({
          key: queryKey,
          response,
          nextOffset: response.words.length,
          exhausted:
            response.words.length < PAGE_SIZE || response.words.length >= response.totals.total,
        });
        setLanguageCatalog((current) => ({
          userId,
          languages: [
            ...new Set([
              ...(current.userId === userId ? current.languages : []),
              ...Object.keys(response.buckets),
            ]),
          ].sort((a, b) => (LANGUAGE_NAMES[a] ?? a).localeCompare(LANGUAGE_NAMES[b] ?? b)),
        }));
        setRequest({ key: queryKey, pending: false, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRequest({ key: queryKey, pending: false, error: true });
        }
      });

    return () => {
      controller.abort();
      controllerRef.current?.abort();
    };
  }, [userId, language, sort, queryKey]);

  async function loadMore() {
    if (!userId || !data || pending || data.exhausted) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setRequest({ key: queryKey, pending: true, error: false });
    try {
      const response = await fetchWords(userId, language, sort, data.nextOffset, controller.signal);
      if (controller.signal.aborted) return;
      const nextOffset = data.nextOffset + response.words.length;
      setLoaded((current) =>
        current?.key === queryKey
          ? {
              key: queryKey,
              response: {
                ...response,
                words: [...current.response.words, ...response.words],
              },
              nextOffset,
              exhausted: response.words.length < PAGE_SIZE || nextOffset >= response.totals.total,
            }
          : current,
      );
      setRequest({ key: queryKey, pending: false, error: false });
    } catch {
      if (!controller.signal.aborted) {
        setRequest({ key: queryKey, pending: false, error: true });
      }
    }
  }

  const words = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const state = STATES.find((item) => item.key === stateFilter)?.state;
    return (data?.response.words ?? []).filter(
      (word) =>
        (state === undefined || state === word.state) &&
        (!query ||
          word.lemma.toLocaleLowerCase().includes(query) ||
          (word.translation ?? '').toLocaleLowerCase().includes(query)),
    );
  }, [data, search, stateFilter]);

  if (!userId) return null;

  const totals = data?.response.totals;
  const languages = languageCatalog.userId === userId ? languageCatalog.languages : [];
  const loadedCount = data?.response.words.length ?? 0;
  const total = totals?.total ?? 0;
  const partial = loadedCount < total;
  const isFiltered = Boolean(search.trim()) || stateFilter !== 'all';
  const clearFilters = () => {
    setSearch('');
    setStateFilter('all');
  };

  return (
    <div className="word-bank">
      <section aria-labelledby="word-bank-heading" className="wb-workspace">
        <div className="wb-heading">
          <div>
            <h2 id="word-bank-heading">Words in progress</h2>
            <p>{data ? `${total.toLocaleString()} words recorded` : 'Your vocabulary'}</p>
          </div>
          <IconButton
            label="Refresh words"
            className="wb-refresh"
            isDisabled={pending}
            onPress={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={17} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="wb-stats" role="group" aria-label="Word scheduling states">
          {STATES.map((item) => {
            const Icon = STATE_ICONS[item.key];
            const count = totals ? totals[item.key].toLocaleString() : '-';
            return (
              <div key={item.key} className="wb-stat-wrap">
                <button
                  type="button"
                  className={`wb-stat wb-stat--${item.key}`}
                  aria-label={wordBankStateAriaLabel(item.label, count)}
                  title={item.label}
                  aria-pressed={stateFilter === item.key}
                  onClick={() =>
                    setStateFilter((current) => (current === item.key ? 'all' : item.key))
                  }
                >
                  <strong>{count}</strong>
                  <Icon className="wb-stat-icon" size={20} aria-hidden="true" />
                  <span className="wb-sr-only">{item.label}</span>
                </button>
                <span className="wb-stat-tooltip" aria-hidden="true">
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>

        <div className="wb-toolbar">
          <TextField
            aria-label={partial ? 'Search loaded words' : 'Search words'}
            value={search}
            onChange={setSearch}
            className="wb-search"
          >
            <div className="wb-search-control">
              <Search size={18} aria-hidden="true" />
              <Input placeholder={partial ? 'Search loaded words' : 'Search words or meanings'} />
              {search && (
                <IconButton label="Clear word search" size="sm" onPress={() => setSearch('')}>
                  <X size={15} aria-hidden="true" />
                </IconButton>
              )}
            </div>
          </TextField>
          <div className="wb-filter">
            <Languages className="wb-filter-icon" size={16} aria-hidden="true" />
            <select
              aria-label="Filter words by language"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="">All languages</option>
              {languages.map((code) => (
                <option key={code} value={code}>
                  {LANGUAGE_NAMES[code] ?? code}
                </option>
              ))}
            </select>
            <ChevronDown className="wb-filter-chevron" size={15} aria-hidden="true" />
          </div>
          <div className="wb-filter">
            <ListFilter className="wb-filter-icon" size={16} aria-hidden="true" />
            <select
              aria-label="Filter words by state"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value as StateFilter)}
            >
              <option value="all">All states</option>
              {STATES.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
            <ChevronDown className="wb-filter-chevron" size={15} aria-hidden="true" />
          </div>
          <div className="wb-filter wb-sort">
            <ArrowDownAZ className="wb-filter-icon" size={16} aria-hidden="true" />
            <select
              aria-label="Sort words"
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
            >
              <option value="lastUsed">Recently practised</option>
              <option value="due">Next review</option>
            </select>
            <ChevronDown className="wb-filter-chevron" size={15} aria-hidden="true" />
          </div>
        </div>

        {data && (
          <div className="wb-results-meta" role="status">
            <span>
              {isFiltered
                ? `${words.length.toLocaleString()} ${words.length === 1 ? 'match' : 'matches'}${partial ? ` in ${loadedCount.toLocaleString()} loaded words` : ''}`
                : `${loadedCount.toLocaleString()} of ${total.toLocaleString()} words loaded`}
            </span>
            {isFiltered ? (
              <IconButton label="Clear word filters" onPress={clearFilters}>
                <X size={13} aria-hidden="true" />
              </IconButton>
            ) : data.response.recent.week > 0 ? (
              <span className="wb-recent">
                {data.response.recent.week.toLocaleString()} added this week
              </span>
            ) : null}
          </div>
        )}

        {!data && pending ? (
          <div className="wb-loading" role="status" aria-label="Loading words">
            <span className="wb-sr-only">Loading your word bank</span>
            {[0, 1, 2, 3, 4].map((row) => (
              <div className="wb-skeleton-row" key={row} aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            ))}
          </div>
        ) : !data && error ? (
          <div className="wb-empty" role="alert">
            <BookOpen size={28} aria-hidden="true" />
            <h3>Your word bank is unavailable</h3>
            <p>We couldn't load your words. Please try again.</p>
            <Button variant="secondary" onPress={() => setRefresh((value) => value + 1)}>
              <RefreshCw size={16} aria-hidden="true" />
              Try again
            </Button>
          </div>
        ) : data && words.length === 0 ? (
          <div className="wb-empty">
            {total === 0 ? (
              <BookOpen size={28} aria-hidden="true" />
            ) : (
              <Search size={28} aria-hidden="true" />
            )}
            <h3>
              {total === 0
                ? 'Your word bank starts here'
                : partial
                  ? 'No matches in loaded words'
                  : 'No matching words'}
            </h3>
            <p>
              {total === 0
                ? 'No words have been recorded yet.'
                : partial
                  ? `${loadedCount.toLocaleString()} of ${total.toLocaleString()} words loaded.`
                  : 'Try another word, meaning, or state.'}
            </p>
            {total === 0 && onAddContent ? (
              <Button onPress={onAddContent}>
                <Plus size={16} aria-hidden="true" />
                Add material
              </Button>
            ) : isFiltered ? (
              <Button variant="secondary" onPress={clearFilters} aria-label="Clear filters">
                <X size={16} aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        ) : data ? (
          <table className="wb-table">
            <caption className="wb-sr-only">Words in your bank</caption>
            <thead>
              <tr>
                <th scope="col">Word</th>
                <th scope="col" className="wb-meaning">
                  Meaning
                </th>
                <th scope="col" className="wb-language">
                  <Globe size={13} aria-hidden="true" />
                  <span className="wb-sr-only">Language</span>
                </th>
                <th scope="col">State</th>
                <th scope="col" className="wb-activity">
                  <Calendar size={13} aria-hidden="true" />
                  <span className="wb-sr-only">
                    {sort === 'due' ? 'Next review' : 'Last practised'}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {words.map((word, index) => {
                const activity = sort === 'due' ? dueLabel(word.due) : lastUsedLabel(word);
                return (
                  <tr
                    key={`${word.language}:${word.lemma}:${word.pos}:${index}`}
                    onClick={() => setSelectedWord(word)}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="wb-word"
                        onClick={() => setSelectedWord(word)}
                      >
                        <bdi>{word.lemma}</bdi>
                        <span className="wb-mobile-meaning">
                          {word.translation || 'No meaning recorded'}
                        </span>
                        <span className="wb-mobile-language">
                          {LANGUAGE_NAMES[word.language] ?? word.language}
                        </span>
                      </button>
                    </th>
                    <td className="wb-meaning">
                      {word.translation || <span className="wb-muted">Not recorded</span>}
                    </td>
                    <td className="wb-language">
                      {LANGUAGE_NAMES[word.language] ?? word.language}
                    </td>
                    <td className="wb-state-cell">
                      <WordState state={word.state} />
                      <span className="wb-mobile-activity">{activity}</span>
                    </td>
                    <td className="wb-activity">
                      <span>
                        {activity}
                        <ChevronRight size={15} aria-hidden="true" />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}

        {data && (partial || error) && (
          <div className="wb-pagination">
            <p role={error ? 'alert' : undefined} className={error ? 'wb-error' : undefined}>
              {error
                ? 'Could not load more words.'
                : `${loadedCount.toLocaleString()} of ${total.toLocaleString()} words loaded`}
            </p>
            {!data.exhausted ? (
              <Button variant="secondary" isDisabled={pending} onPress={loadMore}>
                {error ? (
                  <RefreshCw size={16} aria-hidden="true" />
                ) : (
                  <ArrowDown size={16} aria-hidden="true" />
                )}
                {pending ? 'Loading…' : error ? 'Try again' : 'Load more'}
              </Button>
            ) : partial ? (
              <IconButton
                label="Refresh words"
                variant="secondary"
                onPress={() => setRefresh((value) => value + 1)}
              >
                <RefreshCw size={16} aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        )}

        <p className="wb-note">
          <Info size={15} aria-hidden="true" />
          <span>
            These are review scheduling states, not proof of mastery. Earlier practice records have
            not been reassessed.
          </span>
        </p>
      </section>

      <LearningEvidenceCard userId={userId} language={language} refreshKey={contentVersion} />

      <Modal.Backdrop
        isOpen={selectedWord !== null && data !== null}
        onOpenChange={(open) => !open && setSelectedWord(null)}
      >
        <Modal.Container placement="auto">
          <Modal.Dialog className="wb-detail">
            <Modal.CloseTrigger />
            {selectedWord && data && (
              <>
                <Modal.Header>
                  <p className="wb-detail-language">
                    {LANGUAGE_NAMES[selectedWord.language] ?? selectedWord.language}
                    {selectedWord.pos ? ` / ${selectedWord.pos}` : ''}
                  </p>
                  <Modal.Heading className="wb-detail-word">
                    <bdi>{selectedWord.lemma}</bdi>
                  </Modal.Heading>
                  <p className="wb-detail-meaning">
                    {selectedWord.translation || 'No meaning recorded'}
                  </p>
                </Modal.Header>
                <Modal.Body className="wb-detail-body">
                  <div className="wb-detail-status">
                    <span>Scheduling state</span>
                    <WordState state={selectedWord.state} />
                  </div>
                  <dl className="wb-detail-facts">
                    <div>
                      <dt>Last practised</dt>
                      <dd>
                        {selectedWord.reps > 0
                          ? dateLabel(selectedWord.lastReview)
                          : 'Not yet practised'}
                      </dd>
                    </div>
                    <div>
                      <dt>Next review</dt>
                      <dd>{selectedWord.due ? dateLabel(selectedWord.due) : 'Not scheduled'}</dd>
                    </div>
                    <div>
                      <dt>Practice records</dt>
                      <dd>{selectedWord.reps.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Times heard</dt>
                      <dd>{selectedWord.receptiveExposures.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Added</dt>
                      <dd>{dateLabel(selectedWord.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Origin</dt>
                      <dd>
                        {selectedWord.origin === 'seeded'
                          ? 'Prior learning'
                          : selectedWord.origin === 'conversation'
                            ? 'Conversation'
                            : selectedWord.origin || 'Not recorded'}
                      </dd>
                    </div>
                  </dl>
                  <p className="wb-note">
                    <Info size={15} aria-hidden="true" />
                    <span>
                      {selectedWord.origin === 'seeded'
                        ? 'Added from your prior learning history. This record has not been confirmed in conversation.'
                        : 'Review is a scheduling state, not a measure of mastery.'}
                    </span>
                  </p>
                </Modal.Body>
                <Modal.Footer>
                  <Button slot="close" variant="secondary">
                    Done
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
