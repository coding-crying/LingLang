# LingLang Agent Implementation

This directory contains the **Node.js** implementation of the LingLang conversational tutor.

## Architecture

This implementation uses the **LiveKit Agents Framework** to orchestrate a voice-based learning experience.

### Key Components

*   **`tutor-event-driven.ts`**: The main agent definition (Optimized).
    *   It initializes the `VoicePipelineAgent` using a local LLM (Ollama).
    *   It uses an **Event-Driven Architecture**:
        *   **Processor**: Runs every 5 turns to analyze grammar and update SRS (without blocking conversation).
        *   **Supervisor**: Checks for goal completion and injects new topics dynamically.

*   **`tools/supervisor-functions.ts`**: The pedagogical intelligence.
    *   Directly called by the Processor loop.
    *   Analyzes transcripts using a small, fast local LLM (Phi/Gemma).
    *   Updates the **SQLite** database (`tutor.db`) with SRS progress.

*   **`db/`**: The Persistence Layer.
    *   **Schema**: `users`, `units`, `lexemes`, `learning_progress`, `grammar_rules`, `duolingo_metadata`.
    *   **ORM**: Drizzle ORM over `better-sqlite3`.
    *   **File**: `tutor.db` (created in the root of this package).

## Setup & Running

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Database Initialization (Duolingo Sync)
The SQLite database is local. Instead of generic seeding, we sync your actual Duolingo progress.

```bash
# Sync Vocabulary & Skills (requires JWT)
npx tsx src/scripts/sync-duolingo.ts <your_user_id> --jwt <token> --username <duo_username> --lang ru
```

### 3. Configuration
Copy `.env.example` to `.env.local` and configure your ports:
```env
LOCAL_STT_URL=http://localhost:8000/v1
LOCAL_TTS_URL=http://localhost:8005
DEFAULT_TARGET_LANGUAGE=ru
```

### 4. Running the Agent
Start the event-driven tutor agent. It will connect to your LiveKit project.

```bash
# Using the helper script (Recommended)
../start_agent.sh

# Manual launch
pnpm dev:tutor-ed
```

### 5. Testing
You can use the [LiveKit Agents Playground](https://agents-playground.livekit.io/) to test your agent.
1.  Start the agent locally.
2.  Go to the Playground.
3.  Connect to your LiveKit room.
4.  The agent should greet you in Russian (or your target language).

## Customizing Content
The curriculum is driven by the database. To add custom words or grammar rules, you can manually insert them into the `lexemes` and `grammar_rules` tables in `tutor.db`, or use the Duolingo sync tool to keep it up to date.