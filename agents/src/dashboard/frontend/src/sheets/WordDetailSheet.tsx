import { Button } from '@heroui/react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

interface VocabularyWord {
  id: string;
  lemma: string;
  pos: string | null;
  language: string;
  translation: string | null;
  stateName: string;
  stability: number;
  reps: number;
  lapses: number;
  due: string;
  scaffoldedCount: number;
  nativeSubstitutionCount: number;
  isMastered: boolean;
}

export default function WordDetailSheet({
  wordId,
  targetLang,
  onClose,
}: {
  wordId: string;
  targetLang: string;
  onClose: () => void;
}) {
  const [word, setWord] = useState<VocabularyWord | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setWord(null);
    const params = new URLSearchParams({ lang: targetLang, sort: 'due' });
    apiFetch(`/api/vocabulary?${params}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load word details.');
        const payload = (await response.json()) as { words?: VocabularyWord[] };
        if (!cancelled) {
          setWord(payload.words?.find((candidate) => candidate.id === wordId) ?? null);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [targetLang, wordId]);

  if (status === 'loading') return <p className="sheet-status">Loading word…</p>;
  if (status === 'error') {
    return (
      <div className="sheet-stack">
        <p className="error-msg">Could not load this word.</p>
        <Button variant="secondary" onPress={onClose}>
          Close
        </Button>
      </div>
    );
  }
  if (!word) {
    return (
      <div className="sheet-stack">
        <p className="sheet-status">This word is no longer in your word bank.</p>
        <Button variant="secondary" onPress={onClose}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="sheet-stack word-detail-sheet">
      <div>
        <p className="page-eyebrow">WORD BANK</p>
        <h2>{word.lemma}</h2>
        <p className="word-detail-translation">
          {word.translation || 'No translation recorded'}
          {word.pos ? ` · ${word.pos}` : ''}
        </p>
      </div>
      <div className="word-detail-grid">
        <span>Status</span>
        <strong>{word.isMastered ? 'Mastered' : word.stateName}</strong>
        <span>Reviews</span>
        <strong>{word.reps}</strong>
        <span>Stability</span>
        <strong>{word.stability.toFixed(1)} days</strong>
        <span>Lapses</span>
        <strong>{word.lapses}</strong>
        <span>Scaffolded</span>
        <strong>{word.scaffoldedCount}</strong>
        <span>Native substitutions</span>
        <strong>{word.nativeSubstitutionCount}</strong>
      </div>
      <Button variant="secondary" onPress={onClose}>
        Close
      </Button>
    </div>
  );
}
