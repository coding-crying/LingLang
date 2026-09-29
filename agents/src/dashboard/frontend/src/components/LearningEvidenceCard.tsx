// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { evidenceLabel } from '../lib/evidence-labels';
import IconButton from './IconButton';

interface EvidenceEvent {
  id: string;
  language: string;
  occurred_at: string;
  model: string;
  status: string;
  result: null | {
    observations: {
      lemma: string;
      kind: string;
      assistance: string;
      outcome: string;
      ambiguity: string | null;
      evidence: { turnId: string; quote: string }[];
    }[];
  };
  packet: { turns: { id: string; role: string; text: string }[] };
}
interface EvidenceResponse {
  ownerId: string;
  mode: 'off' | 'shadow';
  events: EvidenceEvent[];
}
export default function LearningEvidenceCard({
  userId,
  language,
  refreshKey,
}: {
  userId: string;
  language: string;
  refreshKey: number;
}) {
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    setData(null);
    setError(false);
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const query = language ? `?language=${encodeURIComponent(language)}` : '';
        const response = await apiFetch(`/api/learning-evidence${query}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Evidence unavailable');
        const result = (await response.json()) as EvidenceResponse;
        if (!controller.signal.aborted) {
          setData(result);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [userId, language, refreshKey, refresh]);
  if (data && (data.mode === 'off' || data.ownerId !== userId)) return null;
  return (
    <section
      aria-label="Conversation learning evidence"
      className="border-t border-default pt-3 mt-2"
    >
      <div className="flex justify-between gap-2 items-center">
        <h3 className="text-sm font-semibold">
          Conversation evidence <span className="text-xs opacity-60">· experimental</span>
        </h3>
        <IconButton label="Refresh evidence" onPress={() => setRefresh((n) => n + 1)}>
          <RefreshCw size={15} aria-hidden="true" />
        </IconButton>
      </div>
      <p className="text-xs opacity-70 mt-1">
        Shadow analysis: observations are not certified mastery and do not change your schedule.
      </p>
      {error ? (
        <p role="status" className="text-xs mt-2">
          Evidence is temporarily unavailable. Your conversation is unaffected.
        </p>
      ) : !data ? (
        <p role="status" className="text-xs mt-2">
          Loading evidence…
        </p>
      ) : data.events.length === 0 ? (
        <p className="text-xs mt-2">No observations yet. New conversations will appear here.</p>
      ) : (
        <div className="space-y-2 mt-3">
          {data.events.slice(0, 8).map((event) => (
            <details key={event.id} className="text-xs">
              <summary className="cursor-pointer">
                {event.language.toUpperCase()} · {new Date(event.occurred_at).toLocaleString()} ·{' '}
                {event.status === 'accepted'
                  ? `${event.result?.observations.length ?? 0} observations`
                  : event.status === 'pending'
                    ? 'Analysis pending'
                    : 'Analysis unavailable — event retained'}
              </summary>
              <p className="opacity-60 mt-1">Assessment model: {event.model} · unverified</p>
              <div className="mt-2 space-y-1">
                {event.packet.turns.map((t) => (
                  <p key={t.id}>
                    <strong>{t.role === 'tutor' ? 'Tutor' : 'You'}:</strong> {t.text}
                  </p>
                ))}
              </div>
              <ul className="mt-2 space-y-2">
                {event.result?.observations.map((o) => (
                  <li key={o.lemma}>
                    <strong>{o.lemma}</strong> — {evidenceLabel(o)}
                    {o.ambiguity && <p className="opacity-70">{o.ambiguity}</p>}
                    <p className="opacity-60">
                      Evidence: {o.evidence.map((e) => `“${e.quote}”`).join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
