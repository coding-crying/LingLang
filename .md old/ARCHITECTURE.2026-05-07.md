# LingLang Architecture Documentation

## Overview

LingLang is an implicit SRS (spaced repetition system) language tutor built on LiveKit Agents. It infers word mastery from conversation signals — speed, accuracy, grammar — rather than explicit flashcards. The system supports multiple service backends (cloud, local, experimental) via a ServiceFactory, with FSRS v5 spaced repetition, pgvector semantic search, and per-language voice/persona configs.

---

## System Architecture

### High-Level Architecture (Cloud Mode — Default)

```
┌─────────────────────────────────────────────────────────────┐
│                    LiveKit Cloud                             │
│                  (WebRTC Room Orchestration)                 │
└───────────────────────┬─────────────────────────────────────┘
                        │ WebSocket + WebRTC
┌───────────────────────▼─────────────────────────────────────┐
│                  LiveKit Agent Worker                        │
│                  (Node.js + TypeScript)                      │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           ServiceFactory (mode-based routing)         │  │
│  │  'cloud'    → ElevenLabs STT/TTS + local LLM        │  │
│  │  'local'     → Qwen3-ASR + local LLM + MossTTS      │  │
│  │  'local-gemma-audio' → Gemma E4B audio pass-through  │  │
│  │  'gemini'    → Google RealtimeModel (all-in-one)     │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │                                        │
│  ┌──────────────────▼───────────────────────────────────┐  │
│  │          Tutor Agent Instance                          │  │
│  │  - Voice pipeline orchestration (VAD + STT + LLM + TTS)│
│  │  - Background supervisor (FSRS + goals)              │  │
│  │  - Context manager (vocabulary + due reviews)         │  │
│  │  - PostgreSQL + pgvector integration                   │  │
│  └──────────────────┬───────────────────────────────────┘  │
└────────────────────┼────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐──────────────┐
        │            │            │              │
┌───────▼──────┐ ┌──▼────────┐ ┌─▼──────────┐ ┌▼──────────┐
│  ElevenLabs  │ │  LLM      │ │  Dashboard  │ │ PostgreSQL │
│  STT + TTS   │ │  Gemma4   │ │  :3001      │ │ + pgvector │
│  (cloud)     │ │  :8083    │ │  (Express)  │ │  :5433     │
└──────────────┘ └───────────┘ └─────────────┘ └────────────┘
  (or local)      llama-swap     admin panel     FSRS + embeds
  Qwen3 + MossTTS  + TokenRouter
```

### Local Mode Architecture

```
┌───────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐
│  STT  │   │   LLM     │   │   TTS     │   │ Embed    │
│ :8001 │   │  :8083    │   │  :8880    │   │  :8091   │
└───────┘   └───────────┘   └───────────┘   └──────────┘
 Qwen3-ASR   Gemma4-26B      MossTTS         BGE-M3
  (local)    llama-swap     → ElevenLabs     (llama-swap)
              fallback
```

---

## Service Modes

Controlled by `SERVICE_MODE` env var (default: `cloud`).

### Cloud Mode (`SERVICE_MODE=cloud`)
- **STT**: ElevenLabs Scribe v2 Realtime (WebSocket, VAD-based commit)
- **LLM**: Gemma4-26B via llama-swap (:8083), TokenRouter fallback (qwen3.5-flash)
- **TTS**: ElevenLabs (per-language cloned voices)
- **Supervisor/Processor**: Gemma4:31B via Ollama.com (cloud)

### Local Mode (`SERVICE_MODE=local`)
- **STT**: Qwen3-ASR (:8001) → ElevenLabs fallback on timeout/error
- **LLM**: Gemma4-26B (:8083) → TokenRouter fallback
- **TTS**: MossTTS (:8880) → ElevenLabs fallback on timeout/error

### Gemma Audio Mode (`SERVICE_MODE=local-gemma-audio`)
- **STT**: GemmaAudioSTT (buffers PCM audio as Base64 in transcript)
- **LLM**: Gemma4 E4B (:8084, vLLM with audio multimodal)
- **TTS**: ElevenLabs
- Experimental — audio goes directly to LLM without separate transcription

### Gemini Mode (`SERVICE_MODE=gemini`)
- **Everything**: Google Gemini RealtimeModel (single WebSocket for STT+LLM+TTS)
- Configuration: `GEMINI_MODEL`, `GEMINI_VOICE`, `GOOGLE_API_KEY`
- No separate services needed

---

## Agent Architecture

### Main Entry Point

**File**: `agents/src/tutor.ts`

```typescript
const session = new voice.AgentSession({
  agent,
  vad: prewarmed Silero VAD,
  stt: await createSTT(langConfig),    // fallback.ts factory
  llm: FallbackLLM or openai.LLM,     // local + cloud fallback
  tts: await createTTS(langConfig),    // fallback.ts factory
});
```

Each session:
1. Connects to LiveKit room, waits for participant
2. Loads user profile from PostgreSQL, creates if new
3. Builds language-specific instructions via `buildInstructions()`
4. Loads context from `ContextManager.getInitialContext()` (due reviews, new vocab, goals)
5. Creates STT/TTS instances via health-check factories
6. On each user turn: fires background `analyzeTurn()` → supervisor extracts lexemes, updates FSRS, manages goals

### Service Factory

**File**: `agents/src/services/factory.ts`

Switches between `local`, `cloud`, `local-gemma-audio`, `gemini` modes. Each mode wires different STT/LLM/TTS providers. Factories in `tts/fallback.ts` and `stt/fallback.ts` do health checks and auto-fallback.

### Background Supervisor

**File**: `agents/src/tools/supervisor.ts` + `supervisor-functions.ts`

After each user turn (fire-and-forget):
1. **Analyze**: Extract lexemes (lemma, POS, performance, language) from user utterance
2. **SRS Update**: Map performance → FSRS grade (1-4) → `fsrsReview()` → update `userVocabulary`
3. **Semantic Ripple**: Find 5 nearest neighbors via pgvector HNSW, apply fractional stability adjustments
4. **Goal Management**: Check active goals, detect completion, create new goals (remediation/vocab/grammar)

### Context Manager

**File**: `agents/src/lib/context.ts`

At session start:
- Load user profile (target language, proficiency)
- Query `userVocabulary` for due reviews (FSRS `due ≤ now`)
- Filter to target-language lexemes only
- Pick new vocabulary by frequency rank (skipping already-started words)
- Build initial context string for LLM system prompt

---

## Database Schema (PostgreSQL + pgvector)

### Core Tables

```
users            → target_language, native_language, proficiency_level
units            → curriculum structure (language, difficulty, prerequisites)
lexemes          → lemma, pos, translation, gender, frequency_rank, embedding(vector 1024d)
grammar_rules    → rule, description, example, embedding(vector 1024d)
user_vocabulary  → FSRS: state(0-3), stability, difficulty, due, reps, lapses
review_logs      → grade, state/difficulty snapshots, pronunciation_score
active_goals     → goal_type, target, status, progress
```

### Key Features
- **pgvector HNSW indexes** on `lexemes.embedding` and `grammarRules.embedding`
- **FSRS v5** continuous grading (Again/Hard/Good/Easy → state transitions)
- **Semantic ripple**: reviewing a word adjusts its nearest neighbors' stability
- **BGE-M3 1024d embeddings** via llama-swap (:8091)

---

## Dashboard

**File**: `agents/src/dashboard/server.ts`

Express server on port 3001 with:
- Scrypt-based password authentication
- Session management (in-memory, 24h expiry)
- API endpoints for users, vocabulary, stats, curriculum
- LiveKit token generation for test connections
- Duolingo import (legacy)

---

## Key Files

| File | Purpose |
|------|---------|
| `agents/src/tutor.ts` | Main agent entry point |
| `agents/src/services/factory.ts` | Service mode switching |
| `agents/src/tts/fallback.ts` | TTS health-check factory (MossTTS → ElevenLabs) |
| `agents/src/stt/fallback.ts` | STT health-check factory (Qwen3 → ElevenLabs) |
| `agents/src/tts/mosstts.ts` | MossTTS OpenAI-compatible client |
| `agents/src/tts/elevenlabs.ts` | ElevenLabs TTS LiveKit plugin |
| `agents/src/stt/elevenlabs-realtime.ts` | ElevenLabs Scribe v2 Realtime STT |
| `agents/src/stt/gemma-audio-stt.ts` | Gemma E4B audio buffer STT |
| `agents/src/llm/gemma-audio-llm.ts` | Gemma E4B audio multimodal LLM |
| `agents/src/llm/fallback-llm.ts` | Primary + fallback LLM chain |
| `agents/src/tools/supervisor.ts` | Background analysis entry point |
| `agents/src/tools/supervisor-functions.ts` | FSRS grading, goal management |
| `agents/src/lib/context.ts` | Context manager (due reviews, new vocab) |
| `agents/src/lib/fsrs.ts` | FSRS v5 algorithm implementation |
| `agents/src/lib/embedding.ts` | BGE-M3 embedding utilities |
| `agents/src/db/schema.ts` | PostgreSQL + pgvector schema definition |
| `agents/src/config/languages.ts` | Per-language voice/pedagogy config |
| `agents/src/config/prompts/base.ts` | LLM instruction builder |
| `agents/src/dashboard/server.ts` | Admin dashboard (Express) |

---

## Hardware Requirements

| Service | VRAM | Notes |
|---------|------|-------|
| Gemma4-26B (llama-swap) | ~9GB | Auto-unloads after 5min idle |
| Qwen3-ASR (local) | ~4GB | systemd user service |
| MossTTS (local) | ~5GB | systemd user service |
| BGE-M3 embed (llama-swap) | ~2GB | On-demand via llama-swap |
| **Total (local mode)** | **~18GB** | Leaves 6GB headroom on 24GB GPU |
| **Total (cloud mode)** | **~9GB** | Only Gemma4-26B when active |

Use `gpu-state` for VRAM arbitration between workloads.