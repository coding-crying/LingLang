# LingLang — Operational Memory

Rewritten 2026-07-02, ground-truthed against `server.ts` and running
processes. Previous version (2026-06-05, described the old static-HTML
dashboard) archived at `.md old/MEMORY.2026-06-05.md`. This is the "quick
facts" file — ports, passwords, gotchas. For architecture see
`ARCHITECTURE.md`; for current status/bugs see `PROJECT_STATE.md`.

## Ports & services

| Service | Port | Notes |
|---|---|---|
| SGLang (`gemma4-12b-it-qat`) | `:8094` | conversation + processor + supervisor all hit this concurrently |
| OmniVoice TTS | `:8882` | FastAPI, ~5GB VRAM |
| Wyoming bridge (`wyoming_openai`) | `:10300` | non-LiveKit clients (Home Assistant); bridges to Qwen ASR `:8001` + OmniVoice `:8882` |
| Qwen ASR (`moonshine-medium-streaming`) | `:8001` | only used via the Wyoming bridge, not the main conversation path |
| Dashboard (Express) | `:8392` | nginx → `linglang.senilelines.com` |
| Postgres (`linglang-db`, Docker) | default 5432 | volume `linglang_linglang-pgdata`, **password `linglang`** — not the compose default, easy gotcha when debugging fresh volumes |

`stt-wyoming` has a known GPU-OOM crash loop — de-prioritized, doesn't
affect the main conversation path.

GPU budget: OmniVoice (~5GB) + SGLang (~17.2GB) ≈ 23.1GB/24GB. Almost no
headroom while both are up.

## Dashboard API (ground-truthed against `server.ts`, 2026-07-02)

Public: `POST /api/waitlist`, `POST /api/login`, `POST /api/logout`,
`GET /login`.

Auth-protected (`ll_session` cookie):
- `GET /api/me` — current user + target/native language
- `POST /api/register` — create user
- `GET /api/users`, `GET /api/users/:userId`, `PATCH /api/users/:userId`
- `GET /api/users/:userId/vocabulary`
- `GET/PATCH /api/users/:userId/persona`
- `GET/POST /api/users/:userId/onboarding/:lang`
- `POST /api/token` — LiveKit AccessToken + AgentDispatch, room `linglang-<userId>`
- `GET /dashboard`, `/dashboard.html`, `/css/dashboard.css`,
  `/js/dashboard.js` (the last three are **legacy fallback routes whose
  target files no longer exist on disk** — see `BACKLOG.md` #5)

Unauthenticated but not linked from the UI: `GET /api/curriculum`,
`/api/runtime`, `/api/stats`, `/api/db/:table`, `/api/vocabulary`,
`/api/vocabulary/:language`, `/api/services`, `/api/activity`,
`/api/logs` (SSE, secret-redacted), `/api/events` (SSE) — these read-only
endpoints predate the multi-user auth pass and were never gated; worth a
look before launch.

## Voice / call gotchas

- OmniVoice latency: 200–600ms for 1–2 sentence Portuguese output; CUDA
  graph cache miss penalty ~40–190ms. 32-graph LRU cap at ~3.5GB VRAM keeps
  misses rare; without the cap it leaks memory unbounded.
- Voice-clone diagnosis: the `.txt` next to a clone `.wav` in
  `~/Desktop/TTS/OmniVoice/voices/` **must be a word-for-word transcript**.
  The `.pt` cache in `voices/.cache/` is mtime-validated against the `.wav`
  only. If a voice seems to "change" between turns, it's almost always
  code-switching content drift, not seed/prompt loss — diagnose by logging
  `voice=` + `lang=` on every synthesize call, not by ear.
- LiveKit agent name must match `WorkerOptions.agentName`, set via
  `LINGLANG_AGENT_NAME` (default `linglang-tutor`).
- Matrix bridge exists for call rooms (`@linglang` bot, `@him` user,
  non-E2EE rooms) — separate from the LiveKit web flow, used for phone
  access. T-Mobile CGNAT is a known false-flag for "is the bridge broken?"
  — check that before assuming a code regression.

## Auth model

- Per-user scrypt (`agents/src/lib/user-auth.ts`), `LOWER()`-normalized
  usernames. Known accounts as of last check: `will` (hardcoded admin),
  `Robert`. ~71 orphan users flagged in a past audit — never cleaned up.
- **Static salt weakness** — see `BACKLOG.md` #4, deferred to the frontend
  pass intentionally, not forgotten.
- `db/index.ts` must call `dotenv.config()` at its own top (ES module
  hoisting bug otherwise leaves `DATABASE_URL` unset while `dashboard`
  entrypoint's own dotenv call looks like it should've covered it).

## Documentation hygiene

Root `.gitignore` had a blanket `*.md` rule (inherited from the vendored
`livekit-agents-js` template) that silently excluded every project doc
from git history — this file, `ARCHITECTURE.md`, `BACKLOG.md`, and
`PROJECT_STATE.md` had **zero git history** until this was fixed
2026-07-02. If a doc you expect to exist seems to have vanished, check
`.md old/` (informal archive convention already in use before this
session) before assuming it was never written — and `git log --all
--full-history -- <file>` won't help for anything older than 2026-07-02
for the same reason.
