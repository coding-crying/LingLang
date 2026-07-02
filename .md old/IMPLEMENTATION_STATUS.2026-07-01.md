# LingLang Implementation Status

**Date**: 2025-05
**Status**: Core pipeline operational with FSRS, dashboard, multi-mode services

---

## ✅ What's Working

### 1. Service Factory (Multi-Mode Architecture)

`agents/src/services/factory.ts` — switches between modes via `SERVICE_MODE` env var:

| Mode | STT | LLM | TTS |
|------|-----|-----|-----|
| `cloud` (default) | ElevenLabs Scribe v2 | Gemma4-26B local | ElevenLabs |
| `local` | Qwen3-ASR :8001 | Gemma4-26B :8083 | MossTTS :8880 → ElevenLabs fallback |
| `local-gemma-audio` | Gemma E4B STT buffer | Gemma E4B :8084 | ElevenLabs |
| `gemini` | Gemini Realtime | Gemini Realtime | Gemini Realtime |

All services have health-check fallbacks: if local STT/TTS is unreachable, automatically falls back to cloud (ElevenLabs).

### 2. Database & FSRS System ✅

**Schema** (`agents/src/db/schema.ts`):
- `users` — User profiles with language preferences
- `units` — Curriculum structure (multi-language)
- `lexemes` — Vocabulary with BGE-M3 1024d embeddings + pgvector HNSW indexes
- `grammarRules` — Grammar rules with embeddings
- `userVocabulary` — FSRS continuous tracking (state, stability, difficulty, due, reps, lapses)
- `reviewLogs` — Per-review snapshots for FSRS optimizer
- `activeGoals` — Goal-seeking state machine

**FSRS Algorithm** (`agents/src/lib/fsrs.ts`):
- 4-grade system: Again (1), Hard (2), Good (3), Easy (4)
- Voice performance → FSRS grade mapping
- Semantic ripple: reviewed word's nearest neighbors get fractional stability adjustments
- Duolingo strength → approximate FSRS state conversion

### 3. Supervisor/Processor Pipeline ✅

**File**: `agents/src/tools/supervisor-functions.ts`

Background analysis after each conversation turn:
1. **Analyze Utterances** — extract lexemes (lemma, POS, performance), detect language
2. **Update SRS** — FSRS grading (correct/wrong/new), semantic ripple to neighbors
3. **Goal Management** — check active goals, detect completion, create new goals:
   - Remediation: recent failures (FSRS state 1 / Relearning)
   - Vocabulary: new words by frequency rank
   - Grammar: untaught rules

### 4. Context Manager ✅

**File**: `agents/src/lib/context.ts`

- `getInitialContext()` — loads user profile, FSRS due reviews, new vocabulary by frequency, goal state
- Filters to target-language lexemes only (native-language entries excluded from review)
- New user detection for onboarding behavior

### 5. Dashboard ✅

**URL**: http://localhost:3001 (configurable via `DASHBOARD_PORT`)

- Auth-protected (scrypt password hashing, session-based)
- Global stats (users, vocabulary, progress, units)
- User progress with FSRS state distribution (New/Learning/Review/Relearning)
- Active goals monitoring
- Recent vocabulary with FSRS stability/difficulty scores
- Duolingo import form (legacy, still functional)

### 6. LLM Fallback Chain ✅

**File**: `agents/src/llm/fallback-llm.ts`

- Primary: local Gemma4-26B via llama-swap (:8083)
- Fallback: TokenRouter cloud (qwen3.5-flash)
- Automatic failover on timeout/error

### 7. Per-Language Config ✅

**File**: `agents/src/config/languages.ts`

- Voice profiles per language (ElevenLabs voice IDs, MossTTS voice names, Gemini voices)
- Pedagogy settings (target language ratio, persona)
- STT language codes

---

## 🔄 What Needs Work

### High Priority
- [ ] End-to-end stability testing (10+ turn conversations, multi-hour sessions)
- [ ] Memory leak detection on long sessions
- [ ] Better interruption handling in voice flow
- [ ] Remove stale docs and dead code (Chatterbox, XTTS, Duolingo)

### Medium Priority
- [ ] Conversation summary memory (replace 10-turn sliding window)
- [ ] VoxCPM2 quality/latency benchmarks vs ElevenLabs
- [ ] Gemma E4B audio mode testing and optimization
- [ ] Real-time dashboard updates (WebSocket instead of refresh)
- [ ] Session recording/playback

### Lower Priority
- [ ] Multi-agent architecture (orchestrator, reviewer, grammar-coach)
- [ ] Mobile-friendly dashboard
- [ ] Deployment hardening (systemd services, health checks, Prometheus)
- [ ] Seed script PG rewrite (still references SQLite API)
- [ ] `start_local_services.py` cleanup (references old services)

---

## 🔧 How to Run

### Cloud Mode (default)
```bash
docker-compose up -d          # PostgreSQL + pgvector
cd agents && pnpm dashboard &  # Optional monitoring
cd agents && pnpm dev:tutor    # Start agent
```

### Local Mode
```bash
systemctl --user start speech-stack.target  # Qwen3-ASR + MossTTS
docker-compose up -d
cd agents && pnpm dashboard &
cd agents && pnpm dev:tutor
```

### Test Database
```bash
cd agents && pnpm test:db
```

---

## 📊 Current Stats

- **Languages supported**: ru, es, fr, pt, ar, en
- **SRS**: FSRS v5 with semantic ripple (pgvector HNSW)
- **Embeddings**: BGE-M3 1024d
- **Service Modes**: cloud, local, local-gemma-audio, gemini
- **Dashboard**: Auth-protected, :3001

---

## 📚 Documentation

- `QUICKSTART.md` — Getting started guide (updated 2025-05)
- `TODO.md` — Project plan and task list (updated 2025-05)
- `FSRS_MIGRATION.md` — FSRS + pgvector migration log
- `ARCHITECTURE.md` — System design (needs update)
- `agents/src/services/factory.ts` — Service mode switching
- `agents/src/config/languages.ts` — Per-language configuration

### Archived/Deprecated Docs
These are historical and no longer reflect the current system:
- `CHATTERBOX_LIVEKIT_*.md`, `FATTERBOX_GUIDE.md` — Chatterbox TTS (removed)
- `XTTS_LIVEKIT_*.md` — XTTS TTS (removed)
- `LOCAL_STT_GUIDE.md` — Faster Whisper guide (replaced by Qwen3-ASR)
- `DUOLINGO_*.md` — Duolingo integration (defunct)
- `CLOUD_SERVICES*.md`, `CLOUD_SETUP_COMPLETE.md` — Stale cloud setup