/**
 * OnboardingGate — shown before the voice room if the user hasn't completed
 * onboarding for their target language.
 *
 * Two paths:
 *   1. Fill the form → POST /api/users/:id/onboarding/:lang → done
 *   2. "Talk to the tutor instead" → skip form, connect to voice room
 *      (the agent will run the onboarding conversation itself)
 */

import { useState } from 'react';

const GOAL_OPTIONS = [
  { value: 'travel', label: '✈️ Travel' },
  { value: 'work', label: '💼 Work / Business' },
  { value: 'heritage', label: '🏠 Heritage / Family' },
  { value: 'media', label: '🎬 Media (shows, music, books)' },
  { value: 'academic', label: '🎓 Academic' },
  { value: 'other', label: '✨ Other' },
];

const PRIOR_STUDY_OPTIONS = [
  { value: 'none', label: "I'm a complete beginner" },
  { value: 'self_taught', label: 'Self-taught (apps, YouTube, etc.)' },
  { value: 'class', label: 'Formal classes / school' },
  { value: 'immersion', label: 'Lived in a country / immersion' },
  { value: 'heritage', label: 'Heritage speaker (grew up hearing it)' },
];

const LEVEL_OPTIONS = [
  { value: 'pre_a1', label: 'Zero — I know nothing' },
  { value: 'a1', label: 'A1 — A few words and phrases' },
  { value: 'a2', label: 'A2 — Basic conversations' },
  { value: 'b1', label: 'B1 — Can get by in most situations' },
  { value: 'b2', label: 'B2 — Comfortable, some gaps' },
  { value: 'c1', label: 'C1 — Fluent, near-native' },
  { value: 'c2', label: 'C2 — Native / bilingual' },
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
  const [priorStudy, setPriorStudy] = useState('');
  const [studyDetails, setStudyDetails] = useState('');
  const [goals, setGoals] = useState<string[]>([]);
  const [goalDetails, setGoalDetails] = useState('');
  const [selfRatedLevel, setSelfRatedLevel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleGoal = (val: string) => {
    setGoals((prev) =>
      prev.includes(val) ? prev.filter((g) => g !== val) : [...prev, val]
    );
  };

  const canSubmit = priorStudy && goals.length > 0 && selfRatedLevel;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/onboarding/${targetLanguage}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priorStudy,
          studyDetails: studyDetails || undefined,
          goals,
          goalDetails: goalDetails || undefined,
          selfRatedLevel,
        }),
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
          <h2>Welcome to LingLang 👋</h2>
          <p>
            Before we start, tell us a bit about your {languageName} background.
            This helps us calibrate your sessions from day one.
          </p>
        </div>

        <form onSubmit={submit} className="onboarding-form">
          {/* Prior study */}
          <fieldset>
            <legend>Have you studied {languageName} before?</legend>
            <div className="radio-group">
              {PRIOR_STUDY_OPTIONS.map((opt) => (
                <label key={opt.value} className={`radio-option ${priorStudy === opt.value ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="priorStudy"
                    value={opt.value}
                    checked={priorStudy === opt.value}
                    onChange={() => setPriorStudy(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
            {priorStudy && priorStudy !== 'none' && (
              <input
                type="text"
                className="text-input"
                placeholder={`Tell us more — e.g. "Duolingo for 6 months", "2 years of classes in high school"`}
                value={studyDetails}
                onChange={(e) => setStudyDetails(e.target.value)}
              />
            )}
          </fieldset>

          {/* Goals */}
          <fieldset>
            <legend>Why are you learning {languageName}? (pick all that apply)</legend>
            <div className="checkbox-group">
              {GOAL_OPTIONS.map((opt) => (
                <label key={opt.value} className={`checkbox-option ${goals.includes(opt.value) ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    value={opt.value}
                    checked={goals.includes(opt.value)}
                    onChange={() => toggleGoal(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
            {goals.length > 0 && (
              <input
                type="text"
                className="text-input"
                placeholder={`Anything specific? e.g. "Moving to Lisbon in 6 months"`}
                value={goalDetails}
                onChange={(e) => setGoalDetails(e.target.value)}
              />
            )}
          </fieldset>

          {/* Self-rated level */}
          <fieldset>
            <legend>How would you rate your current {languageName}?</legend>
            <div className="radio-group">
              {LEVEL_OPTIONS.map((opt) => (
                <label key={opt.value} className={`radio-option ${selfRatedLevel === opt.value ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="selfRatedLevel"
                    value={opt.value}
                    checked={selfRatedLevel === opt.value}
                    onChange={() => setSelfRatedLevel(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>

          {error && <div className="error-msg">{error}</div>}

          <div className="onboarding-actions">
            <button
              type="submit"
              className="btn-primary"
              disabled={!canSubmit || submitting}
            >
              {submitting ? 'Saving…' : "Let's go →"}
            </button>
            <button
              type="button"
              className="btn-text"
              onClick={onSkipToVoice}
            >
              Or, talk to the tutor instead →
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
