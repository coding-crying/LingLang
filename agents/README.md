# LingLang Agent Implementation

This directory contains the **Node.js** implementation of the LingLang conversational tutor.

## Architecture

This implementation uses the **LiveKit Agents Framework** to orchestrate a voice-based learning experience.

### Key Components

*   **`tutor.ts`**: The main agent definition.
    *   It initializes the `VoicePipelineAgent` using `gpt-4o-realtime-preview`.
    *   It loads a `ContextManager` to inject user-specific goals (e.g., "Review these 3 words") into the system prompt.
    *   It defines the `analyzeConversationTurn` tool.

*   **`tools/supervisor.ts`**: The pedagogical intelligence.
    *   Defined as a standard function-calling tool.
    *   When the Tutor invokes this tool (e.g., after a user sentence), it makes a *separate, cheap* call to `gpt-4o-mini`.
    *   This "Supervisor" LLM analyzes the grammar and returns structured feedback (JSON).
    *   The tool then updates the **SQLite** database with the user's performance (SRS updates).

*   **`db/`**: The Persistence Layer.
    *   **Schema**: `users`, `units`, `lexemes`, `learning_progress`, `grammar_rules`.
    *   **ORM**: Drizzle ORM over `better-sqlite3`.
    *   **File**: `tutor.db` (created in the root of this package).

## Setup & Running

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Database Migration
The SQLite database is local. You must initialize it before running the agent.

```bash
# Apply Schema
pnpm drizzle-kit push

# Seed Data (Curriculum)
pnpm dlx tsx src/db/seed.ts
```

### 3. Development
Start the agent in development mode. It will connect to your LiveKit project and wait for a user to join a room.

```bash
# Ensure you have your .env variables set!
node --loader ts-node/esm src/tutor.ts dev
```

### 4. Testing
You can use the [LiveKit Agents Playground](https://agents-playground.livekit.io/) to test your agent.
1.  Start the agent locally (`... src/tutor.ts dev`).
2.  Go to the Playground.
3.  Connect to your LiveKit room.
4.  The agent should join and greet you based on the `seed.ts` data ("Basics & Greetings").

## Customizing Content
To add more languages or units, edit `src/db/seed.ts` and re-run the seed command (it uses `ON CONFLICT DO NOTHING` so it's safe to run multiple times).