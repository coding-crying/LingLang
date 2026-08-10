# Claims are not debts: separating seeded knowledge from review pressure

**Date:** 2026-08-09
**Status:** Design, awaiting implementation
**Depends on:** `0017_content_provenance.sql` (shipped, commit `062af45`)

## 1. The problem

Content provenance seeds FSRS cards from self-reported prior study. Those seeded
cards are backdated on purpose, so older material surfaces before newer material
instead of everything arriving at once. That backdating is correct. Its
interaction with the frontier is not.

Work the day-25 Pimsleur case through the live constants:

- `SEED_STABILITY.drilled = 21`, `w13 = 1.0048`, `requestRetention = 0.9`
- `scheduledDays = round(21 x (1/0.9 - 1) / 1.0048) = 2`
- `PACE_DAYS_PER_CHUNK.audio = 1`, so lesson *n* is dated `(24 - n)` days back
- a seeded card's due date is `studiedAt + scheduledDays`

Every lesson with `ord < 22` is therefore **already overdue the moment it is
seeded** — 23 of 25 lessons, at up to `MAX_VOCAB_PER_CHUNK = 12` words each, so
up to **276 words due immediately**.

`computeFrontierBudget` throttles on that count. `CONSOLIDATE_BACKLOG_THRESHOLD`
is 15. At 276 the frontier returns `consolidate` with `newWordBudget: 0` and the
directive *"Work only with known/review words. Introduce nothing new."*, and
`buildFrontierInfo` renders `newWords` as an empty string whenever the budget is
zero.

The result is a deadlock. The learner is correctly placed at lesson 26, and the
tutor is then forbidden from introducing any of lesson 26's words. Chunk coverage
only rises when new words are learned, so coverage stalls, `evaluateAdvancement`
never fires, and the curriculum stops. The feature switches the tutor into
review-only mode at precisely the moment it succeeds.

`nextInterval`'s pre-existing ~9x-short interval makes this near-permanent: a
reviewed 21-stability card returns in ~2 days, so a 276-word backlog does not
meaningfully drain against the 5 due words surfaced per turn. That bug is **out
of scope here** (see §7) but it is why the deadlock does not resolve on its own.

## 2. Principle

A seeded card is a **claim** about knowledge, not a **debt** owed to the
scheduler. Claims must not generate review pressure. They should generate
verification opportunities, and be confirmed or falsified by ordinary use.

Concretely: do not force review. Trust the learner's self-report, surface those
words naturally as conversational scaffolding, and let real usage decide whether
the claim was true.

## 3. Design

The architecture already separates the two concerns; the fix is to stop
conflating them.

- `dueBacklog` is consumed **only** by `frontier.ts` and is purely a throttle. It
  never decides what the learner sees.
- `dueWords` is a separate query, rendered as *"Words they already know, your
  scaffolding"* (`base.ts:287`). It is support material, not a drill.

### 3.1 `dueBacklog` counts only earned pressure

Exclude unreviewed seeded rows from the backlog count:

```
origin = 'seeded' AND reps = 0   ->   excluded
```

The rule is uniform over seeded rows regardless of `state`: a claim that decayed
below `RETENTION_FLOOR` (seeded as state 1, `claimsKnown = false`) is still a
claim, not a debt.

This alone breaks the deadlock. 276 claimed words no longer force `consolidate`,
so lesson 26 gets taught.

### 3.2 `dueWords` keeps surfacing claims

Unchanged in intent: seeded words still appear as scaffolding. That channel is
the verification mechanism, and it requires no new grading machinery.

### 3.3 Slot reservation, and why the query must split

`dueWords` sorts by due date ascending and slices to 5. Seeded claims are
overdue by construction, so all 276 sort ahead of genuinely earned reviews and
crowd them out of the window.

Note this cannot be fixed by partitioning in memory: the current query is
`where userId and due <= now, order by due asc, limit 20`, so with 276 overdue
claims **all 20 fetched rows can be claims** and no earned card is available to
pick. The query must be split in two:

- **earned**: `origin <> 'seeded' OR reps > 0`, order by due asc, limit 20
- **claims**: `origin = 'seeded' AND reps = 0`, order by due asc, limit 20

Then fill the 5 slots in three passes, each by due date ascending:

1. up to **3 earned**
2. fill the remaining slots with **claims**
3. if slots still remain (few or no claims), top up with **more earned**

This guarantees earned reviews are never starved, that claims still get at least
2 slots per turn whenever earned cards are plentiful, and that a full window of 5
is still produced when either pool is empty.

### 3.4 Language filter

`dueBacklog` currently has no language filter (`learner-view.ts:104`) while
`dueWords` does. A two-language learner is throttled by the wrong language's
backlog. Add the same filter while touching the query.

## 4. Conversion semantics

A claim becomes a real card on first contact, whichever way it goes. No new code
is needed — this falls out of the existing grading path.

| Outcome | Existing mechanism | Result |
|---|---|---|
| Used unprompted, good pronunciation | `fsrs.ts:304` returns grade 4 | `reps` -> 1; now counts toward backlog as earned |
| Fumbled or slow | grade <= 2 | `reps` -> 1; correctly generates review pressure |
| Reached for the native word | `nativeSubstitutionCount`, bypasses the due gate | surfaces as a demand word |
| Never comes up | — | stays a claim, invisible to the throttle, still counted for coverage |

Because claims sort to the front of the scaffolding list, an unverified claim
surfaces soon in the ordinary course of conversation. No explicit audit pass is
specified; add one only if unverified claims prove to persist in practice.

## 5. Error handling

No new failure modes. Both queries are additive filters on an indexed column
with a `NOT NULL DEFAULT 'conversation'`, so pre-provenance rows classify as
earned and behave exactly as they do today. If the claims query returns nothing,
slot filling degrades to today's behaviour.

## 6. Testing

Pure-function tests (no DB):

1. `computeFrontierBudget` is unaffected by 276 claims — asserts `balance` or
   `expand`, not `consolidate`.
2. Slot reservation: with 20 earned and 20 claims, result is 3 earned + 2 claims.
3. Slot reservation with 1 earned and 20 claims: 1 earned + 4 claims.
4. Slot reservation with 20 earned and 0 claims: 5 earned (pass 3 tops up).

Integration (live DB, extending `verify-content-provenance.ts`):

5. After reconciling the day-25 Pimsleur fixture, `dueBacklog` is 0 and the
   frontier grants a non-zero `newWordBudget` — the regression test for the
   deadlock.
6. Grading one seeded word converts it: `reps = 1`, and it now counts toward
   `dueBacklog`.
7. A two-language user's `dueBacklog` counts only the session language.

## 7. Out of scope

- **`fsrs.ts:213` `nextInterval`.** Computes `S x (1/R - 1)/w13`, roughly 9x
  shorter than canonical FSRS-5 where the interval at R=0.9 is approximately `S`.
  Affects every card in the system, not just seeded ones. Its own change, with
  its own verification, and a prerequisite for using `requestRetention` as a
  difficulty dial.
- Content upload and the syllabus catalog.
- Weak-spot targeting and adaptive difficulty. Note `grammar_rules` is empty (0
  rows), every `error_observations.rule_id` is NULL, and the table is write-only.
