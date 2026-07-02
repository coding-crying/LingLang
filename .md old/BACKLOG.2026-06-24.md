# LingLang — Feature Backlog

## Queued 2026-06-24

### 1. Planner: Dynamic Target Language Switching
- **What:** When user says "let's try Spanish" / "switch to French", the supervisor/planner updates `users.targetLanguage` in the DB and refreshes the agent's system prompt mid-session.
- **Why:** Currently target language is set at session start and can't change. Users should be able to switch naturally in conversation.
- **Where:** `supervisor-functions.ts` (planner), `tutor-event-driven.ts` (agent instructions refresh), `db/schema.ts` (users table already has `targetLanguage`).

### 2. Processor: Immediate-Action Triggers Field
- **What:** Add a `supervisorTriggers` (or `immediateActions`) field to the processor's JSON output schema. When the processor detects something requiring immediate supervisor intervention (language change request, user frustration, topic shift to something requiring goal change), it populates this field. The agent pipeline checks this field after each utterance and dispatches the supervisor immediately if populated — no waiting for the next planner timer cycle.
- **Why:** Currently the planner runs on a timer. Some user utterances need immediate action (language switch, "this is too hard", "I want to focus on grammar"). The processor already sees every utterance — adding a trigger field lets it flag these without a separate detection pass.
- **Schema addition to processor prompt:**
  ```json
  "supervisorTriggers": [
    {
      "type": "language_change" | "difficulty_adjustment" | "goal_change" | "session_feedback",
      "value": "es",
      "reason": "User explicitly requested switching to Spanish"
    }
  ]
  ```
- **Where:** `supervisor-functions.ts:analyzeUtteranceWithLocalLLM` (processor prompt + response parsing), `tutor-event-driven.ts` (pipeline — check triggers after processor runs, dispatch supervisor if non-empty).

### 3. Conversational Agent Role Clarity
- Three-agent architecture:
  - **Conversational agent** (GemmaAudioLLM): handles the voice conversation, speaks the target language, teaches naturally
  - **Processor** (local LLM): ingests each utterance, extracts lexemes/grammar/pronunciation, flags supervisor triggers
  - **Supervisor/Planner** (local LLM): manages goals, adjusts difficulty, responds to triggers, updates user settings (including language changes)
- The conversational agent should be the voice the user hears. The processor and supervisor run silently in the background.
