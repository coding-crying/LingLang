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
- persona row, including the planner-maintained style profile (see §4)
- next uncovered curriculum item at the user's position (§9)

(Per-turn processor output — errors, hints, pronunciation — is *not* in
this view; it rides on the session-local `lastProcessorRun` result, the
one legitimate piece of session state, same as today.)

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

### 4. Adaptive style → one free-text profile, one writer

The enum taxonomy (humor/pacing/register/profanity/preamble/bsCallouts
EMAs, roast tolerance, register lines) is deleted, not repaired. Asking a
model to emit six style enums on every turn is the "infer many things at
once" failure mode; the roast/register/pushback prompt lines were its
downstream symptom.

**Division of labor:**

- **Code measures what code can measure.** Turn lengths, pacing, error
  density — deterministic, free, already computed. These keep driving the
  mechanical prompt lines (length, error treatment).
- **The LLM infers style only as free text, in one place.** The planner —
  the only agent with whole-conversation context and time to reflect —
  maintains a 1–2 sentence **style profile** through its existing
  `PERSONA:` mechanism (`extraInstructions` / `personaOverride`). E.g.
  "Terse and sarcastic; likes being teased back; skip pleasantries; they
  fact-check you — admit uncertainty rather than bluff." Evidence-gated
  as today, editable by the user from the dashboard.

The profile renders inside the persona block in the stable prompt core.
"Fun and engaging" is a standing line of the base persona — a floor, not
a parameter. Persona-as-ceiling arbitration disappears as a problem:
persona and style are now the same object with one writer.

**Deletions:** `styleSignals` from the processor schema, `user_style` EMA
writes, `roastTolerance`/`register` from `AdaptiveContext`,
`computeRoastLine`, `computeRegisterLine`, `resolveStyle` (from the
earlier draft of this design).

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
- **Style duty:** the planner is the sole style writer (§4). Its prompt
  gains one instruction: maintain the learner's style profile as 1–2
  sentences via the existing `PERSONA:` line when the conversation gives
  clear evidence — replacing the per-turn enum tagging the processor used
  to do.
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
  level change): persona block (incl. style profile), learner identity
  line, standing rules (tools note, "correct the pattern not the word",
  topic agency: "follow the learner's topic; the word lists tell you which
  vocabulary to reach for, not what to talk about").
- **Tail** (rebuilt per turn): frontier directive + word lists, error
  treatment, nudge ("Current angle"), phase/length line.

`buildInstructions` keeps its signature but composes core-then-tail with
the guarantee that the core substring is byte-identical between calls
unless its inputs changed. Latency win falls out of layout; no infra work.

**Prompt budget (hard rule):** the volatile tail carries at most ~8 short
lines — one frontier directive, the word lists, one error-treatment line,
one nudge, at most one "Teach next" item, one length line. Anything that
wants a new tail line must replace an existing one or be rejected. A 12B
model follows a handful of instructions well and a rulebook badly; every
signal in this design earns one line or stays in the DB.

### 8. Processor → the listening specialist (thinking allowed)

The processor is the only agent that hears the user *and* is off the
critical path — its output feeds the next turn's prompt, not the current
reply, so it has seconds of slack per turn. That latency budget is spent
on **native-audio depth, not output breadth**: the processor may run as a
thinking model (bounded reasoning budget so results land within a turn),
while its output schema stays lean and fully constrained.

**What listening buys us (the same lean schema, better filled):**

- **Recall confidence → real FSRS grades.** Audio distinguishes what text
  can't: instant confident production vs. hesitation, self-correction,
  stutters, false starts, long pauses before a word. Each lexeme gains a
  `confidence: instant | hesitant | struggled` field; `voiceToGrade`
  maps performance × confidence onto the full Again/Hard/Good/Easy scale
  instead of the effectively binary grading text transcripts allow. This
  directly improves the scheduler *and* the frontier budget's
  `recentSuccess` signal — struggle shows up before errors do.
- **Pronunciation**, as already specified (§6): per-lexeme stress flags +
  one sentence-level note, surfaced to the conversation agent as one
  prompt line.
- **Struggle as a trigger:** sustained hesitation/disfluency across a
  turn fires the existing `difficulty_adjustment` trigger — no new
  machinery, just a better-informed sender.

**What the processor stops doing:** style inference (`styleSignals`
removed — see §4). One job: listen, tag, grade. Fewer simultaneous
inferences, better ones.

**Mechanics:**

- SGLang `response_format`/JSON-schema constrained output derived from
  `UtteranceAnalysis` (now with `confidence`, without `styleSignals`).
- Runs async per user turn as today (`PROCESSOR_TURN_INTERVAL`); a turn
  whose analysis arrives late simply lands in the following prompt build
  — the loop already tolerates this.
- Deletions: `cleanAndParseJSON` (all regex repair), the retry loop that
  re-sends an identical prompt, `buildSimplePrompt`, `isSmallModel`
  branch, `ANALYSIS_PROMPT_FULL` alias.
- Every parse failure today silently drops FSRS grades; constrained
  decoding makes the grading pipeline parse-deterministic.
- `NUM` removed from `FUNCTION_WORD_POS` — numerals are core learnable
  vocabulary at pre-A1/A1 and are currently discarded.
- Text-only fallback (no audio capability, or text-mode sessions):
  `confidence` defaults to `instant`-neutral grading as today; the
  feature degrades to current behavior, never blocks.

### 9. Curriculum spines — user-set, Pimsleur-seeded default

A curriculum is an ordered sequence of **typed teaching items**, not a
word list. Textbooks and Pimsleur lessons teach concepts: phrase patterns
with substitutable slots, grammar rules, script/alphabet, and vocabulary.
The curriculum carries the *introduction order of concepts*; the FSRS
word scheduler stays scoped to what it's good at — long-term retention of
discrete recall items. It controls *material selection only* — never
conversation topic (§2 topic agency rule). Users choose their curriculum;
the default one is seeded from Pimsleur structure.

**Item types:**

- `lexeme` — word or fixed phrase. Enters `lexemes` and, once introduced,
  the FSRS retention loop as today.
- `pattern` — a productive frame with slots ("Eu quero ___", "___, por
  favor"). This is Pimsleur's core move: teach the frame, then drill by
  swapping known words into the slot. Stored as frame text only — the
  `teachingHint` says how to drill it; no slot-category spec (the LLM
  picks fitting known words itself).
- `grammar` — a rule/concept, written to the existing `grammar_rules`
  table (currently empty with no producer — this resolves `BACKLOG.md`
  #8: curriculum ingestion becomes its populator).
- `script` — alphabet/orthography/reading items, flagged
  `voiceTeachable: false`. The voice tutor skips these; they surface as
  dashboard exercises in the frontend pass.

**Complexity rule — types route, they don't prompt.** Item types exist in
the DB only so the system knows where things go (lexemes → FSRS, script →
dashboard, everything else → conversation). The conversation prompt never
sees the taxonomy: it gets at most **one** "Teach next:" line per turn,
whose wording was authored once at ingestion time (`teachingHint`), not
composed from per-type prompt logic at runtime. The LLM reads one
instruction, not a rulebook.

**Progression model:** one bit per item per user: covered or not.
An item is marked covered when the processor observes the user use it
successfully — or after it has been the teaching item for ~3 turns
(don't pin the spine on perfection; the planner can steer back to shaky
items later). Lexemes additionally enter FSRS: coverage is "did we teach it,"
FSRS is "do they still know it." Revisiting shaky concepts is the
planner's job (strategy), not a scheduler's — the processor's existing
`grammarRule` error tags already give it the evidence.

**Data model:**

- `curricula`: id, language, `sourceType`
  (`default_pimsleur | textbook | youtube | movie`), title,
  `ownerUserId` (null = shared/default curriculum).
- `units`: gains `curriculumId`; one row per lesson/chapter/segment with a
  `sequence` number. (Table exists and is empty.)
- `unit_items`: unitId, `itemType` (`lexeme | pattern | grammar |
  script`), `introOrder`, `voiceTeachable`, payload reference (lexemeId /
  grammarRuleId / inline frame text), and `teachingHint` — one authored
  sentence on how to teach it (e.g. "Introduce 'Eu quero ___' and have
  them swap in words they already know").
- `user_item_coverage`: userId, unitItemId, coveredAt.
- `user_curriculum`: userId, curriculumId, `position` (unit sequence
  reached), `isActive`. "I'm up to chapter 8 and want to keep going" is
  just `position = 8` at enrollment time. Items before `position` are
  *implicitly* covered — no bulk coverage rows written; coverage rows
  exist only for items actually taught. (The placement probe from the
  onboarding plan can spot-check the claim.)

**Ingestion — one pipeline, pluggable extractors (offline scripts now;
upload UI belongs to the frontend pass):**

1. Extractor produces raw text segments per unit. **Phase 1: Pimsleur +
   PDF only** — they prove the pipeline; media extractors follow once it
   works:
   - Pimsleur transcript files → lessons (Will has the files)
   - PDF textbook → chapters (absorbs `BACKLOG.md` #6)
   - Later: YouTube caption track / OpenSubtitles movie transcript,
     chunked by time — same pipeline, new extractor only
2. Common structuring step: local SGLang extracts **typed items** per
   unit — vocabulary, phrase patterns, grammar rules, script items — each
   with introduction order and a one-sentence `teachingHint` capturing how
   the source teaches it (this is where Pimsleur's drill mechanics live:
   the hint says "build it back from the last syllable" or "drill by
   swapping the slot", so no drill logic exists at runtime) → writes
   `units` + `unit_items` (+ `lexemes`, `grammar_rules`). Pimsleur
   transcripts are pattern-rich; textbooks are grammar/script-rich; the
   extractor emits whatever the source teaches.
3. For media sources (youtube/movie) the goal is "understand this
   content": items are mostly lexemes ordered by frequency-in-source ×
   general frequency (plus recurring constructions as patterns), and unit
   `sequence` follows the content's own timeline so position = "how far
   into the movie/series you can follow."

**Legal boundary (all sources):** store only lexeme/phrase-level structure
— introduction order, drill mechanics, frequency, unit boundaries. Never
store or replay source sentences, dialog, or running text. The tutor
generates its own sentences around the spine.

**Runtime touchpoints (two, both small):**

1. Next-item selection: when the frontier directive is `expand` or
   `balance`, the new material is the next uncovered *voice-teachable*
   item(s) from the user's active curriculum at their position — which may
   be a pattern or grammar concept, not just words. The frontier budget
   governs the *pace* of introduction regardless of item type. No active
   curriculum, spine exhausted, or learner past ~A2 on the default spine →
   fall back to current frequency/semantic word selection. Zero behavior
   change where there's no data.
2. Prompt: one line in the volatile tail — `Teach next: <item> —
   <teachingHint>` — and nothing else. No per-type prompt logic; the hint
   was authored at ingestion. When there's no uncovered item in budget,
   the line is absent.

**Growth loop (deferred to frontend pass):** curriculum picker, upload UI,
and "Lesson N of M" / "you can now follow 60% of this movie" progress on
the dashboard, powered by `user_curriculum.position` and coverage queries.

### 10. Onboarding verdict → tool call

The onboarding agent gets a `submit_onboarding_verdict` tool (same JSON
shape as today's inline block). Structured by construction; no TTS leak
surface; the inline ```` ```onboarding_verdict ```` parsing is deleted.
The processor's `onboarding_signal` trigger remains as supplementary
field-filling only — the tool call is the sole writer of the level anchor.

### 11. Ensemble readiness — roles can shrink independently, later

**Today: the 12B fills every role slot**, and vLLM concurrency handles the
three roles hitting it — no change to the running setup. This section
exists so that the *future* step down (e4b for roles that qualify; e2b for
the edge product in `linglangedge/`) is a config change plus an eval run,
not a rearchitecture. No new runtime logic — config, capability flags,
and evals only.

**Role→model contract.** One config object replaces the env-var fallback
chains (`LOCAL_LLM_MODEL` / `SUPERVISOR_LLM_MODEL` /
`SUPERVISOR_PLANNER_LLM_MODEL` × url/model/key):

```
roles:
  conversation: { model, requires: [audio, streaming] }
  processor:    { model, requires: [json_schema], wants: [audio, thinking] }
  planner:      { model, requires: [] }          # text-only by design
  ingestion:    { model, requires: [long_context] }  # offline; use the biggest available
```

**Degradation rules, per role.** If the processor's model lacks audio, it
runs transcript-only and the pronunciation feature (§6) disables cleanly —
nothing else changes. The planner is text-only already. Only the
conversation role hard-requires audio; it keeps the big slot.

**Shrink order (when the time comes):** processor first — a
schema-constrained tagging task, e4b-class, and it runs every turn;
planner second — reads pre-aggregated text, emits three lines;
conversation last — audio + fluent generation keeps the big slot longest.
The edge product (e2b) reuses the same role contract with tighter
capability flags.

**Per-role eval fixtures — the qualification gate.** A model may take a
role only if it passes that role's fixture set:

- processor: ~50 utterances (incl. mixed-language, the two few-shot
  cases, trigger cases) with gold lexeme tags; score = tag accuracy +
  trigger precision/recall.
- planner: a handful of DB-state snapshots with acceptance criteria per
  nudge (mentions the right focus, ≤3 sentences, no data-regurgitation).
- conversation: harder to score mechanically; smoke suite = level-ratio
  adherence and length-line compliance over scripted exchanges.

Fixtures live in-repo (`agents/eval/` — the existing `eval-*.json`
artifacts show precedent) and run as a script against any candidate
endpoint. "Can a 4B do this role?" becomes a command, not a vibe.

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
(`initialContext`, `mode`, `styleDirective`, `nativeName`), the entire
style-enum taxonomy (`styleSignals`, `user_style` EMA writes,
`computeRoastLine`/`computeRegisterLine`), the inline verdict parser. Additions: `readLearnerView`,
the frontier budget function, the curriculum data model
(four new tables: `curricula`, `unit_items`, `user_curriculum`,
`user_item_coverage`), one ingestion pipeline with pluggable
extractors, the `submit_onboarding_verdict` tool, the role→model config
(replacing three env-var fallback chains), and per-role eval fixtures.

## Testing

- Unit: frontier budget function (threshold table), confidence→grade
  mapping in `voiceToGrade` (instant/hesitant/struggled × performance),
  phase transitions (goodbye trigger, no wrapup at turn 21+), nudge TTL
  expiry.
- Prompt snapshot tests: core byte-stability across consecutive builds
  with unchanged persona/level; tail reflects live DB changes.
- Processor: constrained-decoding round-trip against the live SGLang
  endpoint with the two existing few-shot examples as fixtures.
- Ingestion: run the Pimsleur extractor on one language and the PDF
  extractor on one textbook; assert unit count, monotonic `introOrder`,
  typed items present (patterns with frame text + hint, grammar rows
  landing in `grammar_rules`), and zero stored sentence text beyond a
  single lexeme/phrase/frame entry.
- Curriculum runtime: enroll a user at `position = 8` of a textbook
  curriculum and assert next-item candidates come from chapter 9 onward
  and skip `voiceTeachable: false` items.
- Live verification (per `BACKLOG.md` #1–2 discipline): one real voice
  session confirming mid-session frontier movement and no wrapup lock.
