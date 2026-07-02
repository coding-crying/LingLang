# Adaptive-Loop Redesign

**Date:** 2026-07-02
**Status:** Drafted from design discussion; awaiting user review
**Scope:** The three-agent adaptive loop — frontier mechanic, session phase,
style/persona arbitration, planner prompt, signal plumbing, prompt layout,
processor output reliability, onboarding verdict path — plus a new Pimsleur
curriculum spine. Dashboard/frontend and the auth salt fix are explicitly
out of scope (they belong to the frontend pass).

## Problem

A design critique (2026-07-02) found a consistent failure pattern: signals
are *computed* correctly but *delivered* stale, mislabeled, or not at all.
Root cause: `tutor-event-driven.ts` grew six ad-hoc in-memory copies of DB
state (`wordsDue`/`wordsNew` consts, `currentStyleCache`, `cachedPersona`,
`cachedDbContext`, `supervisorNudge`, `runningSummary`), each with its own
refresh discipline — some with none. Specific defects:

1. Frontier ratio frozen at session start (`wordsDue`/`wordsNew` parsed once
   from `initialContext`, never refreshed).
2. `turnCount > 20 → wrapup` locks long sessions into goodbye mode forever.
3. `roastTolerance` wired to `bsCallouts` (epistemic pushback ≠ humor
   tolerance).
4. `register: 'profane'` unreachable; `profanity`/`preamble` style keys
   captured in interface docs but absent from the processor prompt.
5. Pronunciation captured by the processor, never surfaced to the
   conversation agent.
6. Nudges never expire; planner asked "did the agent follow this?" with no
   adherence data.
7. System prompt rebuilt with interleaved volatile content every turn —
   defeats SGLang prefix caching on a GPU with ~1GB headroom.
8. Planner's "balance learning and enjoyment equally" mandate has no
   enjoyment inputs — nudges structurally skew toward review scheduling.
9. Processor JSON parsed via ~55 lines of regex repair + a retry that
   re-sends an identical prompt; every parse failure silently drops FSRS
   grades.
10. Onboarding has two competing writers (inline JSON verdict from the
    agent + `onboarding_signal` triggers from the processor); the inline
    JSON block is one strip-regex away from being read aloud by TTS.

## Principle

**The DB is the only truth. Prompts are views.** Anything derivable from
the DB (frontier budget, style, persona, due/new words) is computed at
prompt-build time through one read path with one staleness rule. No second
state store — the fix is *deleting* caches, not adding an abstraction.

Legitimately session-local state (not in the DB, minimal by design):
turn count, session phase, the active nudge (+ issue turn), pending
signals, running summary.

## Design

### 1. One read path: `readLearnerView(userId, lang)`

A single query function (new module, e.g. `src/lib/learner-view.ts`)
returns everything prompt builders need in one typed result:

- due words + new-word candidates (live, not session-start)
- frontier inputs: `dueBacklog`, `recentSuccess` (see §2)
- resolved style (see §4)
- persona row
- latest pronunciation notes from the most recent processor run (§6)
- curriculum spine position (§9)

One short TTL (~10 s) inside this function only, purely to bound query
cost against per-turn rebuild frequency. All six ad-hoc caches in
`tutor-event-driven.ts` are deleted; `buildDynamicInstructions()` and
`updatePlanNow()` both read through this function.

### 2. Frontier mechanic → success-gated introduction budget

Replace the frozen list-length ratio with a pure function of `review_logs`
and `user_vocabulary`:

- `dueBacklog` = count of currently-due `user_vocabulary` rows
- `recentSuccess` = fraction of grades ≥ Good over the last 20
  `review_logs` for this user+language (fewer than 5 logs → treat as
  `balance`)

Directive, three states:

| State | Condition | Prompt directive |
|---|---|---|
| `consolidate` | `recentSuccess < 0.6` OR `dueBacklog > 15` | Work only with known/review words. Introduce nothing new. |
| `balance` | otherwise | Introduce up to N new words, each scaffolded by known words in the same sentence. |
| `expand` | `recentSuccess ≥ 0.8` AND `dueBacklog < 5` | Lead with new words — they've earned it. |

N (balance budget) = `min(3, max(1, 15 − dueBacklog))`-style headroom
formula — small, derived, no user knob. Thresholds (0.6 / 0.8 / 15 / 5)
live as named constants in one place so tuning is a one-line change.

Because this is recomputed on every prompt build from live DB state,
clearing the due queue mid-session changes tutor behavior within a turn.

**Topic agency rule:** the learner picks the topic; the curriculum picks
the *words*. The frontier directive governs which vocabulary the tutor
reaches for, never what the conversation is about. If the user brings a
topic, the tutor follows it and weaves due/new words in opportunistically;
only when the user is passive/quiet may the tutor propose a scenario
(which may be curriculum-flavored). This is a standing rule in the
conversation prompt core (§7).

### 3. Session phase → signal-driven

- `opening`: turn 0. `warmup`: turns 1–2. `flow`: everything after.
- `wrapup` only on evidence:
  - processor `session_feedback` trigger gains `value: "wants_to_end"`
    (user says goodbye / gotta go / wraps up) → phase set to `wrapup`
  - LiveKit disconnect countdown / participant-leaving event
- The `turnCount > 20` rule is deleted. Long sessions stay in `flow`.

### 4. Style arbitration → one resolver, persona is the ceiling

New `resolveStyle(personaRow, styleEma)` in `src/lib/persona.ts` — the
single place tone/register/roast are decided:

- Persona `tone` sets the **maximum** roast level; the `humor` EMA
  modulates within that ceiling. `computeRoastLine` takes the resolved
  value (its currently-ignored `basePersona` param goes away).
- `bsCallouts` → renamed `pushback`, rewired to an epistemic prompt line:
  "they check your claims — admit uncertainty rather than bluff." It no
  longer influences roast.
- Processor `styleSignals` keys aligned exactly to what is consumed:
  `humor`, `pacing`, `register` (enum now includes `profane` — the dead
  branch becomes reachable), `pushback`. `profanity` and `preamble` are
  removed from the interface (captured-never-consumed).

### 5. Planner prompt — teeth and lifecycle

- **Engagement block** added to `buildPlannerPrompt`: turn-length trend
  (growing/shrinking over last ~6 turns), pacing, error-density trend.
  All already computed for the conversation prompt — now shared.
- Mandate rewritten from "care about enjoyment equally" (unactionable) to:
  "If turns are shrinking or errors climbing, change the angle before the
  material."
- **Nudge lifecycle:** prompt shows "Previous nudge (issued N turns ago):
  …" (replaces the rhetorical "did the agent follow this?"). The session
  expires a nudge after 8 turns so planner failures can't leave a stale
  angle pinned.
- Cadence unchanged: 30 s tick gated on `pendingSignals`, immediate
  dispatch on triggers. That part of the architecture is sound.
- Deletions: `buildPlannerMessages`, `AudioTurn` (dead since the
  2026-06-25 text-only decision), stale "Step 3.5 Flash via OpenRouter"
  comment.

### 6. Pronunciation reaches the mouth

`PromptContext` gains `pronunciationNote?: string` — the most recent
non-empty `pronunciationNotes` from the processor (with per-lexeme stress
flags folded in when present). `buildInstructions` renders it as one line
("Pronunciation to model, don't lecture: …"). If we won't surface it, we
stop capturing it — but surfacing costs one line, so surface it.

### 7. Conversation prompt → stable core + volatile tail

Same content, reordered for SGLang prefix caching:

- **Core** (byte-stable across turns; changes only on persona patch or
  level change): persona block, learner identity line, register/epistemic
  lines, standing rules (tools note, "correct the pattern not the word",
  topic agency: "follow the learner's topic; the word lists tell you which
  vocabulary to reach for, not what to talk about").
- **Tail** (rebuilt per turn): frontier directive + word lists, error
  treatment, nudge ("Current angle"), phase/length line.

`buildInstructions` keeps its signature but composes core-then-tail with
the guarantee that the core substring is byte-identical between calls
unless its inputs changed. Latency win falls out of layout; no infra work.

### 8. Processor → schema-constrained decoding

- SGLang `response_format`/JSON-schema constrained output derived from
  `UtteranceAnalysis`.
- Deletions: `cleanAndParseJSON` (all regex repair), the retry loop that
  re-sends an identical prompt, `buildSimplePrompt`, `isSmallModel`
  branch, `ANALYSIS_PROMPT_FULL` alias.
- Every parse failure today silently drops FSRS grades; this makes the
  grading pipeline parse-deterministic.
- `NUM` removed from `FUNCTION_WORD_POS` — numerals are core learnable
  vocabulary at pre-A1/A1 and are currently discarded.

### 9. Curriculum spines — user-set, Pimsleur-seeded default

A curriculum is an ordered word/phrase introduction sequence the frontier
draws from. It controls *word selection only* — never conversation topic
(§2 topic agency rule). Users choose their curriculum; the default one is
seeded from Pimsleur structure.

**Data model:**

- `curricula`: id, language, `sourceType`
  (`default_pimsleur | textbook | youtube | movie`), title,
  `ownerUserId` (null = shared/default curriculum).
- `units`: gains `curriculumId`; one row per lesson/chapter/segment with a
  `sequence` number. (Table exists and is empty.)
- `lexemes`: gains `unitId`-scoped `introOrder` and optional
  `drillPattern` tag (`anticipation | backward_buildup | recall_prompt`).
- `user_curriculum`: userId, curriculumId, `position` (unit sequence
  reached), `isActive`. "I'm up to chapter 8 and want to keep going" is
  just `position = 8` at enrollment time.

**Ingestion — one pipeline, pluggable extractors (offline scripts now;
upload UI belongs to the frontend pass):**

1. Extractor produces raw text segments per unit:
   - Pimsleur transcript files → lessons (Will has the files)
   - PDF textbook → chapters (absorbs `BACKLOG.md` #6)
   - YouTube video → caption track, chunked
   - Movie → OpenSubtitles transcript, chunked by scene/time
2. Common structuring step: local SGLang extracts introduced/salient
   vocabulary per unit with order and (where the source shows it) drill
   patterns → writes `units` + `lexemes`.
3. For media sources (youtube/movie) the goal is "understand this
   content": vocabulary is ordered by frequency-in-source × general
   frequency, and unit `sequence` follows the content's own timeline so
   position = "how far into the movie/series you can follow."

**Legal boundary (all sources):** store only lexeme/phrase-level structure
— introduction order, drill mechanics, frequency, unit boundaries. Never
store or replay source sentences, dialog, or running text. The tutor
generates its own sentences around the spine.

**Runtime touchpoints (two, both small):**

1. New-word selection: when the frontier directive is `expand` or
   `balance`, candidates come in spine order from the user's *active*
   curriculum at their position. No active curriculum, spine exhausted, or
   learner past ~A2 on the default spine → fall back to current
   frequency/semantic selection. Zero behavior change where there's no
   data.
2. Prompt moves: `expand`/`balance` directives gain Pimsleur mechanics in
   the tutor's own words — backward buildup for new multi-syllable
   phrases, anticipation prompts ("how would you say…?") for recent
   introductions.

**Growth loop (deferred to frontend pass):** curriculum picker, upload UI,
and "Lesson N of M" / "you can now follow 60% of this movie" progress on
the dashboard, powered by `user_curriculum.position` and coverage queries.

### 10. Onboarding verdict → tool call

The onboarding agent gets a `submit_onboarding_verdict` tool (same JSON
shape as today's inline block). Structured by construction; no TTS leak
surface; the inline ```` ```onboarding_verdict ```` parsing is deleted.
The processor's `onboarding_signal` trigger remains as supplementary
field-filling only — the tool call is the sole writer of the level anchor.

## Out of scope / explicitly deferred

- Dashboard/auth work incl. per-user salt (frontend pass, user decision)
- FSRS grade provenance weighting (spontaneous vs scaffolded production)
  — noted as a future refinement; the `performance` labels already carry
  the needed distinction
- Planner/processor merge into one background agent — considered and
  rejected: keeps the cheap-fast / slow-deliberate separation
- Pimsleur lesson *mode* as a separate experience — rejected in favor of
  the invisible spine

## Net code effect

Removals exceed additions: six ad-hoc caches, the JSON repair kit, the
dead planner audio path, dead `PromptContext` fields
(`initialContext`, `mode`, `styleDirective`, `nativeName`), dead style
keys, the inline verdict parser. Additions: `readLearnerView`,
`resolveStyle`, the frontier budget function, the curriculum data model
(two new tables, three new columns), one ingestion pipeline with pluggable
extractors, and the `submit_onboarding_verdict` tool.

## Testing

- Unit: frontier budget function (threshold table), `resolveStyle`
  (persona ceiling vs EMA cases), phase transitions (goodbye trigger,
  no wrapup at turn 21+), nudge TTL expiry.
- Prompt snapshot tests: core byte-stability across consecutive builds
  with unchanged persona/level; tail reflects live DB changes.
- Processor: constrained-decoding round-trip against the live SGLang
  endpoint with the two existing few-shot examples as fixtures.
- Ingestion: run the Pimsleur extractor on one language and the PDF
  extractor on one textbook; assert unit count, monotonic `introOrder`,
  and zero stored sentence text longer than a single lexeme/phrase entry.
- Curriculum runtime: enroll a user at `position = 8` of a textbook
  curriculum and assert new-word candidates come from chapter 9 onward.
- Live verification (per `BACKLOG.md` #1–2 discipline): one real voice
  session confirming mid-session frontier movement and no wrapup lock.
