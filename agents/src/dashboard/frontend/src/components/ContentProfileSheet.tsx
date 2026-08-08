/**
 * The "tell me about this" sheet — the typed half of content profiling.
 * See docs/superpowers/specs/2026-08-08-content-provenance-design.md §6.
 *
 * The questions are NOT hardcoded here. They come from
 * `GET /api/content-sources/:id/profile`, which serves the same specs
 * (lib/content-profile.ts) the voice tutor asks from. That's deliberate:
 * a learner can answer two questions here and the other two out loud in
 * their next session, and both halves have to agree on what's left. A
 * duplicated question list in the frontend would be the first thing to
 * drift.
 *
 * One question at a time, answered on tap, no submit button. There are at
 * most four, they're all one-tap, and a wall of four dropdowns is the
 * version of this people abandon.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Label, Modal, TextField } from '@heroui/react';
import { apiFetch } from '../lib/api';

interface ProfileQuestion {
  id: string;
  label: string;
  spoken: string;
  type: 'enum' | 'position' | 'boolean' | 'text';
  options?: { value: string; label: string }[];
  required: boolean;
}

interface ProfileState {
  title: string;
  kind: string;
  chunkCount: number;
  status: 'needed' | 'complete' | 'skipped';
  answers: Record<string, unknown>;
  questions: ProfileQuestion[];
  missing: string[];
  next: ProfileQuestion | null;
}

/** What a source's parts are called, so "How far did you get?" can offer
 *  "lesson 12" rather than "chunk 12". */
const PART_NOUN: Record<string, string> = {
  audio: 'lesson',
  textbook: 'chapter',
  youtube: 'section',
  movie: 'scene',
  text: 'section',
};

export default function ContentProfileSheet({
  sourceId,
  isOpen,
  onClose,
  onCompleted,
}: {
  sourceId: string | null;
  isOpen: boolean;
  onClose: () => void;
  /** Fired once the profile is finished, so the library can refetch — the
   *  tile ungreys and reconciliation may already have moved the learner. */
  onCompleted: () => void;
}) {
  const [state, setState] = useState<ProfileState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [positionInput, setPositionInput] = useState('');
  const [textInput, setTextInput] = useState('');

  const load = useCallback(async () => {
    if (!sourceId) return;
    try {
      const res = await apiFetch(`/api/content-sources/${sourceId}/profile`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(await res.json());
      setError(null);
    } catch {
      setError('Could not load the questions for this one.');
    }
  }, [sourceId]);

  useEffect(() => {
    if (isOpen) {
      setState(null);
      setPositionInput('');
      setTextInput('');
      load();
    }
  }, [isOpen, load]);

  const answer = useCallback(async (questionId: string, value: unknown) => {
    if (!sourceId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/content-sources/${sourceId}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: { [questionId]: value } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      setPositionInput('');
      setTextInput('');

      if (!result.next) {
        onCompleted();
        onClose();
        return;
      }
      await load();
    } catch {
      setError('That did not save — try again.');
    } finally {
      setSaving(false);
    }
  }, [sourceId, load, onCompleted, onClose]);

  const skip = useCallback(async () => {
    if (!sourceId) return;
    setSaving(true);
    try {
      await apiFetch(`/api/content-sources/${sourceId}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip: true }),
      });
      onCompleted();
      onClose();
    } catch {
      setError('Could not skip — try again.');
    } finally {
      setSaving(false);
    }
  }, [sourceId, onCompleted, onClose]);

  const question = state?.next ?? null;
  const partNoun = state ? PART_NOUN[state.kind] ?? 'section' : 'section';
  const answeredCount = state ? state.questions.filter((q) => q.required).length - state.missing.length : 0;
  const requiredCount = state ? state.questions.filter((q) => q.required).length : 0;

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="auto">
        <Modal.Dialog className="sm:max-w-md">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{state?.title ?? 'About this'}</Modal.Heading>
            <p className="mt-1.5 text-sm leading-5 text-muted">
              A couple of quick questions so this can be used properly in your lessons.
              {requiredCount > 0 && ` (${Math.max(0, answeredCount)}/${requiredCount})`}
            </p>
          </Modal.Header>

          <Modal.Body className="flex flex-col gap-4 p-6">
            {error && (
              <p className="text-sm" style={{ color: 'var(--danger, #ef4444)' }}>{error}</p>
            )}

            {!state ? (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p>
            ) : !question ? (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                All set — nothing else to ask.
              </p>
            ) : (
              <>
                <p className="text-base font-medium">{question.label}</p>

                {question.type === 'enum' && (
                  <div className="flex flex-col gap-2">
                    {question.options?.map((opt) => (
                      <Button
                        key={opt.value}
                        variant="secondary"
                        isDisabled={saving}
                        onPress={() => answer(question.id, opt.value)}
                        className="justify-start text-left"
                      >
                        {opt.label}
                      </Button>
                    ))}
                  </div>
                )}

                {question.type === 'boolean' && (
                  <div className="flex gap-2">
                    <Button variant="secondary" isDisabled={saving} onPress={() => answer(question.id, true)}>
                      Yes
                    </Button>
                    <Button variant="secondary" isDisabled={saving} onPress={() => answer(question.id, false)}>
                      No
                    </Button>
                  </div>
                )}

                {question.type === 'position' && (
                  <div className="flex flex-col gap-2">
                    {/* A count, not an index — "I did the first 12" is how
                        people describe this, and the server converts. */}
                    <TextField value={positionInput} onChange={setPositionInput}>
                      <Label className="text-sm">
                        How many {partNoun}s did you get through?
                        {state.chunkCount > 0 && ` (out of ${state.chunkCount})`}
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={state.chunkCount || undefined}
                        placeholder={`e.g. 12`}
                        inputMode="numeric"
                      />
                    </TextField>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        isDisabled={saving || !positionInput.trim()}
                        onPress={() => answer(question.id, { count: Number(positionInput) })}
                      >
                        Save
                      </Button>
                      <Button variant="secondary" isDisabled={saving} onPress={() => answer(question.id, 'all')}>
                        All of it
                      </Button>
                      <Button variant="secondary" isDisabled={saving} onPress={() => answer(question.id, 'none')}>
                        Just starting
                      </Button>
                    </div>
                  </div>
                )}

                {question.type === 'text' && (
                  <div className="flex flex-col gap-2">
                    <TextField value={textInput} onChange={setTextInput}>
                      <Label className="sr-only">{question.label}</Label>
                      <Input placeholder="A sentence is plenty" />
                    </TextField>
                    <Button isDisabled={saving} onPress={() => answer(question.id, textInput.trim())}>
                      Save
                    </Button>
                  </div>
                )}
              </>
            )}
          </Modal.Body>

          <Modal.Footer>
            {/* Skipping reconciles on conservative defaults rather than
                leaving the source unusable — and stops the nagging. */}
            <Button variant="secondary" isDisabled={saving} onPress={skip}>
              Don't ask
            </Button>
            <Button slot="close" variant="secondary" isDisabled={saving}>
              Later
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
