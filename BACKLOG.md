# LingLang — Feature Backlog

Rewritten 2026-07-02. Previous version (2026-06-24) archived at
`.md old/BACKLOG.2026-06-24.md` — its two items (dynamic target-language
switching, processor immediate-action trigger field) are **done**, both
confirmed present in code (`supervisorTriggers` with `language_change`
type, handled in `tutor-event-driven.ts`). Its third item (three-agent
role clarity) is now covered by `ARCHITECTURE.md` instead of living here.

## Needs live verification (before anything else)

These were fixed in code during the last work session but never confirmed
working against a running agent — the session ended with the tutor agent
down and the user frustrated about regressions. Do this first, before new
feature work:

1. **Channel-marker leak** — regex strip is in `tutor-event-driven.ts:1542`.
   Confirm `<|channel>thought\n<channel|>` no longer reaches TTS/history on
   a live turn.
2. **Target-language ratio for beginners** — `ratioForLevel()` fix in
   `src/config/prompts/base.ts`. Confirm a `pre_a1` user actually gets
   ~15% target language, not the old 75%.
3. **Dashboard login / UI** — user reported "login is gone... tiles gone."
   Investigation so far: the Vite build in `src/dashboard/public/app/` is
   *not* stale (build postdates all frontend source edits), and both
   `login.html` and the React `LoginScreen` POST correctly to `/api/login`.
   Root cause not found yet — needs a live browser repro, not more code
   reading. Do this as step one of the frontend-refinement pass.

## Dashboard / auth hardening

4. **Per-user salt for password hashing** — `agents/src/lib/user-auth.ts`
   currently uses one static salt (`DASHBOARD_PASSWORD_SALT`, hardcoded
   fallback) shared across all users' scrypt hashes instead of a per-user
   random salt. Flagged by automated security review 2026-07-02. Explicitly
   deferred to the upcoming frontend/dashboard work rather than fixed in
   isolation — bundle it with the per-user dashboard pass.
5. Dead server routes: `/debug` → `public/debug.html` and the `/dashboard`
   fallback → `public/dashboard.html` / `public/css/dashboard.css` /
   `public/js/dashboard.js` reference files that no longer exist on disk.
   Either remove the routes or restore minimal fallback files so a broken
   Vite build fails gracefully instead of 500ing.

## Content ingestion (the unfinished half of the onboarding plan)

6. PDF textbook upload → SGLang (`:8094`) extraction of vocab/grammar per
   chapter → seed `lexemes` + `user_vocabulary` → optional placement probe
   conversation to mark already-known words → feeds the onboarding level
   anchor. Spec: `docs/plans/2026-07-01-onboarding.md` (onboarding half of
   that plan is done; content ingestion is not started).

## Product / UI

7. Duolingo-style progress UI on the dashboard (stats, streaks, visual
   progress) — explicitly requested, not yet designed or built.
8. Grammar rules table (`grammar_rules`) is empty and nothing populates
   it — level-inference had to route around this with a `review_logs`
   proxy. Worth deciding whether to seed it (manual curriculum content) or
   drop the table/feature.

## Loose ends worth a decision, not urgent

9. `server/` (self-host packaging: Dockerfile, models, services) is a
   plain directory at the project root, not a git repo and not tracked by
   this one either. Decide whether it becomes its own repo, a submodule,
   or gets folded into this repo properly.
10. Root `.gitignore` had a blanket `*.md` rule that silently excluded
    every project doc (including this file, `ARCHITECTURE.md`,
    `PROJECT_STATE.md`) from git history until 2026-07-02. Fixed — worth
    double-checking no other important non-code files are caught by
    similarly broad vendored-SDK ignore rules.
