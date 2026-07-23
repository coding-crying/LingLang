/**
 * OnboardingGate — shown before the voice room if the user hasn't completed
 * onboarding for their target language.
 *
 * 2026-07-16: cut down from a 3-question form (prior study / goals /
 * self-rated level) to just the one question the tutor can't easily infer
 * from a few turns of conversation. Prior study and goals are gathered
 * conversationally instead — the agent already extracts them via
 * onboarding_signal supervisor triggers (see server.ts's relaxed
 * validation on this endpoint, priorStudy/goals are optional now).
 *
 * Two paths:
 *   1. Pick a level → POST /api/users/:id/onboarding/:lang → done
 *   2. "Talk to the tutor instead" → skip the question, connect to voice
 *      room (the agent runs the onboarding conversation itself)
 */

import { useState } from 'react';
import { Button, Description, Radio, RadioGroup, Typography } from '@heroui/react';
import { apiFetch } from './lib/api';

const LEVEL_OPTIONS = [
  { value: 'pre_a1', label: 'Zero', description: 'I know nothing yet' },
  { value: 'a1', label: 'A1', description: 'A few words and phrases' },
  { value: 'a2', label: 'A2', description: 'Basic conversations' },
  { value: 'b1', label: 'B1', description: 'Can get by in most situations' },
  { value: 'b2', label: 'B2', description: 'Comfortable, some gaps' },
  { value: 'c1', label: 'C1', description: 'Fluent, near-native' },
  { value: 'c2', label: 'C2', description: 'Native / bilingual' },
];

interface Props {
  userId: string;
  targetLanguage: string;   // ISO code: 'ru', 'pt', etc.
  languageName: string;     // Display name: 'Russian', 'Portuguese'
  onComplete: () => void;   // Called when onboarding is done (either path)
  onSkipToVoice: () => void; // Called when user wants to talk to tutor instead
}

export default function OnboardingGate({
  userId,
  targetLanguage,
  languageName,
  onComplete,
  onSkipToVoice,
}: Props) {
  const [selfRatedLevel, setSelfRatedLevel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selfRatedLevel) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/users/${userId}/onboarding/${targetLanguage}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selfRatedLevel }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Submission failed');
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-card">
        <div className="onboarding-header">
          <Typography.Heading level={2}>Welcome to LingLang 👋</Typography.Heading>
          <Typography.Paragraph style={{ color: 'var(--muted)' }}>
            How would you rate your current {languageName}?
          </Typography.Paragraph>
        </div>

        <form onSubmit={submit} className="onboarding-form">
          <RadioGroup
            value={selfRatedLevel}
            onChange={setSelfRatedLevel}
            aria-label={`Current ${languageName} level`}
          >
            {LEVEL_OPTIONS.map((opt) => (
              <Radio key={opt.value} value={opt.value}>
                <Radio.Content>
                  <Radio.Control>
                    <Radio.Indicator />
                  </Radio.Control>
                  {opt.label}
                </Radio.Content>
                <Description>{opt.description}</Description>
              </Radio>
            ))}
          </RadioGroup>

          {error && <div className="error-msg">{error}</div>}

          <div className="onboarding-actions">
            <Button
              type="submit"
              variant="primary"
              isDisabled={!selfRatedLevel}
              isPending={submitting}
            >
              {submitting ? 'Saving…' : "Let's go →"}
            </Button>
            <Button type="button" variant="ghost" onPress={onSkipToVoice}>
              Or, talk to the tutor instead →
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
