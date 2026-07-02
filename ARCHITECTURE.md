# LingLang Architecture

Rewritten 2026-07-02 from the actual codebase + running services. The
previous version of this file (last edited 2026-05-26, describing an
earlier stack: Gemma4-26B, ElevenLabs, Ollama) is archived — as best it
could be recovered — at `.md old/ARCHITECTURE.2026-05-07.md`. (Root `.md`
files were never actually tracked by git until this session — see
`PROJECT_STATE.md` for why — so this is reconstructed from a Hermes
session log's `write_file` call rather than git history; it's close but
not guaranteed byte-exact.) For day-to-day status, bugs, and what's in
flight, see `PROJECT_STATE.md` — this file is the slower-moving design
reference.

## Product lineup

| Product | Description | Location |
|---|---|---|
| **LingLang Server/Cloud** | The voice tutor — LiveKit agent + dashboard, this repo | `agents/` (this repo's git root) |
| **LingLang Edge** | Offline/on-device mobile tutor (Android) | `linglangedge/` — **separate git repo**, nested inside this checkout but not tracked by it |
| **Server package** | A separate self-host packaging effort (Dockerfile, models, services) | `server/` — plain directory, **not yet a git repo**, not tracked anywhere |

This doc covers the Server/Cloud voice tutor only.

## Runtime topology

```
                          ┌─────────────────────┐
  User (voice, browser) ──┤  LiveKit room        │
                          │  linglang-<userId>   │
                          └──────────┬───────────┘
                                     │
                       ┌─────────────▼─────────────┐
                       │  tutor-event-driven.ts     │  ← LiveKit agent worker
                       │  (agentName: linglang-tutor)│    process.env.LINGLANG_AGENT_NAME
                       └──┬──────────┬──────────┬───┘
                          │          │          │
              ┌───────────▼──┐ ┌─────▼─────┐ ┌──▼────────────┐
              │ Conversation │ │ Processor │ │ Supervisor /   │
              │ agent (voice)│ │ (per-turn)│ │ Planner (30s)  │
              └───────┬──────┘ └─────┬─────┘ └───────┬────────┘
                      │              │               │
                      └──────────────┴───────┬───────┘
                                              │  all three hit the same
                                       ┌──────▼──────┐  SGLang endpoint —
                                       │   SGLang    │  concurrency is
                                       │  :8094      │  intentional, not
                                       │ gemma4-12b- │  a contention bug
                                       │  it-qat     │  (--max-running-requests 3)
                                       └─────────────┘

              ┌────────────────┐     ┌──────────────┐
              │  OmniVoice TTS │     │  Postgres +  │
              │     :8882      │     │  pgvector    │
              └────────────────┘     │ linglang-db  │
                                      └──────────────┘

  Dashboard (Express, :8392, nginx → linglang.senilelines.com)
    serves React SPA (Vite build in src/dashboard/public/app/)
    + JSON API used by both the dashboard and VoiceRoom.tsx
```

Separately, a **Wyoming bridge** (`wyoming_openai`, `:10300`) exposes local
Qwen ASR (`:8001`, Moonshine) and OmniVoice TTS (`:8882`) to non-LiveKit
clients (e.g. Home Assistant). It is not in the conversation agent's path —
the conversation LLM does its own audio understanding natively.

## The three-agent loop

This is the core design and the part most likely to matter when debugging
tutoring behavior. All three share the SGLang endpoint but have distinct
responsibilities:

1. **Conversation agent** — the voice the user actually talks to. Fresh
   instructions are built every turn by `buildDynamicInstructions()`
   (`tutor-event-driven.ts`), which layers:
   - functional core: language pair, CEFR level, frontier vocab, target-
     language ratio (`ratioForLevel()`, `src/config/prompts/base.ts`), error
     treatment — deliberately **not** writable by anyone, this is the part
     that has to stay correct for teaching to work
   - adaptive shell: persona (`user_persona` table via `lib/persona.ts`),
     user-style EMA (`user_style` table via `lib/user-style.ts` — mirrors
     the user's own tone: humor, pacing, register, profanity, etc.),
     `supervisorNudge`, `greetingContext`
   - during onboarding: swapped out entirely for
     `buildOnboardingInstructions()` (see Onboarding below)
2. **Processor** — runs on every user turn
   (`analyzeUtteranceWithLocalLLM`, `src/tools/supervisor-functions.ts`).
   Extracts lexemes (lemma/POS/performance) and grammar hints, grades FSRS
   reviews, and emits `supervisorTriggers`: a typed list —
   `language_change | difficulty_adjustment | goal_change |
   session_feedback | persona_update | onboarding_signal` — each with a
   `value` and `reason`. Triggers feed `pendingSignals` and can fire the
   supervisor immediately instead of waiting for the timer.
3. **Supervisor / planner** — runs on a 30s timer, gated on
   `pendingSignals.length > 0` (guard at `tutor-event-driven.ts:1150`).
   Reads the DB (goals, vocab state, notes, onboarding state) and the
   running session summary, and can:
   - update `active_goals` (remediation/vocab/grammar goal-seeking cycle)
   - emit `NUDGE:` / `SUMMARY:` / `NOTE[]:` / `PERSONA:` directives that get
     woven into the next `buildDynamicInstructions()` call
   - handle a `language_change` trigger by updating `users.targetLanguage`
     (and `user_language_levels`) and refreshing instructions mid-session
   - commit an onboarding anchor via `commitOnboardingLevel()`

Design rule (from the project owner, worth preserving): **no separate
"modes" bolted onto the main loop.** New capabilities (onboarding is the
example so far) are implemented as changes to what
`buildDynamicInstructions()` returns and what the processor/supervisor look
for — not a parallel pipeline or a different agent.

## Level inference & the onboarding anchor

Two independent signals for "what level is this user":

- **Inferred** (`src/lib/level-inference.ts`): derived from
  `review_logs` (avg grade + pronunciation score, weight 0.8 — deliberately
  low, this proxy is noisy) and session/vocab exposure. This is *implicit*
  SRS-style inference, the project's original core idea.
- **Anchored** (`user_onboarding.anchoredLevel`, `src/lib/onboarding.ts`):
  a self-reported level captured once, either via a short voice intake
  (`buildOnboardingInstructions()`, ends in a fenced
  ` ```onboarding_verdict ` JSON block parsed at the `ConversationItemAdded`
  LiveKit event) or a UI form (`OnboardingGate.tsx`). Both write the same
  `user_onboarding` row.

The anchor exists because pure exposure-based inference conflates *exposure*
with *acquisition* — a user with zero real knowledge of a language can
accumulate enough tutoring-session vocab rows to look intermediate. The
anchor holds level within ±1 CEFR step until the user has logged 100 real
vocab items (`user_vocabulary` rows), then decays out; a manual override
(`user_language_levels.source = 'manual'`) holds for 20.

Per-language, not global: level, persona, and onboarding state are all keyed
`(userId, languageCode)` (or `languageCode = 'all'` for persona overrides
that apply everywhere).

## Data model (Postgres + pgvector, Drizzle ORM — `agents/src/db/schema.ts`)

| Table | Purpose |
|---|---|
| `users` | id, target/native language, legacy global `proficiencyLevel` (fallback only), `username`/`passwordHash` (scrypt) |
| `user_language_levels` | per-`(user, language)` CEFR level, confidence, `source` (`inferred`/`onboarding`/`manual`) |
| `user_style` | per-`(user, styleKey)` EMA value + confidence — humor, pacing, register, profanity, preamble, bsCallouts |
| `user_persona` | per-`(user, language)` writable persona shell: override text, tone, correction style, teaching mode, extra instructions; `source` tracks who wrote it |
| `user_onboarding` | per-`(user, language)` onboarding state — see above |
| `lexemes` | vocabulary, BGE-M3 1024d embeddings, HNSW cosine index, `frequencyRank`, cross-language `nativeLemma` link |
| `grammar_rules` | grammar rules with embeddings — **currently empty (0 rows)**, not populated by anything; level-inference's grammar signal had to be reworked around this |
| `units` | curriculum structure, per-language ordering |
| `user_vocabulary` | FSRS state per `(user, lexeme)`: state/due/stability/difficulty/reps/lapses |
| `review_logs` | one row per FSRS review event — grade, state snapshot, pronunciation score, duration; feeds both the FSRS optimizer and level-inference |
| `active_goals` | goal-seeking cycle: `vocab`/`grammar`/`remediation` goals with priority |
| `session_summaries` | cross-session memory: narrative summary + next-session hint per session |
| `user_notes` | durable one-line learner insights (`preference`/`level`/`frustration`/`goal`/`engagement`), can be superseded |

## Languages

Configured in `src/config/languages.ts`: **en, ru, es, fr, pt, ar** — each
with STT language name, TTS voice IDs (per-provider), and a base
`targetLanguageRatio`. Adding a language is just adding an entry here; no
hardcoded persona per language (persona is DB-driven, see above).

## Auth & dashboard

- Per-user scrypt auth (`src/lib/user-auth.ts`), replacing the old single
  shared `DASHBOARD_PASSWORD` env var (2026-06-25). **Known weakness**: all
  users currently share one static salt
  (`DASHBOARD_PASSWORD_SALT` env, hardcoded fallback) instead of a per-user
  random salt — queued for the dashboard/frontend work, see `BACKLOG.md`.
- Session cookie `ll_session`, HttpOnly + SameSite=Strict, 24h expiry, login
  rate-limited 10/15min/IP.
- Dashboard frontend: React SPA in `src/dashboard/frontend/` (Vite), built
  output committed to `src/dashboard/public/app/`. Express
  (`src/dashboard/server.ts`) serves the built `index.html` at `/dashboard`
  (falls back to a legacy `dashboard.html` if the build is missing — that
  fallback file doesn't currently exist on disk, so a missing/broken build
  would 500, not gracefully degrade). Root `/` always redirects to
  `/login` or `/dashboard`; there's deliberately no public marketing
  landing page served from here anymore (comment in `server.ts:781`).
- `VoiceRoom.tsx` is the actual user-facing tutoring UI (not the admin
  dashboard) — it gates on onboarding completion (`OnboardingGate.tsx`)
  before requesting a LiveKit token.
- LiveKit room per user: `linglang-<userId>` (server-derived, not
  client-controlled — `src/dashboard/server.ts:735`). Agent dispatch uses
  `LINGLANG_AGENT_NAME` (default `linglang-tutor`).

## Known infra gotchas (still true as of 2026-07-02)

- Postgres Docker volume `linglang_linglang-pgdata` has password
  `linglang` — not the docker-compose default, easy to typo when debugging
  auth failures against a fresh volume.
- `db/index.ts` must call `dotenv.config()` at its own top — ES module
  hoisting means it can evaluate before the dashboard's top-level dotenv
  call, leaving `DATABASE_URL` unset and producing a misleading "password
  auth failed" 500 while a direct `psql` connection works fine.
- GPU budget: OmniVoice (~5GB) + SGLang (~17.2GB) = ~23.1GB/24GB (94%) —
  there is very little headroom for anything else on this box while both
  are running.
