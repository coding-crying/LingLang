# LingLang

A voice language tutor that models what you know, word by word.

You talk to it. While you talk, a second model reads the transcript and updates a
per-word memory model of your vocabulary — what you've met, what you've produced,
how well you recalled it, when you should see it again. The tutor's next turn is
built from that model. It isn't a chatbot with a language-learning prompt; the
scheduling state is real, persisted, and drives what gets said to you.

**Status:** working, actively developed, and rough in places. Read
[Known rough edges](#known-rough-edges) before you invest an evening in it.

---

## What you need

Self-hosting is supported in **cloud mode**: your machine runs the agent and the
database, and Google's realtime model does the listening, thinking and speaking.
No GPU.

* Node.js 22+ and pnpm 9 (`corepack enable` gets you the right pnpm)
* Docker, for Postgres
* A [LiveKit](https://livekit.io) project — the free tier is enough. LiveKit
  carries the audio between browser and agent.
* A Google API key with Gemini access

There is also a **local mode** that runs the whole speech stack on your own GPU.
It is not self-hostable today: it depends on services that don't live in this
repo. See [Local mode](#local-mode) for what that would take.

---

## Quickstart

```bash
git clone https://github.com/coding-crying/LingLang.git
cd LingLang
corepack enable && pnpm install

# 1. Configure
cp .env.example agents/.env.local
$EDITOR agents/.env.local          # fill in the REQUIRED vars

# 2. Database
docker compose up -d               # Postgres + pgvector on :5433
cd agents && pnpm drizzle-kit push # create the schema

# 3. Build the web app
pnpm dashboard:build

# 4. Run — two terminals, both from agents/
pnpm dashboard                     # web app + API on :3001
pnpm dev:tutor-ed                  # the tutor agent worker
```

Open <http://localhost:3001>, make an account, and press the mic.

### Or run the whole stack in Docker

`docker-compose.yml` also has `linglang-dashboard` and `linglang-tutor`
services built from `Dockerfile.agent`, plus a one-shot `linglang-migrate`
service that runs `drizzle-kit push` before either starts. Fill in
`agents/.env.local` as above, then:

```bash
docker compose up -d --build
```

This is a bigger, less-transparent box than the two-terminal `pnpm` flow
above — prefer that one while developing, and this one for handing the
whole thing to a machine you don't want to babysit.

`.env.example` documents every variable, but only these are required:
`DATABASE_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
`GEMINI_API_KEY`, `API_KEY_ENCRYPTION_SECRET`, and `DASHBOARD_PASSWORD_SALT`.

Set that last one even though it has a default — the default is a fixed string
in this public repo, so every install that leaves it blank shares one salt.

### Use `drizzle-kit push`, not `migrate`

`agents/drizzle/` contains sixteen hand-numbered SQL migrations, but
`meta/_journal.json` only knows about the first one — the numbered files were
written by hand and never registered. `drizzle-kit migrate` would therefore
apply the baseline, report success, and leave you fifteen migrations short.

`push` diffs `src/db/schema.ts` against the live database and is correct for a
fresh install, which is why it's the step above. `schema.ts` is the real source
of truth for the schema; the SQL files are history.

---

## How it works

Three models with different jobs, which is the whole design:

**Conversation** is the voice you talk to. It's optimised for latency, and it is
deliberately not the thing tracking your progress — asking one model to hold a
natural conversation *and* maintain scheduling state makes it worse at both.

**Processor** runs behind the conversation, off the critical path. It reads each
exchange and writes to the vocabulary model: which lexemes appeared, whether you
produced them or only heard them, how well you recalled them, and when FSRS says
you should see them next. This is where the word-level state comes from.

**Supervisor** looks across sessions and decides what should happen next — new
material, or remediation on words that are slipping.

Because the Processor's output is persisted state rather than conversational
context, it survives sessions, and the tutor's picture of you sharpens the more
you talk. `ARCHITECTURE.md` has the detail.

### Layout

| Path | What's in it |
|---|---|
| `agents/src/tutor-event-driven.ts` | The agent worker. Session orchestration lives here. |
| `agents/src/services/factory.ts` | Chooses the speech/LLM stack for a session. The seam between the tutor and any given provider. |
| `agents/src/db/schema.ts` | Postgres schema — source of truth. |
| `agents/src/dashboard/server.ts` | API + serves the web app. |
| `agents/src/dashboard/frontend/` | The React app (Voice / Library / Profile). |
| `agents/src/config/languages.ts` | Which languages exist, and which need a realtime model. |

---

## Languages

Seven languages — English, Russian, Spanish, French, Portuguese, Arabic, Chinese
— have curated speech configuration and work in every mode.

Around two dozen more work in cloud mode only, because they have no pinned local
voice. If you pick one of those, the agent upgrades the *session* to a realtime
model rather than dropping you back to English: which speech stack runs is an
implementation detail, the language is the point.

---

## Known rough edges

Stated plainly, because finding these yourself at 1am is worse:

* **The quickstart above hasn't run end-to-end on a clean machine with real
  credentials.** Every `process.env.*` read in `agents/src` was cross-checked
  against `.env.example`, which caught one real bug: the Processor's
  Gemini-mode check only recognized `GOOGLE_API_KEY`, not the documented
  `GEMINI_API_KEY`, so it silently fell back to a local LLM that doesn't
  exist in cloud mode (fixed). What's *not* verified is an actual boot with
  live LiveKit/Gemini credentials — do that before trusting this fully. If
  you hit a gap, an issue would genuinely help.
* **The Docker path is newer and less battle-tested than the two-terminal
  `pnpm` flow.** `Dockerfile.agent` builds the whole pnpm workspace, so the
  image is large and slow to build for now — see the `node_modules`
  duplication note below.
* **No reconnect on dropout.** If the audio connection dies mid-session you
  reconnect by hand.
* **`node_modules` is large** (~2 GB), dominated by the ONNX runtime native
  binaries (~500 MB) pulled in by speech plugins you won't use in cloud
  mode.

---

## Local mode

Local mode runs conversation, speech-to-text and text-to-speech on your own
hardware — no API calls, nothing leaving the machine. It's the mode this project
was originally built for, and on a 24 GB card it's genuinely good.

It is not currently self-hostable, and the honest reason is that the speech
services it points at are separate pieces that aren't in this repository. Their
URLs are in `.env.example` so the shape is at least visible. If you already run
your own ASR/TTS endpoints you can point `SERVICE_MODE=local` at them, but
you'll be filling in gaps.

Cloud mode is the path that works today.

---

## Contributing

Issues and PRs welcome — especially anything that comes out of trying the
quickstart on a machine that isn't mine. See `CONTRIBUTING.md`.

## Licence

This project is dual-licensed:

- The underlying LiveKit agents SDK (everything outside `agents/`) is
  **Apache-2.0** — see `LICENSE` and `NOTICE`.
- The LingLang tutor application itself (`agents/`) is **AGPL-3.0-or-later**
  — see `agents/LICENSE`. This means if you run a modified version of the
  tutor as a network service for others, you must make your modified source
  available to them. Running it yourself, self-hosted, is unaffected.
