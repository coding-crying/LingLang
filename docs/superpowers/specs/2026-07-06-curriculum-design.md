# Curriculum Ingestion & Card-Driven Teaching

**Date:** 2026-07-06
**Status:** Drafted from design discussion; awaiting user review
**Scope:** Content ingestion (textbooks, audio files, YouTube), the content
data model, the planner's expanded role as async lesson-builder, the card
channel from planner to conversation agent, deterministic-but-adaptive
progression, and session modes that let explicit user intent outrank the
planner's inference. Upload UI and the Library tab frontend are downstream
consumers but out of scope here (they build against the data model this
doc defines).

## Problem

Everything in the current loop is word-centric: frontier, goals, FSRS,
learner view, and the planner's DB context all treat "what to teach next"
as *a lexeme picked by global frequency rank*. A curriculum is
content-centric: ordered chapters, dialogues, grammar arcs, topics. Today
there is:

1. **No content data model at all** (confirmed in progress.md — Library's
   Explore/My Content tabs are stubbed for exactly this reason).
2. **No channel wider than a 1–3 sentence nudge** from planner to
   conversation agent. A nudge can *reference* chapter 3; the conversation
   agent has never *seen* chapter 3. Per the prompts-don't-bind lesson, a
   directive about content drifts — the content itself must be concrete
   lines in the prompt, the way `dueWords` already is.
3. **A vestigial `units` table** with order/difficulty/prerequisites that
   nothing walks: both read paths pick words by `frequency_rank` and ignore
   `unitId` entirely; `grammar_rules` are never proactively surfaced.
4. **No structured position memory.** The planner's long-term memory is
   free text (running summary, session summaries, notes). "Chapter 3,
   section 2, 4/9 vocab at Review state" cannot survive round-trips
   through a 300-token free-text output — position must be a DB row the
   planner reads, never a fact it is responsible for remembering.
5. **A hard prompt ceiling on the conversation side.** Gemma 4 12B's audio
   attention degrades once the prompt reaches ~2–4k tokens (community
   reports; our production prompt measures ~1.3–1.7k). Curriculum material
   in the conversation prompt has ~300–500 tokens of safe headroom — a
   distilled card, not a chapter.

## Principle

**The planner is the brain; the conversation agent is the UI.** The
conversation agent is the product's frontend — a fluent, in-character,
low-latency voice. It should never plan, sequence, or synthesize
curriculum; it renders what it is handed. The planner runs async in the
background with no latency budget — it can take as many cycles as it needs
to read the curriculum, diff it against what the learner already knows
(FSRS state), and compose the next **card**.

This does not mean the planner is in charge of everything. An explicit
user choice always outranks the planner's inference — that's already the
precedent for chunk advancement (§5's `curriculum_advance` trigger) and
extends to session shape itself (§10): a learner who wants a review-only
session, or to work a specific chosen textbook, gets exactly that. The
planner still does its job *within* whatever the user has chosen; it just
never overrides the choice.

Corollaries, inherited from the adaptive-loop redesign:

- **The DB is the only truth; prompts are views.** Curriculum position,
  card contents, and coverage live in tables. Prompt builders render them.
- **Prompts don't bind; code enforces.** Chunk advancement is a
  deterministic gate over FSRS coverage, never an LLM judgment call
  (level inference was already poisoned once by processor over-grading).
- **Ingestion is offline.** Parsing, chunking, and distilling never touch
  the live session loop or the 12B's latency path.

## Design

### 1. Data model

Four new tables (drizzle, same conventions as schema.ts):

```
content_sources
  id            text PK
  ownerId       text FK users.id, nullable   -- null = shared/global catalog
  language      text                          -- 'ru', 'zh', ...
  kind          text                          -- 'textbook' | 'audio' | 'youtube' | 'text'
  title         text
  originalRef   text                          -- file path / URL
  status        text                          -- 'uploaded' | 'ingesting' | 'ready' | 'failed'
  ingestError   text nullable
  createdAt     timestamptz

content_chunks
  id            text PK
  sourceId      text FK content_sources.id
  ord           integer                       -- reading order within source
  parentTitle   text nullable                 -- chapter, for grouping in UI
  title         text
  body          text                          -- cleaned chunk text, ~500–1500 tokens
  summary       text                          -- 2–3 sentences, planner-facing
  card          text                          -- distilled lesson card, ≤200 tokens, prompt-ready
  grammarPoints text                          -- JSON: [{rule, example, explanation}]
  difficulty    text nullable                 -- CEFR guess from ingestion
  embedding     vector(1024)                  -- BGE-M3, same as lexemes

chunk_lexemes
  chunkId       text FK content_chunks.id
  lexemeId      text FK lexemes.id            -- REUSES the existing lexemes table
  salience      real                          -- how central to the chunk (0–1)
  PK (chunkId, lexemeId)

user_content_progress
  userId        text FK users.id
  chunkId       text FK content_chunks.id
  status        text                          -- 'queued' | 'active' | 'done' | 'skipped'
  coverage      real default 0                -- computed, see §5
  activatedAt   timestamptz nullable
  completedAt   timestamptz nullable
  PK (userId, chunkId)
```

Why `chunk_lexemes` joins to the existing `lexemes` table instead of
storing vocab inline: every downstream mechanism — FSRS, the dictionary
gate, embeddings, the frontier, level inference — already operates on
lexeme rows. Curriculum vocab that isn't a lexeme row is invisible to the
whole loop. Ingestion creates missing lexemes through the same
dictionary-gated path the processor uses, so a hallucinated word in a
textbook scan cannot enter the vocabulary any more than a hallucinated
word in speech can.

The old `units` table stays for the seeded starter curriculum but gains no
new writers; content_chunks is its successor. (Migrating seeds into
content_sources is a cleanup, not a blocker.)

### 2. Ingestion pipeline (async, offline)

One worker script (`src/scripts/ingest-content.ts`, runnable standalone or
triggered by an upload endpoint later). Stages, each idempotent and
resumable via `content_sources.status`:

1. **Extract** — kind-specific:
   - `textbook`/`text`: PDF/EPUB → text (poppler/unstructured; OCR fallback).
   - `audio`: the existing two-pass cascade's transcription function —
     local Gemma 12B is already our best transcriber; long files are
     windowed into ~30s segments with overlap.
   - `youtube`: yt-dlp subtitle/auto-caption pull; fall back to audio
     download → same ASR path.
2. **Segment** — split on structural boundaries (chapters/headings/
   timestamps) into ~500–1500-token chunks. Never mid-dialogue. Store
   `body`, `ord`, `parentTitle`.
3. **Distill** — per chunk, one schema-constrained JSON call to the cloud
   26B-A4B (cheap, no VRAM cost, no latency constraint):
   - vocabulary: lemma, POS, translation, salience (capped at ~12/chunk)
   - grammar points (capped at 3)
   - `summary` (planner-facing, 2–3 sentences)
   - `card` (prompt-facing, see §3 for exact format, hard ≤200 tokens —
     re-prompt once if over, then truncate; log truncations)
   - difficulty estimate
4. **Link** — resolve each vocab item through the dictionary gate to a
   lexeme row (create if missing, with embedding); write `chunk_lexemes`.
   Unresolvable items are dropped and logged, not force-created.
5. **Embed** — chunk embedding via the existing BGE-M3 service.

Anti-hallucination rules carried over from the live loop: schema-
constrained decoding, hard per-chunk caps, dictionary gate, and log-don't-
silently-drop.

### 3. The card: planner → conversation channel

A card is the *only* curriculum artifact the conversation agent ever sees.

**Format (superseded — see "Resolution 2" below for the real, shipped
format):** the original design called for a labeled multi-field block
(Topic:/Phrases:/Vocab:/Grammar:, ≤200 tokens). This reproducibly broke
real audio attention in testing and was replaced with a single short
conditional instruction, ~60 tokens. Left here for history; do not
implement the block format below.

```
Lesson material (from "<source title>", <chunk title>):
Topic: <one line>
Phrases: <2–3 example sentences from the chunk, with translations>
Vocab: <lemma (translation)> × up to 8
Grammar: <one point, one example>
```

Placement: in the **core**, not the tail. The card is stable for the
lifetime of a chunk (typically many turns), so it prefix-caches; the tail
stays reserved for its ~8 volatile lines. `PromptContext` gains
`lessonCard?: string`; `buildInstructions` renders it after
`specialInstructions`. The frontier's tail lines still carry due/new
words as today — but sourced per §4.

The planner does not author cards freely each cycle — the ingested
`card` column is the default. The planner may *adapt* it (see §6's
tailored-plan cycle) by writing a `user_card_override` onto the progress
row, e.g. dropping vocab the learner already owns and pulling forward
items from the next chunk. Adaptation is optional; the system works with
static cards on day one.

**Measured 2026-07-07 (Phase 3): it degrades, and not where predicted.**
Real-WAV testing (check.wav, the same clip used for the cascade's own
verification) found the card breaks the local 12B's audio attention
reproducibly — 6/6 failures across two wrapper-wording attempts, at only
~430 TOTAL prompt tokens (persona + core + tail + card), far below the
assumed ~2–4k danger zone from community reports. Isolated the cause with
a control: a length-matched non-topical filler block (same token count as
the card) did NOT break attention — only the card's actual content did.
One mitigation was tried (an explicit "respond to what they said first"
priority line placed before the card) — it fixed a shorter hand-built
test prompt 3/3, but failed 3/3 once combined with the REAL full
production core (which has a few more pre-existing lines, ~430 vs ~330
tokens without the card) — meaning this isn't a clean token-budget
problem OR a simple wording fix, it's a fragile interaction between this
specific card content and an already-instruction-dense prompt.

**Resolution 2 (same day, after user pushback on the card concept
itself): "card just needs to be instructions on what to teach."** Tested
4 alternative framings against the real full prompt + real audio: a flat
vocab list (`Vocab from their course: X, Y, Z`) and a narrative paragraph
both FAILED 2/2; a bare conditional one-liner (`Course vocab available if
it fits: X, Y, Z`) and an explicit priority-ordered instruction both
SUCCEEDED 2/2. The differentiator wasn't structure or length — it was
whether the line reads as an optional aside a model can skip versus a
directive to follow ("Topic: X" reads as the latter no matter how it's
worded around the edges). **`card` is now redefined**: not a multi-field
lesson card at all, but a single short conditionally-framed teaching
instruction — "If it fits naturally, work in X, Y — they're studying
Z." — generated by the distillation prompt (§2) at a much smaller ~60-
token cap (down from 200; a real ingested example measured 28 tokens).
Re-verified 4/4 through the actual production code path with a real
model-generated card (not hand-crafted) — every reply referenced the real
audio, and one naturally wove in the card's topic as a follow-up without
overriding it. **`lessonCard` is wired into the conversation prompt
core**, reversing the first resolution above — the fix was the card's
shape, not its existence. `PromptContext.lessonCard`/§3's format section
and the ingestion prompt (`src/lib/ingest.ts`'s `buildDistillPrompt`) both
carry this in their doc comments; if either the card format or its
wrapper text changes again, re-verify with real audio before shipping —
across ~14 real-audio test calls this session, this model's audio
attention proved reproducible but genuinely fragile to phrasing, not just
to raw prompt length.

### 4. Loop integration (what changes, what explicitly doesn't)

**readLearnerView** gains: the active chunk's card + title + coverage
(one indexed query on `user_content_progress` where status='active'),
and — when a chunk is active — new-word candidates are drawn from
`chunk_lexemes` not yet started, ordered by salience, **falling back** to
global frequency rank when the chunk's vocab is exhausted or no content
is active. In both paths, candidates with a positive
`nativeSubstitutionCount` rank first: every substitution is the learner
*asking* for a word (they reached for the native one mid-sentence), and
this already-collected demand signal is currently read by nothing. Due words are untouched: FSRS review scheduling stays global,
because a due word is due regardless of which chapter introduced it.

**Frontier mechanic: unchanged.** Consolidate/balance/expand, budgets,
success gating — all identical. Curriculum changes *which* words are
candidates, never *how many* or *when*. This is the non-degradation
guarantee: the pacing controller that already works keeps sole authority
over introduction rate.

**Processor: unchanged.** Its per-word FSRS grades are exactly the signal
coverage is computed from.

**Planner prompt** gains a curriculum block in `buildPlannerPrompt`:

```
Curriculum: "<source>" — chunk <ord>/<total> "<title>" (coverage 44%).
Chunk summary: <summary>
Next chunk: "<title>" — <summary>
```

and one mandate line in `PLANNER_SYSTEM_PROMPT`: the nudge should steer
the conversation *through* the lesson material when a card is active
(scenario built from the chunk's topic, a phrase to elicit), and should
say when to set the material aside because engagement is dropping —
the existing engagement-first rule outranks the curriculum.

**Conversation agent: no new responsibilities.** It gets a card the same
way it gets due words. It never knows chunks exist.

### 5. Progression: code-owned, adaptive — not a rigid checklist

A chunk's `coverage` = fraction of its `chunk_lexemes` (salience-weighted)
whose `user_vocabulary` row has FSRS state ≥ 2 (Review). Recomputed in
`runProcessor`'s post-SRS-update hook (the same place that already
invalidates the learner view). Note on FSRS speed: per `fsrs.ts`'s
`initNewCard`, a *single* successful grade on a brand-new word graduates
it straight to state 2 — the word-level bar is fast. What's slow is
requiring an entire chunk's word list to each be individually elicited in
organic conversation before ever moving on, which is a pacing problem,
not an SRS problem — the fix below addresses that directly rather than
lowering the per-word bar.

(Earlier draft of this coverage function also treated `reps ≥ 2` as
covering — dropped: `reps` increments on every review including
failures, so two wrong attempts falsely counted as "known.")

**Two ways to advance, not one.** A rigid 70%-of-checklist gate is too
brittle for a chat-paced tutor — a learner doing well overall shouldn't
be stuck on one chunk because the conversation hasn't happened to surface
its last two words. `evaluateAdvancement()` mirrors the frontier
mechanic's own trend-gated philosophy (lib/frontier.ts §2 — success rate
and backlog, not a fixed list):

- **Full coverage** — `coverage ≥ 0.7`, the ideal/thorough path.
- **Adaptive/soft** — `coverage ≥ 0.35` AND global `recentSuccess ≥ 0.8`
  (the same signal the frontier already computes — doing well
  *everywhere*, not just this chunk) AND the chunk has been active at
  least 2 real days. All three thresholds live in `src/lib/curriculum.ts`,
  tunable like frontier.ts's own constants.

Either path flips the chunk `done`, activates the next `ord`, and
invalidates the learner view.

**Explicit user override — no arithmetic at all.** "Let's move on,"
"I already know this," "skip ahead" is a new `curriculum_advance`
supervisor trigger (same immediate-action-trigger pattern as
`language_change`/`difficulty_adjustment` — `supervisor-functions.ts`'s
`SupervisorTrigger` type + schema enum + a documented prompt line, only
fired on an explicit request, never inferred from doing well). It calls
`skipActiveChunk()` directly — the sole write path (`advanceChunk`) is
the same one arithmetic advancement uses, so the trigger cannot corrupt
position, it just skips the gate entirely. Same trust-the-user precedent
as the existing language-switch trigger: a request to honor, not a
teaching moment to gate.

The planner may still *recommend* skip/revisit from its own read of
engagement (new `CURRICULUM: skip|revisit` output line, parsed like
NOTE/PERSONA) — but that recommendation goes through the identical
`advanceChunk` write path, same invariant as before: the planner suggests
moves, it never has a second, uncontrolled way to mutate position.

### 6. Tailored plans: the knowledge diff (async planner heavy lifting)

When a source finishes ingesting for a user (and nightly for active
sources), a **placement pass** runs — planner-side, zero latency budget:

1. Code computes the diff: for each chunk in order, coverage as defined in
   §5 (cheap — one join between chunk_lexemes and user_vocabulary).
2. Chunks already ≥ 0.7 covered are marked `done` at activation time — a
   learner who knows chapter 1–2's vocabulary starts at chapter 3, on
   arithmetic, not vibes.
3. The first not-covered chunk becomes `active`; the rest `queued`.
4. Optionally (flagged), one 26B call per active chunk writes the
   `user_card_override`: given the card and the learner's known-word list
   for this chunk, drop what they own, promote next-chunk items to fill
   the freed slots. This is the "planner thinks as long as it needs"
   moment — it happens between sessions, costs nothing at conversation
   time, and its output is still just a ≤200-token card.

This pass is also where future cross-source intelligence lives (e.g. "the
YouTube video's vocab overlaps chapter 5 — sequence them together"), but
that is explicitly out of scope for v1.

### 7. Discourse memory & grammar analytics

The word layer is already durably persisted (`user_vocabulary`,
`review_logs`, substitution counts). What is NOT persisted is the level
above it: the utterance an error happened in, its grammar context, the
conversation around it. Turns die with the 5-turn buffer; processor
analyses die with `lastProcessorRun`; what survives is free-text
summaries. Two additions close this:

```
utterances
  id         uuid PK
  userId     text FK users.id
  sessionId  text
  turnSeq    integer
  language   text
  transcript text                 -- the cascade's clean pass-1 output
  analysis   jsonb                -- processor result for this turn
  embedding  vector(1024)         -- BGE-M3, same service as lexemes
  createdAt  timestamptz

error_observations
  id         uuid PK
  userId     text FK users.id
  language   text
  ruleId     text FK grammar_rules.id nullable  -- canonical tag (see below)
  ruleText   text                 -- processor's raw free-text label
  lexemeId   text FK lexemes.id nullable
  snippet    text                 -- the offending fragment
  utteranceId uuid FK utterances.id
  createdAt  timestamptz
```

Both are written from `runProcessor`'s existing completion hook —
fire-and-forget inserts, zero latency added to the loop.

**Canonical grammar tags are the linchpin.** The processor's free-text
rule labels ("genitive after negation" / "wrong case after не" / "case
error") never aggregate. `grammar_rules` already has embeddings sitting
unused: map each free-text label to its nearest canonical rule row
(cosine threshold; below it, ruleId stays null and the raw text is kept).
Then "weak grammar patterns" is `GROUP BY ruleId ORDER BY count DESC` —
exact SQL, no LLM in the read path. The processor is the quality gate for
all of this: its extraction fidelity (already improved by the two-pass
cascade) bounds everything the planner can learn from the data.

### 8. Planner tool calling

The live planner graduates from one-shot to agentic-lite: same 30s cycle,
same NUDGE/SUMMARY output contract, but with a small set of read-only
tools (OpenAI function calling, capped at ~3 tool rounds before it must
emit its lines):

- `get_weak_patterns(language, limit)` — the §7 GROUP BY view
- `search_utterances(query, limit)` — embedding search over past turns
- `get_substitutions(limit)` — top native-substitution words (demand)
- `get_chunk_details(chunkId)` — full summary + vocab for a queued chunk

Code-side retrieval (pre-stuffing the prompt) stays for the cheap, always-
relevant facts (due words, engagement, curriculum position); tools are for
what code can't anticipate — the planner deciding *it* wants to know
whether "aspect errors" are a trend before building a nudge around them.
This requires the planner on a cloud model (12B tool-calling under a
system prompt this size is not trustworthy); model choice stays an env
var (`SUPERVISOR_PLANNER_LLM_*` already exists — 26B-A4B, 31B, whatever
judges best). The offline placement pass (§6) gets the same tools plus
write-suggestion calls, with more rounds allowed.

### 9. Word introduction: trust the model

One line joins the prompt core, and deliberately no more than one:

> "When you introduce a new word, do it the way a friend would mid-
> conversation — use it naturally, gloss it once, and hand it to them to
> try."

The instinct to spell out a procedure (say it, translate it, drill it,
check it) is the same over-prompting that produced the schoolteacher
persona bug. Instruction-tuned models already know how words are taught;
the prompt's job is to say *that* it should happen and in *what voice*,
and the frontier tail already says *which* words and *how many*. If
introduction quality is bad in live testing, the fix is examples in the
persona (show, don't legislate), not more rules.

### 10. Session modes: user intent outranks the planner

The planner is the brain (§ Principle), but "the brain decides everything"
is the wrong reading of that — a learner who wants to explicitly practice
review vocab, or explicitly work through a chosen textbook, should get
exactly that, not the planner's inferred idea of what's best. This is not
a new mechanism: it is the same precedent §5's `curriculum_advance`
trigger already established (an explicit request bypasses arithmetic
entirely) applied one level up, to session shape instead of chunk
position.

**Motivation (user's research, 2026-07-07):** learners often self-assess
their own level *better* in short conversations constrained to a small,
known word list than in open-ended chat — a reason to let users choose a
narrow, deliberate session shape sometimes, not just react to whatever
the planner infers is optimal for them.

**Mechanism — `sessionMode`, set at connect or mid-session:**

- `mixed` (today's implicit default — planner-driven, no change)
- `review` — new-word introduction off; only due words worked
- `new` — new-word introduction favored even if recent success is
  middling; due words still woven in (SRS is never fully suspended, just
  de-prioritized relative to new material)
- `content:<sourceId>` — a Library pick activates that source directly,
  skipping the automatic placement pass (§6) entirely; the *user's*
  choice of material, with the already-built coverage/adaptive-advance/
  skip machinery (§5) handling pacing from there. This is the primary v1
  path for how a source gets studied — automatic placement remains an
  enhancement for "I have several unsorted sources," not the default flow.
- `quick_check` — a short, deliberately narrow-word-list session (the
  research finding above). Named explicitly rather than folded into
  `review`, because its purpose (a learner probing their own sense of
  level) is different from ordinary spaced-repetition maintenance, even
  though the mechanics look similar.

**Where this plugs in — no new state model, one override point:**

`frontier.ts`'s `computeFrontierBudget` already outputs a directive + a
new-word budget from computed signals (`dueBacklog`, `recentSuccess`).
`sessionMode` becomes a pre-check in front of that logic: `review` forces
`newWordBudget = 0` and a directive to that effect, regardless of what
the computed state would have said; `new` raises the budget (or skips the
`consolidate` gate) even on middling success, because the user asked, not
because the algorithm inferred readiness. `content:<sourceId>` bypasses
§6's placement pass and calls the same activation path §5's
`skipActiveChunk`/`advanceChunk` already use. The planner is untouched by
mode — it still reads engagement, still writes nudges — it just can't
steer *away* from what the user explicitly chose.

**What's genuinely new, not a repurposed mechanism:** the voice-page UI
(mode toggle), a `sessionMode` field threaded through session start (and
a way to change it mid-session — likely a data-channel message, same
pattern as the existing `persona_update`/`curriculum_advance` triggers,
rather than requiring a voice utterance the processor has to parse), and
the Library-side "pick this source" action that writes the
`content:<sourceId>` mode. These are real, unbuilt frontend + plumbing
work — everything else in this section is wiring, not new architecture.

### 11. What we are NOT building in v1

- Upload UI / Library frontend (builds against this model later; the
  ingest script + a curl-able endpoint is enough to dogfood).
- Cross-source sequencing, prerequisites, spaced re-reading of chunks.
- Multi-user shared catalog moderation (ownerId nullable is the hook;
  everything v1 is per-owner).
- Grammar-point FSRS (grammar points ride in cards informationally;
  tracked practice stays word-level).
- Full `sessionMode` frontend (§10) — the override plumbing in
  `frontier.ts`/session-start ships now; the voice-page toggle and
  Library "study this" button are frontend work that follows.

## Phases

**Phase 1 — schema + curriculum lib.** Tables above, `src/lib/
curriculum.ts` (coverage, advancement, placement diff — pure functions +
one write path), migration, seed one hand-made source for testing.
No behavior change to the live loop.

**Phase 2 — ingestion worker (DONE 2026-07-07).** `src/lib/ingest.ts`
(five stages: extract/segment/distill/link/embed) + `src/scripts/
ingest-content.ts` (CLI). `text` and `audio` kinds proven end-to-end
against real content and the real DB (see memory for details — real
Russian café/directions chapter, real check.wav transcription via the
existing cascade). `textbook` (PDF) and `youtube` kinds are implemented
but NOT live-tested — no sample PDF was on hand, and `yt-dlp` isn't
installed in this environment (no system package manager access, no pip).
Verify these two before relying on them.

**Phase 3 — loop wiring.** readLearnerView + buildInstructions card
rendering; planner curriculum block; processor coverage hook;
deterministic advancement. Re-verify audio attention at the new prompt
size with the real-WAV harness. Live session test against the Phase 2
source.

**Phase 4 — placement pass + card overrides** (§6), then the upload
endpoint for the frontend to build on.

**Phase M (parallel track, independent of 1–4) — memory layer.**
`utterances` + `error_observations` tables and the processor write hook
(§7) can ship immediately — they only *record*, nothing reads them yet,
so there is zero behavioral risk and the data starts accumulating now.
Canonical-tag mapping and the planner tools (§8) follow once the planner
moves to a cloud model. The substitution-demand ranking and the word-
introduction line (§4, §9) are each a one-line change shippable any time.

Each phase is independently shippable; Phases 1–2 touch nothing the live
loop reads.

## Open questions

1. **Hybrid timing — RESOLVED 2026-07-07.** Not a token-budget problem —
   isolated via a length-matched filler control that survived at the same
   size the card failed at. It was the multi-field block's directive
   framing ("Topic: X"). Redesigned `card` as a single conditionally-
   framed instruction (§3, "Resolution 2") and it now works, verified 4/4
   with a real ingested card through the real production path.
   `lessonCard` ships wired into the local-audio conversation model — the
   cloud-conversation hybrid is no longer a forcing function for this
   specifically, though it may still be worth pursuing for other reasons
   (conversational liveliness, per the original 2026-07-06 discussion).
   Still-open sub-question: only one real chapter/card and one audio clip
   were used across all these tests. Broader validation (more chapters,
   more languages, more real learner audio — not just check.wav's trivial
   "System check complete.") should happen during real dogfooding, not
   assumed safe from this sample size.
2. **Salience weighting** in coverage: linear weight vs. top-N-must-be-
   covered. Start linear; revisit with real data.
3. **Audio-source pronunciation gold.** An ingested audio source contains
   native pronunciations of the chunk vocab — worth storing clip offsets
   per lexeme for future "listen to the native speaker" playback? Cheap to
   capture at ingest (segment timestamps), so: capture, don't build on it
   yet.
4. **Card language mix.** Cards contain target-language phrases; the
   comprehensible-input controller (language-mix.ts) governs the tutor's
   *output* mix but nothing governs card difficulty vs. learner level when
   a source outpaces the learner. v1 answer: placement pass ordering +
   frontier gating make this rare; watch for it in live testing.
