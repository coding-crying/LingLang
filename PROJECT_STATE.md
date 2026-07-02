# LingLang — Project State (as of 2026-07-02, reconstructed from Hermes session logs)

This file is the entry point for picking the project back up. It reflects
the state at the end of the last active work session (Hermes profile
`linglang`, session `20260701_145614_d7bed0`, ended 2026-07-01 after the
user reported new regressions).

**Update 2026-07-02**: `ARCHITECTURE.md`, `BACKLOG.md`, `MEMORY.md` were
rewritten to match the current system (they'd been stale since 2025-05 /
2026-06-24, describing Gemma4-26B/ElevenLabs/Ollama/VoxCPM2).
`IMPLEMENTATION_STATUS.md` is now a stub pointing here. Old versions and a
pile of dead-subsystem docs (CLOUD_SERVICES*, CHATTERBOX*, XTTS*,
FATTERBOX, DUOLINGO*, LOCAL_STT_GUIDE) moved to `.md old/`. Also fixed: a
blanket `*.md` rule in `.gitignore` had silently kept every one of these
root docs — including this file — **out of git history entirely**; that's
fixed now, and the 251-file uncommitted code diff described below has been
committed as a WIP checkpoint. See `MEMORY.md`'s "Documentation hygiene"
section for detail. The known-bugs and git-state sections below describe
the moment just before this cleanup pass, not the current moment.

## What LingLang is

Voice-native AI language tutor. No flashcards — mastery is inferred from
conversation (response speed, hesitation, grammar/pronunciation accuracy) via
FSRS. Runs as a LiveKit voice agent; dashboard at
`linglang.senilelines.com` (or `localhost:8392`) is the web frontend/admin.

## Current stack (verified against running processes + code, 2026-07-02)

- **Conversational LLM**: `gemma4-12b-it-qat` (Gemma 3 4B... actually 12B QAT,
  int4) served via **SGLang** on `:8094`. Handles audio **natively**
  (`audio_url` + `audio_token_id=258881`) — no separate STT model for the
  conversation path. Chat template:
  `/home/will/.hermes/templates/gemma4-12b-no-think.jinja`. Launch command
  uses `--enable-multimodal --max-running-requests 3` so processor, planner,
  and conversation LLM calls can run concurrently against the same endpoint
  by design (not a contention bug).
- **TTS**: OmniVoice, FastAPI server on `:8882` (moved off VoxCPM2/port 8881,
  which the old MEMORY.md still references).
- **DB**: Postgres in Docker (`linglang-db`) + pgvector, FSRS v5 schema.
  Volume `linglang_linglang-pgdata`, password `linglang` (not the
  docker-compose default — a recurring gotcha).
- **ASR fallback path**: `wyoming_openai` bridges Home Assistant / other
  clients to local Qwen ASR (`moonshine-medium-streaming` on `:8001`) and
  OmniVoice TTS — separate from the native-audio conversation path.
  `stt-wyoming` crash-looping from GPU OOM is a known, de-prioritized issue.
- Currently running on this box: SGLang (`:8094`) and OmniVoice (`:8882`) are
  up. **The tutor agent process itself (`tutor-event-driven.ts`) is not
  currently running** — it was stopped/restarted repeatedly while chasing
  bugs at the end of the last session and its final state wasn't confirmed
  healthy.

## Agentic architecture (this is the part IMPLEMENTATION_STATUS.md doesn't cover at all)

Three roles sharing the one SGLang endpoint:

1. **Conversation agent** — the voice the user hears. Gets fresh instructions
   every turn from `buildDynamicInstructions()`, which layers: functional
   core prompt (language pair, CEFR level, frontier vocab ratio, error
   treatment) + adaptive persona/tone (from DB, EMA-updated) +
   `supervisorNudge` + `greetingContext`. No hardcoded per-language
   personality — flavor comes from a user-specific EMA (`user-style.ts`),
   not a fixed character.
2. **Processor** — runs on every user turn. Analyzes the utterance, updates
   FSRS/SRS state, extracts lexemes/grammar/pronunciation signals, and emits
   `supervisorTriggers` (structured JSON: `language_change`,
   `difficulty_adjustment`, `goal_change`, `onboarding_signal`, etc.) that
   feed straight into `pendingSignals` and can trigger an immediate
   supervisor run rather than waiting for the timer.
3. **Supervisor / planner** — runs on a 30s timer when `pendingSignals.length
   > 0` (guard confirmed correct at `tutor-event-driven.ts:1150`). Reads DB +
   running summary, can read/write the DB, and emits `NUDGE:` / `SUMMARY:` /
   `NOTE[]:` / `PERSONA:` directives that get injected into the next
   `buildDynamicInstructions()` call. "Supervisor thinks always" — it's the
   layer that reasons about goals, level, and persona; the conversation
   agent just executes flow.

Design rule from the user: **no separate "modes" bolted onto the loop.**
Onboarding, for example, is implemented as a session-start check that swaps
which prompt `buildDynamicInstructions()` returns, not a parallel pipeline.

## Recently shipped (this session, 2026-07-01)

- **Persona system**: `user_persona` table + `src/lib/persona.ts`
  (`readPersona`/`writePersona`), dashboard endpoints
  `GET/PATCH /api/users/:userId/persona`. Removed the old hardcoded
  `LanguageConfig.persona` field entirely.
- **Level inference rewrite** (`src/lib/level-inference.ts`): the old
  `grammar_rules`-based signal was dead (table has 0 rows) — replaced with a
  `review_logs → words → lexemes` proxy (avg grade + pronunciation score),
  weight dropped 4.0 → 0.8 since the proxy is noisier. Session-language
  filter no longer relies on `session_summaries.summary` text matching.
- **Onboarding + anchoring system** (the big feature): SRS *exposure* was
  being conflated with *acquisition* (a user with zero Portuguese knowledge
  was inferred at B2 from tutoring-session vocab). Fix: a hard
  self-reported anchor that inference can only drift from slowly.
  - New table `user_onboarding` (background, goals, self-rated level,
    anchored level, confidence, evidence, source).
  - `src/lib/onboarding.ts`: `getOnboardingState`, `saveOnboardingData`,
    `commitOnboardingLevel`, `buildOnboardingContext`.
  - Anchor holds for **100 vocab items** (was 20, too soon), then decays out;
    manual override holds for 20. Level can't drift >±1 CEFR step from
    anchor until then.
  - Voice path: warm 5–8 turn intake (background → goals → level probe),
    prompt in `buildOnboardingInstructions()`, ends in a fenced
    ` ```onboarding_verdict ` JSON block the session handler parses at the
    `ConversationItemAdded` event (`tutor-event-driven.ts:1370`).
  - UI path: `OnboardingGate.tsx` in the LiveKit `VoiceRoom` frontend (not
    the admin dashboard — dashboard is `will`-only). New `/api/me` endpoint
    exposes `targetLanguage`/`nativeLanguage` so the frontend can decide
    whether to show the gate. Both paths write the same table.
  - Design doc: `docs/plans/2026-07-01-onboarding.md` (full spec, content
    ingestion section not yet implemented — PDF upload → SGLang vocab/grammar
    extraction → seed `lexemes`/`user_vocabulary` → placement probe).

## Known bugs — status at end of last session

1. **`<|channel>thought\n<channel|>` markers leaking into TTS/history.** The
   `gemma4-12b-no-think.jinja` template does *not* emit these when
   `enable_thinking=false` — confirmed by rendering the template directly.
   The **model itself** generates them as raw output tokens regardless of
   the `chat_template_kwargs` flag (`reasoning_tokens: 0` proves it's not
   real reasoning, just a QAT fine-tune artifact — ~50–100ms TTFT cost,
   3 tokens, unavoidable without retraining/swapping the model). Fix is a
   regex strip client-side, **present in code**:
   `tutor-event-driven.ts:1542` —
   `rawText.replace(/<\|channel>thought\n<channel\|>/g, '').trim()`.
   User reported markers *still* coming through after this was deployed —
   likely the running agent process hadn't picked up the change (agent
   wasn't running at all by the very end). **Needs re-verification on next
   session**, ideally with the agent actually restarted and a live test.
2. **`ratioForLevel` bug** (`src/config/prompts/base.ts:~69`): was
   `Math.max(fromLevel, baseRatio)`, so a language's fixed
   `targetLanguageRatio` (e.g. 0.75 for Portuguese) always won over the
   level-specific ratio — a `pre_a1` beginner got 75% target-language
   immersion instead of ~15%. Fixed to gate correctly (level ratio wins when
   lower). **Present in current code** (confirmed by reading `base.ts`), not
   verified live post-fix.
3. **Dashboard login / UI regression.** User reported (last message of the
   session): *"login is gone... UI seems greatly broken, tiles gone."* Root
   cause context: the dashboard frontend is mid-migration — old static files
   (`src/dashboard/public/index.html`, `css/design-tokens.css`,
   `css/landing.css`, `js/landing.js`) are **deleted** in the working tree,
   and a new frontend lives in **untracked** `src/dashboard/public/app/` and
   `src/dashboard/frontend/`. `public/login.html` exists on disk but is
   untracked. This looks like an in-progress SPA migration that was
   interrupted, not a clean regression — **needs a deliberate look at
   `src/dashboard/server.ts` routing + what `public/app/` actually contains
   before assuming anything is "lost."**
4. Model provider was flapping mid-session (auto-switched between
   claude-sonnet-4-6 → ds4f-tr → deepseek-v4-flash → z-ai/glm-5.2 → back to
   deepseek-v4-flash via tokenrouter) — worth checking whether that
   contributed to sloppy/incomplete fixes near the end. The final two user
   messages ("i am getting fed up... be more careful") suggest the last
   agent (deepseek-v4-flash) was making changes without enough verification.

## Git state — resolved 2026-07-02

- Repo root is `/home/will/Desktop/LingLang` (a fork of the
  `livekit-agents-js` monorepo with LingLang app code layered in), branch
  `feat/eval-harness-prompt-overhaul`.
- **Was**: last commit 2026-06-10, 251 uncommitted files (three weeks of
  work — the entire persona system, onboarding system, level inference
  rewrite, dashboard changes, and a large deletion of vendored LiveKit SDK
  internals) sitting with no safety net.
- **Now**: committed as a single WIP checkpoint (`aab3bfc`, 241 files —
  excludes `linglangedge/` and `server/`, see below). Also added
  `.gitignore` entries for `agents/eval-*.json`, `agents/dist-*-backup.tar.gz`,
  `agents/data/` (contains the waitlist file — PII, shouldn't be in git),
  and `.playwright-mcp/`.
- **Still loose**: `linglangedge/` is its own nested git repo (LingLang
  Edge, the Android app) and was left alone. `server/` (self-host packaging)
  is a plain directory, not a git repo at all — see `BACKLOG.md` #9 for the
  decision that needs making there. Neither is tracked by this repo.
- The commit is a checkpoint, not a clean history — it bundles unrelated
  changes together. Fine for now; don't treat it as a model for future
  commits once things stabilize.

## User working preferences (from Hermes memory, still current)

- Chain fixes end-to-end: batch several `.ts` edits, restart the agent
  **once**, then test — don't restart after every single-file edit.
- If a fix doesn't land on the first try: **stop and diagnose**, don't
  guess-and-check. "Find the issue before making a fix."
- **Scope discipline**: don't tune scoring weights / decay curves /
  thresholds / signal-blending math unprompted. Fix the asked bug, surface
  observations, ask before changing math.
- Wants evidence over vibes-based claims.
- Tutor persona: witty, sharp, willing to roast the user — no fixed
  character per language, personality comes from the per-user EMA.
- Never force voice-only flows — always provide a UI form alternative;
  both paths must write to the same DB tables.
- Wants (not yet built): Duolingo-style progress UI, textbook PDF content
  ingestion feeding the onboarding/level anchor.
- User's own language levels for testing: English = native, Russian = A2,
  Portuguese = zero knowledge. (DB currently has `will.target_language =
  pt` from the last onboarding test session.)

## Suggested next steps

1. `git status` / diff review and get a WIP commit in before anything else.
2. Bring the tutor agent back up, confirm SGLang (`:8094`) + OmniVoice
   (`:8882`) + Postgres are healthy, and manually retest: channel-marker
   stripping, Portuguese ratio for a `pre_a1` user, and the dashboard
   login/UI.
3. Once stable, resume `docs/plans/2026-07-01-onboarding.md` — content
   ingestion (PDF upload → SGLang extraction → placement probe) is the one
   part of that plan not yet implemented.
4. Consider archiving/deleting the stale root docs (`IMPLEMENTATION_STATUS.md`,
   `ARCHITECTURE.md`, `MEMORY.md`, `CLOUD_SERVICES*.md`,
   `CHATTERBOX_LIVEKIT_*.md`, `FATTERBOX_GUIDE.md`, `LOCAL_STT_GUIDE.md`,
   `DUOLINGO_*.md`) or clearly marking them historical — they actively
   mislead about the current stack (ElevenLabs/Ollama/VoxCPM2 don't reflect
   reality anymore).

## Sources

Reconstructed from `/home/will/.hermes/profiles/linglang/state.db`
(sessions table, especially `20260701_145614_d7bed0`, `#7`
`20260701_042027_06c8e3`), `/home/will/.hermes/profiles/linglang/memories/MEMORY.md`
and `USER.md` (denser and more current than the profile's top-level
`MEMORY.md`/`SOUL.md`, which are themselves stale), plus direct inspection of
the current codebase and running processes on 2026-07-02.
