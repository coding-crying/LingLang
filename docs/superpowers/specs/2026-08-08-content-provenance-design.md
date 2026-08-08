# Content provenance — knowing what a source *means* to a learner

*2026-08-08. Builds on the curriculum ingestion pipeline (migration 0009,
`lib/ingest.ts`, `lib/curriculum.ts`), whose own design doc was never
committed — §1 reconstructs what it does, since everything here depends on it.*

## 1. What already worked, and the hole in it

Adding content already worked end to end before this change:

```
POST /api/content-sources
  → ingestSource()            extract → segment → (lazy) distill → link vocab → embed
  → content_chunks            ordered parts, each with a prompt-ready `card`
  → chunk_lexemes             joined to the EXISTING lexemes table
  → placeUserInSource()       "knowledge diff": walk chunks, compute coverage,
                              drop the learner at the first one they don't know
  → readLearnerView()         active chunk's card reaches the conversation prompt
```

`placeUserInSource` is the interesting part. It doesn't guess where to start
a learner — it computes it, chunk by chunk, from `computeCoverage`, which is
the salience-weighted fraction of a chunk's vocabulary at FSRS state ≥ 2 in
`user_vocabulary`. Arithmetic, not vibes. That's the right design and it is
not changed here.

But it reads `user_vocabulary`, which only ever contained words earned *in
this app*. So for the learner the feature is actually for:

> "I'm on day 25 of Pimsleur. Here are the first 25 lessons."

…coverage comes out 0% for every chunk, and they are placed at lesson 1.
Worse, silently: nothing errors, the tile looks fine, and the tutor starts
teaching them `olá`. The pipeline isn't wrong. It has no channel through
which to be *told* what the learner already knows.

Three related gaps fall out of the same missing channel:

| Case | What went wrong |
| --- | --- |
| Half-finished textbook | Placed at chapter 1; no way to say "I stopped around nine" |
| Completed audio course with a time delay | No way to record *when* — so either everything resurfaces at once or nothing does |
| Aspirational content (a song, a film they want to understand) | Indistinguishable from studied content; would be treated as material to march through |

The fix is not more pipeline. It's provenance: a record of what each source
*is to this learner*, and a reconciler that turns it into the vocabulary
state placement already knows how to read.

## 2. Two questions, asked at different times

Adding content is two problems, and conflating them is what makes upload
flows miserable.

**What IS this?** — kind, language, title. Answerable from the input almost
every time. A `youtube.com` URL is a video; a `.pdf` is a textbook. The
learner should not be asked. `inferSourceByRule` handles URLs, extensions
and pasted prose deterministically; the LLM fallback exists only for bare
titles like "Pimsleur Spanish 1", where there is genuinely nothing to parse.
`kind` is now optional on `POST /api/content-sources`.

**What is it TO YOU?** — worked through it? how far? how long ago? Only the
learner knows, and the answers are worth real money.

The second set is asked **later**. A questionnaire between "I found a book"
and "it's in my library" is the fastest way to make someone not add the
book. So: the source ingests immediately and lands in the library **greyed
out**, carrying an unanswered profile. The questions get answered when the
learner opens the tile — or simply in conversation, because a tutor asking
"how far did you get with it?" is a normal thing for a tutor to say and a
form is not.

Question specs live in `lib/content-profile.ts` and are served to *both*
the UI and the voice tools. One list, so the two flows cannot drift.

`intent` is the first question and the one that routes everything else:

- **`study`** — partway through it. Seed what's behind them, queue the rest.
- **`known`** — finished it. Seed all of it, queue nothing.
- **`aspire`** — want to get to it. Seed **nothing**; it's a target.

`aspire` completes as soon as intent is given — there's no prior study to
date or measure, so further questions would be friction with nothing behind
them.

## 3. Turning "I studied this 25 days ago" into FSRS state

`lib/prior-knowledge.ts`. This is the heart of it.

The naive options are both wrong. Marking chunks done without seeding is a
lie — coverage still reads 0%, the frontier still offers lesson-1 vocabulary
as brand new. Seeding everything as known-and-not-due hides a year of
forgotten material forever.

What we do instead is be **honest about time**: record that the learner
learned these words on date *D* with strength *S*, and let ordinary FSRS
decay decide what's still solid.

```
stability   ← SEED_STABILITY[intensity]      drilled 21d · studied 8d · skimmed 2.5d
lastReview  ← the date they actually studied it
due         ← lastReview + interval(stability)     ← NOT now + interval
retention   ← 1 / (1 + w13 · elapsed/stability)    ← same curve fsrsReview uses
```

Backdating `due` to the study date is the property everything rests on. For
the day-25 Pimsleur learner, lesson 1 (studied 24 days ago) comes back due
immediately while lesson 25 (studied today) stays quiet. Dating from `now`
would hide all 100 words for weeks; dating everything old would dump them
into one session.

The per-chunk gradient comes from `PACE_DAYS_PER_CHUNK` in
`content-reconcile.ts` — we ask for one date, not a study log, so the dates
of earlier chunks are interpolated backwards at a per-kind assumed pace
(audio courses are built around one lesson a day; textbook chapters take a
few days; a video is one sitting). Capped at `MAX_BACKDATE_DAYS`.

Two hard rules:

1. **A seeded row is a claim, not an observation.** Rows carry
   `origin='seeded'`, and `writeSeededCards` never overwrites an
   `origin='conversation'` row. We watched the learner say those words; a
   round number about a whole course must not average over that. `reps`
   stays 0 — `review_logs` has no row for any of this, and inflating reps
   would corrupt every statistic built on them.
2. **Claims decay.** Below `RETENTION_FLOOR` (0.35) we refuse to assert
   knowledge and seed state 1 instead: kept out of coverage, so the learner
   is *not* skipped past material they've genuinely lost, but marked as
   ground they've covered before. Otherwise "I did this textbook in 2019"
   would mark half a language known on the strength of one sentence.

## 4. Reconciliation

`lib/content-reconcile.ts`. Seeds vocabulary **first**, then calls the
existing `placeUserInSource` — rather than adding a second placement path
that could disagree with the first. Marking chunks done is the cosmetic
part; seeding the words is the feature.

Idempotent: re-seeding touches only previously-seeded rows, and placement
only fills chunks with no progress row. Correcting "actually 15 lessons, not
25" moves the learner back without destroying anything they've earned since.

Runs detached from whatever triggered it — a finished textbook can mean
hundreds of distillation calls, bounded at `DISTILL_CONCURRENCY`. The
frontend polls, exactly as it already does for ingestion. `onSourceReady`
handles the race where a learner finishes answering before the PDF finishes
chunking.

## 5. The conversation as an input path

`tools/content-tools.ts`, wired into the tutor for non-demo sessions.

- `list_content_needing_info` — what's outstanding, with **one** question,
  pre-phrased for speech.
- `record_content_answer` — takes the learner's reply **verbatim**;
  `normalizeSpokenAnswers` extracts whatever they actually addressed. One
  reply can answer three questions ("I did the first twenty lessons,
  finished about a month ago, drilled them properly") and often does.

The tutor is never asked to structure the answer, because making a
conversational model fill a schema mid-turn is how you get invented values.
Both tools go through the same `applyProfileAnswers` as the HTTP route.

## 6. Library UI

Tiles needing a profile render desaturated (not merely dimmed — "unfinished
setup" should read differently from "still processing") with an *N quick
questions* chip, and tapping one opens the questions **instead of**
selecting it. Selecting it would run placement against an empty vocabulary
and drop the learner at part 1 of a book they may have half finished.

`ContentProfileSheet` renders one question at a time, answered on tap, no
submit button, questions fetched from the server. "Don't ask" reconciles on
conservative defaults rather than leaving the source inert forever.

## 7. Verification

`src/lib/prior-knowledge.test.ts` and `src/lib/content-profile.test.ts` —
32 unit tests over the pure math and question routing.

`src/scripts/verify-content-provenance.ts` — the wiring, against the real
database. Builds a 30-lesson audio course, a learner who completed 25 at one
a day, and asserts the whole outcome. Current result, all 23 checks passing:

```
25 lessons marked done · active chunk ord 25 · 100 words seeded, origin=seeded, reps=0
lesson 1 vocabulary is already overdue   — 22.0 days overdue
lesson 25 vocabulary is not due yet      — due in 2.0 days
lesson 1 retention 0.465 vs lesson 25 1.000
lessons beyond the claim untouched · re-running does not duplicate
a conversation-earned row is not overwritten by re-seeding
```

## 8. Known limitations

- **Intervals are short.** `nextInterval` in `fsrs.ts` computes
  `S · (1/R − 1) / w13`, which for S=21, R=0.9 gives ~2.3 days — roughly 9×
  shorter than canonical FSRS-5, where the interval at R=0.9 is ≈ S. That's
  pre-existing and applies to every card in the system, not just seeded
  ones; seeding deliberately matches the live scheduler rather than being
  independently "correct". Worth revisiting, but as its own change.
- **Pace is assumed, not measured.** One date plus a per-kind constant. A
  learner who did 20 lessons in a weekend and then stopped for a month gets
  a gradient that's wrong in the middle (the endpoints are still right).
- **A course with no files can't be added.** "I did 25 Pimsleur lessons" but
  no audio means there's nothing to ingest, so nothing to seed. Would need a
  catalog of known course syllabi.
- **`do_exercises` and `depth` are recorded but not yet consumed** by the
  prompt builder — the answers are stored, nothing reads them.
- **Aspirational content has no distinct treatment in the prompt.** It
  places at chunk 0 and its vocabulary becomes new-word targets through the
  ordinary path, which is reasonable, but the tutor isn't told *why* the
  learner wants it (`goal` is stored and unread).
