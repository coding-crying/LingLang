# Onboarding Flow Implementation Plan

**Goal:** First-time users (per language) go through an onboarding flow that captures their background, goals, and actual level — producing a high-confidence `source='onboarding'` anchor in `user_language_levels` that the inference engine respects.

**Architecture:**
- Two parallel paths: **UI form** (dashboard, no talking required) and **voice onboarding** (LiveKit session, tutor runs the flow). Both write to the same DB tables. User can do either or both.
- Onboarding state lives in a new `user_onboarding` table: one row per (user, language), tracks completion status and what was captured.
- The tutor checks onboarding status on session start. If incomplete → runs onboarding mode instead of normal tutor mode. UI path can be completed before or after the voice session.
- Level inference respects `source='onboarding'` with high confidence: inference can only move the level by ±1 CEFR step per 100 new vocab items from the anchor.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, LiveKit agents, React (dashboard), SGLang LLM

---

## Phase 1 — Schema & State Machine

### Task 1: Migration — `user_onboarding` table

**File:** `drizzle/0006_add_user_onboarding.sql`

```sql
CREATE TABLE user_onboarding (
  user_id         TEXT        NOT NULL REFERENCES users(id),
  language_code   TEXT        NOT NULL,
  -- completion flags
  ui_complete     BOOLEAN     NOT NULL DEFAULT FALSE,
  voice_complete  BOOLEAN     NOT NULL DEFAULT FALSE,
  -- captured data
  prior_study     TEXT,        -- 'none' | 'self_taught' | 'class' | 'immersion' | 'heritage'
  study_details   TEXT,        -- free text: "Duolingo 6 months", "Pimsleur level 2", etc.
  goals           TEXT[],      -- ['travel', 'work', 'heritage', 'media', 'academic', 'other']
  goal_details    TEXT,        -- free text: "moving to Lisbon in 6 months"
  self_rated_level TEXT,       -- user's own CEFR estimate: 'none' | 'a1' | 'a2' | 'b1' | 'b2' | 'c1' | 'c2'
  -- anchored level (written after voice probe or UI submission)
  anchored_level  TEXT,        -- CEFR level set by onboarding
  anchor_confidence REAL,      -- 0.0..1.0
  anchor_evidence TEXT,        -- one sentence: what the user said / did
  -- timestamps
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, language_code)
);
```

Apply: `docker exec -i linglang-db psql -U linglang -d linglang < drizzle/0006_add_user_onboarding.sql`

Verify: `docker exec linglang-db psql -U linglang -d linglang -c '\d user_onboarding'`

---

### Task 2: Drizzle schema — add `userOnboarding` table + relations

**File:** `src/db/schema.ts`

Add after `userPersona`:

```typescript
export const userOnboarding = pgTable('user_onboarding', {
  userId:           text('user_id').notNull().references(() => users.id),
  languageCode:     text('language_code').notNull(),
  uiComplete:       boolean('ui_complete').notNull().default(false),
  voiceComplete:    boolean('voice_complete').notNull().default(false),
  priorStudy:       text('prior_study'),
  studyDetails:     text('study_details'),
  goals:            text('goals').array(),
  goalDetails:      text('goal_details'),
  selfRatedLevel:   text('self_rated_level'),
  anchoredLevel:    text('anchored_level'),
  anchorConfidence: real('anchor_confidence'),
  anchorEvidence:   text('anchor_evidence'),
  startedAt:        timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt:      timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.languageCode] }),
}));

export const userOnboardingRelations = relations(userOnboarding, ({ one }) => ({
  user: one(users, { fields: [userOnboarding.userId], references: [users.id] }),
}));
```

Also add `onboarding: many(userOnboarding)` to `usersRelations`.

---

### Task 3: `lib/onboarding.ts` — state helpers

**File:** `src/lib/onboarding.ts` (new)

```typescript
import { db } from '../db/index.js';
import { userOnboarding, userLanguageLevels } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { Level } from './level-inference.js';

export interface OnboardingState {
  userId: string;
  languageCode: string;
  uiComplete: boolean;
  voiceComplete: boolean;
  isComplete: boolean;   // either path done
  anchoredLevel: Level | null;
  anchorConfidence: number;
  priorStudy: string | null;
  goals: string[];
}

/** Returns null if no onboarding row exists yet (never started). */
export async function getOnboardingState(
  userId: string,
  languageCode: string,
): Promise<OnboardingState | null> {
  const row = await db.query.userOnboarding.findFirst({
    where: and(
      eq(userOnboarding.userId, userId),
      eq(userOnboarding.languageCode, languageCode),
    ),
  });
  if (!row) return null;
  return {
    userId,
    languageCode,
    uiComplete: row.uiComplete,
    voiceComplete: row.voiceComplete,
    isComplete: row.uiComplete || row.voiceComplete,
    anchoredLevel: (row.anchoredLevel as Level) ?? null,
    anchorConfidence: row.anchorConfidence ?? 0,
    priorStudy: row.priorStudy,
    goals: row.goals ?? [],
  };
}

/** Upsert onboarding row (called by both UI and voice paths). */
export async function saveOnboardingData(
  userId: string,
  languageCode: string,
  data: Partial<typeof userOnboarding.$inferInsert>,
): Promise<void> {
  await db
    .insert(userOnboarding)
    .values({ userId, languageCode, ...data })
    .onConflictDoUpdate({
      target: [userOnboarding.userId, userOnboarding.languageCode],
      set: { ...data },
    });
}

/** Write the anchored level to user_language_levels with source='onboarding'. */
export async function commitOnboardingLevel(
  userId: string,
  languageCode: string,
  level: Level,
  confidence: number,
  evidence: string,
): Promise<void> {
  await db
    .insert(userLanguageLevels)
    .values({
      userId,
      languageCode,
      proficiencyLevel: level,
      confidence,
      source: 'onboarding',
      inferredAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userLanguageLevels.userId, userLanguageLevels.languageCode],
      set: {
        proficiencyLevel: level,
        confidence,
        source: 'onboarding',
        inferredAt: new Date(),
      },
    });

  await saveOnboardingData(userId, languageCode, {
    anchoredLevel: level,
    anchorConfidence: confidence,
    anchorEvidence: evidence,
    completedAt: new Date(),
  });
}
```

---

## Phase 2 — Level Inference Respects Onboarding Anchor

### Task 4: Lock inference to onboarding anchor

**File:** `src/lib/level-inference.ts`

In `readLevelSignals()`, after fetching `user_language_levels`, check if `source === 'onboarding'`. If so, return the anchored level directly with a flag — skip the full signal computation.

Add to `LevelSignals`:
```typescript
onboardingAnchor: Level | null;   // set if source='onboarding', null otherwise
onboardingConfidence: number;     // 0 if no anchor
```

In `signalsToScore()`: if `onboardingAnchor` is set, clamp the computed score so it can't move more than ±1 CEFR step from the anchor. The anchor decays: after 100 new vocab items, confidence drops by 0.1 per 10 items, eventually letting inference take over.

Concretely:
```typescript
// In signalsToScore():
if (s.onboardingAnchor && s.onboardingConfidence > 0.3) {
  const anchorScore = levelToScore(s.onboardingAnchor);
  const maxDrift = 50; // ~1 CEFR step in score units
  return Math.max(anchorScore - maxDrift, Math.min(anchorScore + maxDrift, rawScore));
}
```

Add helper `levelToScore(level: Level): number` — inverse of `scoreToLevel()`, returns the midpoint score for each bucket.

---

## Phase 3 — Voice Onboarding (LiveKit agent mode)

### Task 5: Onboarding prompt — `config/prompts/onboarding.ts`

**File:** `src/config/prompts/onboarding.ts` (new)

The onboarding prompt is a structured conversation in 3 acts:

**Act 1 — Background** (2-3 exchanges):
- "Have you studied [language] before? Tell me a bit about it."
- Follow-up: "How long? What did you use — classes, apps, immersion?"
- Parse: `priorStudy`, `studyDetails`

**Act 2 — Goals** (1-2 exchanges):
- "What's bringing you to [language]? Travel, work, family, just for fun?"
- Parse: `goals[]`, `goalDetails`

**Act 3 — Level probe** (2-4 exchanges, adaptive):
- If they said "none" → skip probe, set `pre_a1`
- If they said "some" → run 2-3 exchanges in the target language, assess
- If they said "a lot" → run the full assessor flow (reuse `buildAssessmentInstructions`)

Output contract — same as assessor, extended:
```json
{
  "priorStudy": "class",
  "studyDetails": "2 years of high school Spanish, 5 years ago",
  "goals": ["travel", "media"],
  "goalDetails": "planning a trip to Mexico",
  "level": "a2",
  "evidence": "Could form simple sentences but struggled with past tense",
  "confidence": 0.75
}
```

The LLM emits this JSON at the end. The agent parses it and calls `commitOnboardingLevel()`.

Key prompt rules:
- Warm, curious tone — NOT a test, NOT a form. "I'm just getting to know you."
- Never say "assessment" or "test" or "evaluation"
- Keep it under 5 minutes total
- If user says "skip" or "just start" → emit JSON with `confidence: 0.3`, level = `pre_a1`, and set `skipped: true`

```typescript
export interface OnboardingContext {
  targetLanguage: string;   // "Portuguese"
  targetCode: string;       // "pt"
  nativeLanguage: string;   // "English"
}

export function buildOnboardingInstructions(ctx: OnboardingContext): string {
  return `You are welcoming a new learner of ${ctx.targetLanguage}. Your job is to have a short, warm conversation to understand their background and goals — then figure out their level through natural dialogue.

This is NOT a test. You are a curious friend getting to know them. Keep it light, keep it short (under 5 minutes total).

FLOW:
1. Background: Ask if they've studied ${ctx.targetLanguage} before. If yes, ask how long and what they used (classes, apps, immersion, heritage). If no, note that and move on.
2. Goals: Ask what's bringing them to ${ctx.targetLanguage}. Travel? Work? Family? Media? Just curious?
3. Level probe (adapt based on what they said):
   - If they said "never studied" or "zero": skip the probe. Level = pre_a1.
   - If they said "a little" or "some basics": try 2-3 exchanges in ${ctx.targetLanguage}. Start simple. See what sticks.
   - If they said "intermediate" or more: have a real conversation in ${ctx.targetLanguage} for 3-4 exchanges. Probe vocabulary range and sentence construction.

RULES:
- Never say "test", "assessment", "evaluation", "quiz"
- If they say "skip" or "just start" or "let's go" → stop immediately and emit the JSON with confidence 0.3
- Be warm but efficient. Don't drag it out.
- Roast gently if they're clearly better than they claimed. ("You said 'a little' but that was pretty solid...")

When you have enough signal (or they skip), emit EXACTLY ONE JSON line, nothing after it:
{"priorStudy":"none|self_taught|class|immersion|heritage","studyDetails":"...","goals":["travel","work","heritage","media","academic","other"],"goalDetails":"...","level":"pre_a1|a1|a2|b1|b2|c1|c2","evidence":"...","confidence":0.0-1.0,"skipped":false}

Do NOT explain the JSON. Do NOT say goodbye. Just the JSON and stop.`;
}
```

---

### Task 6: Onboarding mode in `tutor-event-driven.ts`

**File:** `src/tutor-event-driven.ts`

**Where to hook in:** In `entry()`, after `refreshDbContext()`, before the greeting:

```typescript
// Check onboarding status
const onboardingState = await getOnboardingState(userId, langCode);
const needsOnboarding = !onboardingState?.isComplete;

if (needsOnboarding) {
  await runOnboardingSession(session, userId, langCode, ctx);
  return; // onboarding session ends; user reconnects for normal tutor
}
```

**`runOnboardingSession()`** — new function in `tutor-event-driven.ts`:

```typescript
async function runOnboardingSession(
  session: AgentSession,
  userId: string,
  langCode: string,
  ctx: TutorContext,
): Promise<void> {
  const langConfig = LANGUAGES[langCode];
  const instructions = buildOnboardingInstructions({
    targetLanguage: langConfig.name,
    targetCode: langCode,
    nativeLanguage: ctx.nativeLanguage,
  });

  // Mark onboarding started
  await saveOnboardingData(userId, langCode, { startedAt: new Date() });

  // Run the conversation — same as normal session but with onboarding prompt
  session.updateInstructions(instructions);

  // Listen for the JSON verdict in the LLM stream
  // The onboarding prompt ends with a JSON line — parse it on agent.reply
  session.on('agent.reply', async (reply: string) => {
    const jsonMatch = reply.match(/\{[^}]*"level"[^}]*\}/);
    if (!jsonMatch) return;
    try {
      const verdict = JSON.parse(jsonMatch[0]);
      await saveOnboardingData(userId, langCode, {
        priorStudy: verdict.priorStudy,
        studyDetails: verdict.studyDetails,
        goals: verdict.goals,
        goalDetails: verdict.goalDetails,
        selfRatedLevel: verdict.level,
        voiceComplete: true,
      });
      await commitOnboardingLevel(
        userId, langCode,
        verdict.level,
        verdict.confidence ?? 0.7,
        verdict.evidence ?? 'voice onboarding',
      );
      // Gracefully end the session — user will reconnect for normal tutor
      await session.say("Great, I've got what I need. Jump back in whenever you're ready — we'll pick up from here.");
    } catch (e) {
      console.error('[Onboarding] Failed to parse verdict JSON:', e);
    }
  });
}
```

**Important:** The JSON regex must be robust — the LLM may emit the JSON mid-stream. Use a buffer that accumulates the full reply before parsing.

---

## Phase 4 — UI Onboarding (Dashboard)

### Task 7: Dashboard API endpoints

**File:** `src/dashboard/server.ts`

Add 3 endpoints:

```
GET  /api/users/:userId/onboarding/:lang   → returns OnboardingState (or null)
POST /api/users/:userId/onboarding/:lang   → saves UI form data, calls commitOnboardingLevel
DELETE /api/users/:userId/onboarding/:lang → resets onboarding (admin/debug)
```

POST body:
```typescript
{
  priorStudy: 'none' | 'self_taught' | 'class' | 'immersion' | 'heritage';
  studyDetails?: string;
  goals: string[];
  goalDetails?: string;
  selfRatedLevel: 'none' | 'a1' | 'a2' | 'b1' | 'b2' | 'c1' | 'c2';
}
```

Level mapping from UI form:
- `none` → `pre_a1`, confidence 0.9 (user is certain they know nothing)
- `a1`–`c2` → that level, confidence 0.6 (self-report, not probed)

The voice path gets confidence 0.7–0.9 (LLM-assessed). UI self-report gets 0.6. Both beat the inference default of ~0.3.

---

### Task 8: Onboarding UI component

**File:** `src/dashboard/frontend/src/Onboarding.tsx` (new)

A clean, minimal form. Not a wizard — one screen, scroll to fill. Fields:

```
Have you studied [language] before?
○ Never  ○ A little (self-taught/apps)  ○ Classes  ○ Immersion  ○ Heritage speaker

[If not "Never"] Tell us more (optional):
[text input: "e.g. Duolingo for 3 months, Pimsleur level 1"]

What's your goal?
☐ Travel  ☐ Work  ☐ Heritage/family  ☐ Media (films, music)  ☐ Academic  ☐ Just curious

[optional] Anything specific?
[text input: "e.g. moving to Lisbon in 6 months"]

How would you rate yourself?
○ Complete beginner  ○ A1  ○ A2  ○ B1  ○ B2  ○ C1  ○ C2

[Submit] [Or, talk to the tutor instead →]
```

The "talk to the tutor instead" link opens the LiveKit room — the tutor will detect onboarding is incomplete and run the voice flow.

On submit: POST to `/api/users/:userId/onboarding/:lang`, then redirect to the main voice room.

**Styling:** Use existing design tokens from `css/design-tokens.css`. Match the existing dark theme. No new CSS variables.

---

### Task 9: Wire Onboarding into App.tsx / VoiceRoom.tsx

**File:** `src/dashboard/frontend/src/App.tsx` (or `VoiceRoom.tsx`)

On app load, after auth:
1. Fetch `GET /api/users/:userId/onboarding/:lang`
2. If `isComplete === false` → show `<Onboarding />` component instead of `<VoiceRoom />`
3. After onboarding submit → show `<VoiceRoom />`

The voice room itself doesn't need to change — the agent handles the voice onboarding path transparently.

---

## Phase 5 — Content Ingestion (Textbook Upload)

> **Note:** This phase is scoped separately. The onboarding flow (Phases 1-4) must ship first. Content ingestion builds on the same `user_onboarding` table and level anchor system.

### Task 10: PDF text extraction utility

**File:** `src/lib/ingest/extract-text.ts` (new)

Use `pdfplumber` (Python) via a child process, or `pdf-parse` (npm). The output is raw text per chapter/page.

Install: `pnpm add pdf-parse` (or `pip install pdfplumber` for the Python path — Python is already available).

```typescript
export async function extractPdfText(filePath: string): Promise<string[]> {
  // Returns array of page texts
}
```

For images (scanned textbooks): use SGLang's vision capability — send page image as base64, ask it to extract the text. The Gemma 4 12B QAT model handles images natively.

---

### Task 11: Vocab extraction from chapter text

**File:** `src/lib/ingest/extract-vocab.ts` (new)

Send chapter text to SGLang, ask it to extract:
- All vocabulary items (lemma, POS, translation, example sentence)
- Grammar patterns introduced
- CEFR level estimate for the chapter

Prompt:
```
You are a language curriculum analyst. Given this chapter text from a [language] textbook, extract:
1. All vocabulary items introduced (lemma, part of speech, English translation, one example sentence)
2. Grammar patterns (e.g. "present tense conjugation of -ar verbs")
3. Your estimate of the CEFR level this chapter targets

Output as JSON: { "vocab": [...], "grammar": [...], "level": "a1" }
```

---

### Task 12: Seed extracted vocab into `lexemes` + `user_vocabulary`

**File:** `src/lib/ingest/seed-chapter.ts` (new)

For each extracted vocab item:
1. Check if lexeme exists (`SELECT id FROM lexemes WHERE lemma = ? AND language = ?`)
2. If not → insert into `lexemes`
3. Upsert `user_vocabulary` with `state=1` (learning), `reps=0` — the user has *seen* it but hasn't been tested

Then run a short probe conversation (reuse the assessor flow, seeded with the chapter vocab) to move well-known words to `state=2`.

---

### Task 13: Dashboard upload UI

**File:** `src/dashboard/frontend/src/Ingest.tsx` (new)

```
Upload a textbook or study material
[Drop PDF here or click to browse]

Which chapters have you studied?
From chapter [1] to chapter [___]

[Process & add to my profile]
```

After upload:
1. POST `/api/ingest` with the file + chapter range
2. Background job extracts vocab, seeds DB
3. Dashboard shows progress: "Found 247 words in chapters 1-10. Starting placement probe..."
4. Placement probe runs as a short voice session (or can be skipped)

---

### Task 14: Dashboard ingest API endpoint

**File:** `src/dashboard/server.ts`

```
POST /api/ingest
  - multipart: file (PDF), userId, languageCode, fromChapter, toChapter
  - spawns background job
  - returns { jobId }

GET /api/ingest/:jobId
  - returns { status: 'pending'|'running'|'done'|'error', vocabFound, vocabSeeded, error? }
```

Background job uses Node `worker_threads` or a simple async queue. No external job runner needed at this scale.

---

## Verification Checklist

After each phase:

**Phase 1-2 (schema + inference):**
```bash
# Migration applied
docker exec linglang-db psql -U linglang -d linglang -c '\d user_onboarding'

# tsc clean
npx tsc --noEmit 2>&1 | grep '^src/' | grep -v 'node_modules'

# Inference respects anchor
npx tsx src/scripts/test-level-inference.ts
# will/ru should stay near A2 once onboarding anchor is set
```

**Phase 3 (voice onboarding):**
```bash
# Agent starts clean
timeout 8 npx tsx src/tutor-event-driven.ts dev 2>&1 | grep -E 'registered|error|Error'

# Connect to LiveKit room as new user — should hear onboarding greeting, not tutor greeting
# After JSON verdict — check DB:
docker exec linglang-db psql -U linglang -d linglang -c \
  "SELECT * FROM user_onboarding WHERE user_id = 'will';"
docker exec linglang-db psql -U linglang -d linglang -c \
  "SELECT * FROM user_language_levels WHERE user_id = 'will';"
```

**Phase 4 (UI):**
```bash
pnpm dashboard:build
curl -s http://localhost:8392/api/users/will/onboarding/ru  # should return state
# Open dashboard, verify onboarding form shows for new language
```

---

## Implementation Order

1. Tasks 1-3 (schema + helpers) — ~1 hour, no UI, no agent changes
2. Task 4 (inference anchor) — ~30 min, fixes the level problem immediately
3. Tasks 5-6 (voice onboarding) — ~2 hours, core feature
4. Tasks 7-9 (UI onboarding) — ~2 hours, parallel path
5. Tasks 10-14 (content ingestion) — separate sprint, ~1 day

**Start with Tasks 1-4.** That alone fixes the level inference problem and unblocks everything else.
