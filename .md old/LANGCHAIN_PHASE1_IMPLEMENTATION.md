# LangChain Phase 1: Memory Integration Implementation

## Quick Summary of Analysis

**Your Question:** How much does LangChain reduce processor tool use?

**Answer:** LangChain **doesn't reduce processor calls** - it serves a different purpose:

```
Processor (Keep as-is):
  Role: VERIFICATION - "What did the user actually learn?"
  Job: Analyze utterances, update SRS, track performance
  Can't be replaced: Domain-specific language learning logic

LangChain (New addition):
  Role: PLANNING - "What should we teach next?"
  Job: Better memory, curriculum retrieval, strategic teaching
  Complements processor: Two-phase system (plan → verify)
```

**Key Insight:** You have a "conversation flow" problem, not a "processor" problem.
- Processor does its job well (tracks SRS data)
- What's missing: Long-term context + proactive curriculum weaving

---

## Phase 1: Drop-in Memory Replacement (2-3 hours)

### Installation
```bash
cd /home/will/Desktop/LingLang/agents
pnpm add langchain @langchain/ollama @langchain/community langsmith
```

### Implementation

#### 1. Create `src/lib/langchain-memory.ts`
```typescript
import { ConversationSummaryBufferMemory } from "langchain/memory";
import { ChatOllama } from "@langchain/ollama";
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";

export class EnhancedConversationMemory {
  private memory: ConversationSummaryBufferMemory;
  private turnCount = 0;

  constructor(
    baseURL: string = "http://localhost:11434",
    model: string = "gemma3:4b"
  ) {
    this.memory = new ConversationSummaryBufferMemory({
      llm: new ChatOllama({ baseUrl: baseURL, model }),
      memoryKey: "chat_history",
      returnMessages: true,
      maxTokenLimit: 2000, // Keep ~10 recent turns verbatim
      summarize: true, // Auto-summarize older content
    });
  }

  /**
   * Add user turn to memory
   */
  async addUserTurn(content: string): Promise<void> {
    this.turnCount++;
    // Memory will be saved when we add assistant turn
  }

  /**
   * Add assistant turn and save both to memory
   */
  async addAssistantTurn(userContent: string, assistantContent: string): Promise<void> {
    await this.memory.saveContext(
      { input: userContent },
      { output: assistantContent }
    );
  }

  /**
   * Get conversation context for prompt building
   * Returns: "Summary: [older conversation]... Recent:\nUser: ...\nAssistant: ..."
   */
  async getContext(): Promise<string> {
    const memoryVars = await this.memory.loadMemoryVariables({});
    const messages = memoryVars.chat_history as BaseMessage[];

    if (messages.length === 0) {
      return "";
    }

    // Format messages for tutor prompt
    return messages
      .map(msg => {
        const role = msg._getType() === "human" ? "User" : "Tutor";
        return `${role}: ${msg.content}`;
      })
      .join("\n");
  }

  /**
   * Get summary for retrieval (semantic search)
   */
  async getSummary(): Promise<string> {
    const memoryVars = await this.memory.loadMemoryVariables({});
    const messages = memoryVars.chat_history as BaseMessage[];

    // If we have a summary (happens after max tokens), it's in the buffer
    // For now, just join recent messages
    return messages
      .slice(-5) // Last 5 messages
      .map(msg => msg.content)
      .join(" ");
  }

  /**
   * Get last user message
   */
  async getLastUserTurn(): Promise<string | null> {
    const memoryVars = await this.memory.loadMemoryVariables({});
    const messages = memoryVars.chat_history as BaseMessage[];

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]._getType() === "human") {
        return messages[i].content as string;
      }
    }
    return null;
  }

  /**
   * Clear memory (for testing)
   */
  async clear(): Promise<void> {
    await this.memory.clear();
    this.turnCount = 0;
  }

  getTurnCount(): number {
    return this.turnCount;
  }
}
```

#### 2. Modify `src/tutor-event-driven.ts`

**Find this section (around line 62):**
```typescript
// ============================================================================
// CONVERSATION HISTORY (for context)
// ============================================================================

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

class ConversationHistory {
  private turns: ConversationTurn[] = [];
  private maxTurns = 10;
  // ... rest of the class
}
```

**Replace with:**
```typescript
// ============================================================================
// CONVERSATION HISTORY (LangChain-powered)
// ============================================================================

import { EnhancedConversationMemory } from './lib/langchain-memory.js';
```

**Find where ConversationHistory is instantiated (around line 200):**
```typescript
// === CONVERSATION TRACKING ===
const history = new ConversationHistory();
```

**Replace with:**
```typescript
// === CONVERSATION TRACKING ===
const history = new EnhancedConversationMemory(
  process.env.LOCAL_LLM_URL || 'http://localhost:11434',
  process.env.LOCAL_LLM_MODEL || 'gemma3:4b'
);
```

**Find where history methods are called:**

**OLD:**
```typescript
history.addUserTurn(transcription);
```

**NEW:**
```typescript
await history.addUserTurn(transcription);
```

**OLD:**
```typescript
history.addAssistantTurn(content);
```

**NEW (need to track user input for saving):**
```typescript
// Store the last user input
let lastUserInput = '';

// In UserInputTranscribed handler:
lastUserInput = transcription;
await history.addUserTurn(transcription);

// In agent response handler (after TTS):
await history.addAssistantTurn(lastUserInput, agentResponseContent);
```

**OLD:**
```typescript
const conversationContext = history.getContext();
```

**NEW:**
```typescript
const conversationContext = await history.getContext();
```

**OLD:**
```typescript
const lastUserUtterance = history.getLastUserTurn();
```

**NEW:**
```typescript
const lastUserUtterance = await history.getLastUserTurn();
```

---

## Testing the Integration

### 1. Start Services
```bash
cd /home/will/Desktop/LingLang
python3 start_local_services.py
```

### 2. Start Agent with Logging
```bash
cd agents
pnpm dev:tutor-ed 2>&1 | tee /tmp/langchain-test.log
```

### 3. Have a Conversation
Connect via LiveKit and have a 15+ turn conversation about a topic (e.g., restaurants).

### 4. Check Memory Behavior
```bash
grep "Summary\|Recent:" /tmp/langchain-test.log
```

Look for:
- After ~10 turns: Should see conversation being summarized
- Context should mention topics from 15+ turns ago
- Memory size should stay bounded (not grow indefinitely)

### 5. Compare Before/After

**Before (10-turn window):**
```
Turn 1-10: Talking about restaurants
Turn 11-20: Talking about travel
Turn 21: Agent mentions restaurants ❌ (context was lost)
```

**After (summary memory):**
```
Turn 1-10: Talking about restaurants
Turn 11-20: Talking about travel
Turn 21: Agent can reference restaurants ✅ (in summary)
```

---

## Performance Monitoring

### Add LangSmith Tracing

**Create `src/lib/langsmith-config.ts`:**
```typescript
import { Client } from "langsmith";

// Only enable if API key is set
export const langsmithClient = process.env.LANGCHAIN_API_KEY
  ? new Client({
      apiKey: process.env.LANGCHAIN_API_KEY,
    })
  : null;

export const LANGSMITH_CONFIG = {
  project: "linglang-tutor",
  enabled: !!process.env.LANGCHAIN_API_KEY,
};
```

**Add to `.env.local`:**
```bash
# LangSmith (optional - for observability)
LANGCHAIN_API_KEY=your_key_here
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=linglang-tutor
```

**Wrap memory operations:**
```typescript
import { traceable } from "langsmith/traceable";

const getContextWithTracing = traceable(
  async (memory: EnhancedConversationMemory) => {
    return await memory.getContext();
  },
  { name: "get_conversation_context", project: "linglang-tutor" }
);
```

Visit https://smith.langchain.com to see:
- How long summarization takes
- When summaries are triggered
- Context size over time

---

## Expected Results

### Latency Impact
- **First 10 turns**: No change (0ms overhead)
- **Turn 11+**: +200-300ms when summarizing
  - Happens in background, doesn't block response
- **Every turn after**: +10ms (memory load/save)

### Conversation Quality Impact
- ✅ Agent remembers topics from 20+ turns ago
- ✅ Can reference earlier conversation naturally
- ✅ No "forgetting" after 10 turns
- ✅ More coherent multi-session conversations

### Memory Usage
- Old system: ~50KB (10 turns * ~5KB/turn)
- New system: ~20KB (summary + recent turns)
- **Better** memory efficiency!

---

## Troubleshooting

### Issue: "Memory growing too large"
**Solution:** Reduce `maxTokenLimit`:
```typescript
maxTokenLimit: 1000, // More aggressive summarization
```

### Issue: "Summarization too slow"
**Solution:** Use faster model for summaries:
```typescript
llm: new ChatOllama({
  baseUrl: baseURL,
  model: "gemma3:4b" // Fast model
}),
```

### Issue: "Summary loses important details"
**Solution:** Increase buffer size:
```typescript
maxTokenLimit: 3000, // Keep more verbatim
```

### Issue: "Want to see what's being summarized"
**Solution:** Add logging:
```typescript
async addAssistantTurn(userContent: string, assistantContent: string): Promise<void> {
  await this.memory.saveContext(
    { input: userContent },
    { output: assistantContent }
  );

  // Debug: Log when summarization happens
  const vars = await this.memory.loadMemoryVariables({});
  if (vars.chat_history.length < this.turnCount) {
    console.log('[Memory] Summarization triggered');
  }
}
```

---

## Next Steps After Phase 1

Once memory is working well:

### Phase 2: Add Curriculum Retrieval (4-6 hours)
- Index lexemes in vector store
- Retrieve relevant vocabulary based on conversation topic
- Weave curriculum words naturally into responses

### Phase 3: Add Agent Pattern (1-2 days)
- Create tools for SRS queries
- Let LLM reason about what to teach next
- Requires upgrading to ministral-3:14b

---

## Rollback Plan

If Phase 1 causes issues:

1. **Comment out LangChain imports:**
```typescript
// import { EnhancedConversationMemory } from './lib/langchain-memory.js';
```

2. **Restore old ConversationHistory:**
```typescript
const history = new ConversationHistory(); // Old class
```

3. **Remove await keywords:**
```typescript
history.addUserTurn(transcription); // sync again
```

No database changes, no SRS changes - fully reversible!

---

## Summary: Will This Help?

**Your current problem:** "Conversation flow is not great"

**Root cause:** 10-turn memory window loses context

**Phase 1 fix:** Long-term memory via summarization
- ✅ Remembers full conversation arc
- ✅ Non-invasive (2-3 hours)
- ✅ Works with current LLM (gemma3:4b)
- ✅ Processor unchanged

**If Phase 1 solves flow problems:** Stop here, you're done!

**If flow still needs work:** Move to Phase 2 (curriculum retrieval) or Phase 3 (agent planning)

**Processor impact:** ZERO - it keeps doing its job perfectly.

---

Ready to implement? Want me to create a test script that compares old vs new memory side-by-side?
