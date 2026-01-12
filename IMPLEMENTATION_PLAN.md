# Implementation Plan - LangChain + Curriculum Redesign

## Current Problems

### 1. Duolingo Data Issues
```
✅ What Works:
- 919 lexemes synced from Duolingo
- 97 units with proper ordering
- SRS tracking functional

❌ What's Broken:
- All lexemes have pos="GENERAL" (not useful for linguistic analysis)
- No grammar rules, only vocabulary
- No sentence examples or context
- Unit structure doesn't reflect actual lesson content
- No skill levels (A1/A2/B1/etc.)
```

### 2. Conversation Memory Problem
```
❌ Current: 10-turn sliding window
- Loses context after 10 turns
- Can't reference earlier topics
- No long-term conversation coherence

✅ Needed: LangChain memory
- Summarizes older context
- Maintains coherence across session
- Enables curriculum planning based on full conversation
```

---

## Phase 1: LangChain Memory Integration (TODAY)
**Time:** 2-3 hours
**Goal:** Fix conversation flow with better memory

### 1.1 Create Memory Wrapper
**File:** `agents/src/lib/langchain-memory.ts`

```typescript
import { ConversationSummaryBufferMemory } from "langchain/memory";
import { ChatOllama } from "@langchain/ollama";
import { BaseMessage } from "@langchain/core/messages";

export class LingLangMemory {
  private memory: ConversationSummaryBufferMemory;
  private turnCount = 0;

  constructor() {
    this.memory = new ConversationSummaryBufferMemory({
      llm: new ChatOllama({
        baseUrl: process.env.LOCAL_LLM_URL || "http://localhost:11434",
        model: process.env.LOCAL_LLM_MODEL || "ministral-3:14b"
      }),
      memoryKey: "chat_history",
      returnMessages: true,
      maxTokenLimit: 2000, // ~10 recent turns + summary of older
    });
  }

  async addTurn(userContent: string, assistantContent: string): Promise<void> {
    this.turnCount++;
    await this.memory.saveContext(
      { input: userContent },
      { output: assistantContent }
    );
  }

  async getContext(): Promise<string> {
    const vars = await this.memory.loadMemoryVariables({});
    const messages = vars.chat_history as BaseMessage[];
    return messages
      .map(msg => `${msg._getType() === "human" ? "User" : "Tutor"}: ${msg.content}`)
      .join("\n");
  }

  async getSummary(): Promise<string> {
    const vars = await this.memory.loadMemoryVariables({});
    const messages = vars.chat_history as BaseMessage[];
    return messages.slice(-5).map(m => m.content).join(" ");
  }

  getTurnCount(): number {
    return this.turnCount;
  }
}
```

### 1.2 Integrate into tutor-event-driven.ts
**Replace:** Line ~62-100 (ConversationHistory class)
**With:** `import { LingLangMemory } from './lib/langchain-memory.js'`

**Changes:**
```typescript
// OLD
const history = new ConversationHistory();
history.addUserTurn(transcript);
history.addAssistantTurn(response);
const context = history.getContext();

// NEW
const memory = new LingLangMemory();
await memory.addTurn(userTranscript, agentResponse);
const context = await memory.getContext();
```

### 1.3 Test & Validate
- Start agent, have 15+ turn conversation
- Verify summary kicks in after ~10 turns
- Check context includes topics from beginning

---

## Phase 2: Curriculum Redesign (NEXT SESSION)
**Time:** Full day
**Goal:** Structured, pedagogically-sound curriculum

### 2.1 New Curriculum Structure

```typescript
// Core abstraction
interface CurriculumAdapter {
  name: string;

  // Sync curriculum into structured format
  sync(userId: string): Promise<CurriculumData>;

  // Get structured lesson plan
  getLessonPlan(userId: string, sessionType: SessionType): Promise<Lesson>;

  // Report progress back to source
  reportProgress?(userId: string, results: SessionResults): Promise<void>;
}

interface CurriculumData {
  units: Unit[];           // Organized by CEFR level & topic
  lexemes: Lexeme[];       // With proper POS, examples, difficulty
  grammar: GrammarRule[];  // Explicit grammar concepts
  phrases: Phrase[];       // Common expressions
}

interface Unit {
  id: string;
  name: string;
  level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  order: number;
  topic: string;           // "Restaurant", "Travel", "Past Tense"
  objectives: string[];    // "Learn 10 food words", "Use past tense"
  prerequisites: string[]; // Other unit IDs

  content: {
    vocabulary: string[];  // Lexeme IDs
    grammar: string[];     // Grammar rule IDs
    phrases: string[];     // Phrase IDs
  };
}

interface Lexeme {
  id: string;
  lemma: string;
  pos: POSTag;            // Proper linguistic tag
  translation: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  frequency: number;      // Rank in language (1 = most common)

  examples: Example[];
  gender?: string;        // for gendered languages
  conjugation?: ConjugationTable;
}

interface Example {
  sentence: string;
  translation: string;
  context: string;        // "Formal", "Informal", "Written"
}

interface GrammarRule {
  id: string;
  name: string;
  level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  explanation: string;
  examples: Example[];
  commonMistakes: string[];
}

interface Phrase {
  id: string;
  text: string;
  translation: string;
  context: string;        // When to use
  formality: 'formal' | 'neutral' | 'informal';
}
```

### 2.2 Duolingo Adapter Redesign

**Current:** `sync-duolingo.ts` just dumps raw API data
**New:** Parse Duolingo response into structured curriculum

```typescript
export class DuolingoAdapter implements CurriculumAdapter {
  name = 'duolingo';

  async sync(userId: string): Promise<CurriculumData> {
    // Fetch from Duolingo API
    const rawData = await this.fetchDuolingoData(userId);

    // Parse into structured format
    return {
      units: this.parseUnits(rawData.skills),
      lexemes: this.parseLexemes(rawData.vocabulary),
      grammar: this.extractGrammarRules(rawData.skills),
      phrases: this.extractPhrases(rawData.vocabulary),
    };
  }

  private parseUnits(skills: DuoSkill[]): Unit[] {
    return skills.map(skill => ({
      id: `duo-${skill.id}`,
      name: skill.name,
      level: this.inferCEFRLevel(skill),  // Map Duo levels to A1/A2/etc
      order: skill.position,
      topic: this.categorizeSkill(skill.name),
      objectives: this.extractObjectives(skill),
      prerequisites: this.findPrerequisites(skill, skills),
      content: {
        vocabulary: skill.words.map(w => `duo-lex-${w.id}`),
        grammar: this.detectGrammarRules(skill),
        phrases: this.detectPhrases(skill.words),
      }
    }));
  }

  private parseLexemes(vocabList: DuoVocabItem[]): Lexeme[] {
    return vocabList.map(item => ({
      id: `duo-lex-${item.id}`,
      lemma: item.word_string,
      pos: this.detectPOS(item),  // Use NLP library or Duo metadata
      translation: item.translation,
      difficulty: this.calculateDifficulty(item),
      frequency: item.frequency_rank || 9999,
      examples: this.generateExamples(item),
      // ... gender, conjugation if available
    }));
  }

  private extractGrammarRules(skills: DuoSkill[]): GrammarRule[] {
    // Extract explicit grammar concepts from skill names/descriptions
    const grammarSkills = skills.filter(s =>
      s.name.includes('Present') ||
      s.name.includes('Past') ||
      s.name.includes('Genitive') ||
      // ... other grammar indicators
    );

    return grammarSkills.map(skill => ({
      id: `duo-grammar-${skill.id}`,
      name: skill.name,
      level: this.inferCEFRLevel(skill),
      explanation: this.lookupGrammarExplanation(skill.name),
      examples: this.extractExamplesFromSkill(skill),
      commonMistakes: [],
    }));
  }
}
```

### 2.3 Fallback: FrequencyListAdapter

For languages without Duolingo:

```typescript
export class FrequencyListAdapter implements CurriculumAdapter {
  name = 'frequency';

  async sync(userId: string, language: string): Promise<CurriculumData> {
    // Use Wiktionary frequency lists + OpenRussian/etc
    const topWords = await this.fetchFrequencyList(language, 5000);

    return {
      units: this.groupIntoCEFRUnits(topWords),
      lexemes: this.enrichWithWiktionary(topWords),
      grammar: this.loadGrammarTemplates(language),
      phrases: this.loadCommonPhrases(language),
    };
  }

  private groupIntoCEFRUnits(words: Word[]): Unit[] {
    // A1: Top 500 words
    // A2: 501-1500
    // B1: 1501-3000
    // etc.

    const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    const ranges = [500, 1500, 3000, 5000, 8000, 12000];

    return levels.map((level, idx) => ({
      id: `freq-${level}`,
      name: `${level} Vocabulary`,
      level: level as any,
      order: idx,
      topic: 'General',
      objectives: [`Learn ${ranges[idx]} most common words`],
      prerequisites: idx > 0 ? [`freq-${levels[idx-1]}`] : [],
      content: {
        vocabulary: words.slice(
          idx === 0 ? 0 : ranges[idx-1],
          ranges[idx]
        ).map(w => w.id),
        grammar: [],
        phrases: [],
      }
    }));
  }
}
```

### 2.4 Database Schema Updates

```sql
-- Add to units table
ALTER TABLE units ADD COLUMN level TEXT; -- 'A1', 'A2', etc.
ALTER TABLE units ADD COLUMN topic TEXT;
ALTER TABLE units ADD COLUMN objectives TEXT; -- JSON array
ALTER TABLE units ADD COLUMN prerequisites TEXT; -- JSON array of unit IDs

-- Add to lexemes table
ALTER TABLE lexemes ADD COLUMN difficulty INTEGER; -- 1-5
ALTER TABLE lexemes ADD COLUMN frequency INTEGER; -- Rank
ALTER TABLE lexemes ADD COLUMN examples TEXT; -- JSON array
ALTER TABLE lexemes ADD COLUMN gender TEXT;

-- New tables
CREATE TABLE grammar_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  language TEXT NOT NULL,
  explanation TEXT,
  examples TEXT, -- JSON
  common_mistakes TEXT -- JSON
);

CREATE TABLE phrases (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  translation TEXT NOT NULL,
  language TEXT NOT NULL,
  context TEXT,
  formality TEXT -- 'formal' | 'neutral' | 'informal'
);

CREATE TABLE unit_content (
  unit_id TEXT REFERENCES units(id),
  content_id TEXT,
  content_type TEXT, -- 'lexeme', 'grammar', 'phrase'
  PRIMARY KEY (unit_id, content_id)
);
```

---

## Phase 3: Lesson Planning with LangChain (FUTURE)
**Time:** 1-2 days
**Goal:** Strategic curriculum sequencing

### 3.1 Vector Store for Content

```typescript
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { OllamaEmbeddings } from "@langchain/ollama";

// Index all curriculum content
const embeddings = new OllamaEmbeddings({
  baseUrl: "http://localhost:11434",
  model: "nomic-embed-text"
});

const curriculumStore = await MemoryVectorStore.fromDocuments(
  documents, // lexemes + grammar + phrases
  embeddings
);

// During conversation: retrieve relevant content
const relevantContent = await curriculumStore.similaritySearch(
  conversationSummary, // From LangChain memory
  10
);
```

### 3.2 Agent for Curriculum Planning

```typescript
import { initializeAgentExecutorWithOptions } from "langchain/agents";
import { DynamicTool } from "langchain/tools";

const tools = [
  new DynamicTool({
    name: "get_weak_lexemes",
    description: "Get words user struggles with (low SRS level)",
    func: async () => {
      const weak = await db.query.learningProgress.findMany({
        where: and(
          eq(learningProgress.userId, userId),
          lt(learningProgress.srsLevel, 3)
        )
      });
      return JSON.stringify(weak);
    }
  }),

  new DynamicTool({
    name: "get_next_unit_content",
    description: "Get vocabulary/grammar from next curriculum unit",
    func: async () => {
      const nextUnit = await getNextUnitForUser(userId);
      return JSON.stringify(nextUnit.content);
    }
  }),

  new DynamicTool({
    name: "search_relevant_content",
    description: "Find curriculum content related to conversation topic",
    func: async (topic: string) => {
      const results = await curriculumStore.similaritySearch(topic, 5);
      return JSON.stringify(results);
    }
  })
];

const planner = await initializeAgentExecutorWithOptions(
  tools,
  new ChatOllama({
    baseUrl: "http://localhost:11434",
    model: "ministral-3:14b"
  }),
  { agentType: "structured-chat-zero-shot-react-description" }
);

// Before each response: plan what to teach
const plan = await planner.call({
  input: `Conversation: ${conversationSummary}
          User just said: "${userInput}"
          What should I teach next to advance their learning?`
});
```

---

## Updated TODO

### ✅ DONE (This Session)
- [x] Processor validation with GENERAL pos fallback
- [x] European Portuguese language support
- [x] Ministral-3:14b upgrade with pre-warming
- [x] Conversation quality improvements (mixed mode)
- [x] JSON cleaning for LLM outputs
- [x] LangChain dependencies installed

### 🔨 IN PROGRESS (Today)
- [x] **LangChain Phase 1: Memory**
  - [x] Create LingLangMemory wrapper
  - [x] Integrate into tutor-event-driven.ts
  - [ ] Test with 15+ turn conversation
  - [ ] Validate buffer expansion works

### 📋 NEXT (This Week)
- [ ] **Curriculum Redesign**
  - [ ] Design new schema (units, lexemes, grammar, phrases)
  - [ ] Create CurriculumAdapter interface
  - [ ] Rewrite DuolingoAdapter with proper parsing
  - [ ] Add FrequencyListAdapter for non-Duo languages
  - [ ] Migrate existing data to new schema

### 🚀 FUTURE (Next Month)
- [ ] **LangChain Phase 2: Retrieval**
  - [ ] Vector store for curriculum content
  - [ ] Semantic search during conversation
  - [ ] Context-aware vocabulary introduction

- [ ] **LangChain Phase 3: Agent Planning**
  - [ ] Strategic teaching decisions
  - [ ] Balance review + new content dynamically
  - [ ] Multi-agent orchestration (Tutor/Reviewer/Grammar/Conversation)

- [ ] **Advanced Features**
  - [ ] Anki deck import
  - [ ] Custom CSV/JSON curriculum
  - [ ] CEFR-based auto-curriculum
  - [ ] Pronunciation practice mode
  - [ ] Grammar explanation mode

---

## Implementation Order

**TODAY (4-5 hours):**
1. ✅ LangChain Phase 1 (2-3h)
   - Memory wrapper
   - Integration
   - Testing

2. ✅ Curriculum Design Document (1-2h)
   - Schema design
   - Interface definitions
   - Migration plan

**TOMORROW:**
3. Database migration (3-4h)
   - Update schema
   - Migration script
   - Data preservation

4. DuolingoAdapter rewrite (4-5h)
   - Proper parsing
   - CEFR mapping
   - Grammar extraction

**NEXT WEEK:**
5. LangChain Phase 2 (1 day)
6. LangChain Phase 3 (2 days)
7. Testing & refinement (1-2 days)

---

## Decision Points

### 1. Should we keep existing Duolingo data?
**Options:**
- A) Migrate: Enhance with proper POS/structure (preserve progress)
- B) Re-sync: Fresh import with new parser (lose some progress)
- C) Hybrid: Keep progress, re-import curriculum only

**Recommendation:** Option A (Migration)
- Preserves user progress (910 SRS records)
- Can backfill missing data (POS, difficulty, etc.)
- Less disruptive

### 2. How to handle missing grammar explanations?
**Options:**
- A) Manual: Write explanations for common grammar topics
- B) LLM-generated: Use ministral-3:14b to generate on-demand
- C) Hybrid: Manual for A1/A2, LLM for advanced

**Recommendation:** Option C (Hybrid)
- Quality for basics (A1/A2 are critical)
- Scalable for advanced content
- Can improve LLM explanations over time

### 3. When to use LangChain agents?
**Options:**
- A) Always: Every response planned by agent
- B) Periodic: Every 5 turns (like processor)
- C) Adaptive: Only when curriculum decision needed

**Recommendation:** Option B (Periodic)
- Balances quality and latency
- Matches existing processor cadence
- User tested, known to work

---

**Ready to start Phase 1 implementation?**
