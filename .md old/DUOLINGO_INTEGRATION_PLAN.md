# Duolingo API Integration - Implementation Plan

## Overview

This document outlines the implementation plan for integrating Duolingo's unofficial API with the LingLang LiveKit agents tutoring system. The integration will:

- Authenticate users with Duolingo using username/password
- Fetch vocabulary, skills, and progress data
- Sync data to existing database schema (units, lexemes, learningProgress)
- Create a specialized Duolingo-focused tutor agent
- Map Duolingo strength (0-1.0) to SRS levels (0-5)

## Architecture Decisions

### Tools Approach
**3 separate tools** (following existing single-purpose pattern):
1. `authenticateDuolingo` - Login and store JWT token
2. `syncDuolingoData` - Fetch and sync all vocabulary/skills to database
3. `getDuolingoWeakWords` - Get words with low strength for targeted practice

### Database Strategy
**Reuse existing schema** with one new table:
- **Existing tables**: `units` (skills), `lexemes` (vocabulary), `learningProgress` (SRS state)
- **New table**: `duolingoMetadata` (auth tokens, sync state)

### Agent Pattern
**Separate agent file** (`tutor_duolingo.ts`) for clean separation and easier testing

## Duolingo API Endpoints

| Endpoint | Method | Purpose | Returns |
|----------|--------|---------|---------|
| `/login` | POST | Authenticate | JWT token, user_id |
| `/vocabulary/overview` | GET | Get vocabulary list | vocab_overview array |
| `/2017-06-30/users/<user_id>` | GET | Get user data & skills | skills, lessons, progress |

### Strength to SRS Mapping
```
Duolingo strength (0.0 - 1.0) → LingLang srsLevel (0 - 5)

0.0 - 0.2   → 0 (New)
0.2 - 0.4   → 1 (Learning)
0.4 - 0.6   → 2 (Reviewing)
0.6 - 0.8   → 3 (Familiar)
0.8 - 0.95  → 4 (Well Known)
0.95 - 1.0  → 5 (Mastered)
```

## File Structure

```
agents/
├── src/
│   ├── lib/
│   │   ├── context.ts (MODIFY - add getInitialContextForDuolingo)
│   │   └── duolingoClient.ts (NEW - HTTP client wrapper)
│   ├── tools/
│   │   ├── supervisor.ts (existing)
│   │   └── duolingo.ts (NEW - 3 tools)
│   ├── db/
│   │   └── schema.ts (MODIFY - add duolingoMetadata table)
│   ├── tutor.ts (existing - Russian tutor)
│   └── tutor_duolingo.ts (NEW - Duolingo tutor agent)
├── package.json (MODIFY - add dev:tutor-duolingo script)
└── .env.local (MODIFY - add DUOLINGO_ENCRYPTION_KEY)
```

## Implementation Sequence

### Phase 1: Dependencies & Database (30 min)
1. Install axios: `pnpm add axios`
2. Add `duolingoMetadata` table to `schema.ts`
3. Run migration: `npx drizzle-kit push:sqlite`

### Phase 2: Core Infrastructure (2 hours)
4. Create `lib/duolingoClient.ts` - HTTP client for Duolingo API
5. Create `tools/duolingo.ts` - All 3 tools implementation
6. Test tools in isolation with real Duolingo account

### Phase 3: Context Integration (1 hour)
7. Add `getInitialContextForDuolingo()` to `lib/context.ts`
8. Test context generation with seeded data

### Phase 4: Agent Implementation (2 hours)
9. Create `tutor_duolingo.ts` - Complete agent
10. Add `dev:tutor-duolingo` script to `package.json`
11. Test end-to-end flow

### Phase 5: Polish & Testing (1 hour)
12. Add error handling and logging
13. Add auto-sync logic
14. Manual testing checklist

## Key Code Snippets

### 1. Database Schema Addition

```typescript
// Add to agents/src/db/schema.ts

export const duolingoMetadata = sqliteTable('duolingo_metadata', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id),

  duolingoUsername: text('duolingo_username').notNull(),
  duolingoJWT: text('duolingo_jwt'),

  lastSyncTimestamp: integer('last_sync_timestamp'),
  syncStatus: text('sync_status').default('pending'),
  syncError: text('sync_error'),

  duolingoUserId: text('duolingo_user_id'),
  learningLanguage: text('learning_language').notNull(),

  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const duolingoMetadataRelations = relations(duolingoMetadata, ({ one }) => ({
  user: one(users, {
    fields: [duolingoMetadata.userId],
    references: [users.id],
  }),
}));
```

### 2. Duolingo Client Pattern

```typescript
// agents/src/lib/duolingoClient.ts

export class DuolingoClient {
  private baseURL = 'https://www.duolingo.com';
  private jwt: string | null = null;

  async authenticate(username: string, password: string): Promise<{ jwt: string; userId: string }> {
    const response = await axios.post(`${this.baseURL}/login`, {
      login: username,
      password: password
    });

    this.jwt = response.headers['jwt'] || response.data.jwt;
    return { jwt: this.jwt, userId: response.data.user_id };
  }

  async getVocabulary(language: string): Promise<DuolingoVocabItem[]> {
    const response = await axios.get(`${this.baseURL}/vocabulary/overview`, {
      params: { language },
      headers: { 'Authorization': `Bearer ${this.jwt}` }
    });
    return response.data.vocab_overview || [];
  }
}
```

### 3. Tool Registration Pattern

```typescript
// In tutor_duolingo.ts

import {
  authenticateDuolingo,
  syncDuolingoData,
  getDuolingoWeakWords
} from './src/tools/duolingo.js';

const agent = new voice.Agent({
  instructions: `You are a language tutor powered by Duolingo...`,
  tools: {
    authenticateDuolingo,
    syncDuolingoData,
    getDuolingoWeakWords,
  },
  // ... other config
});
```

### 4. Agent Workflow

```
1st Session:
  User → "I want to practice"
  Agent → Ask for Duolingo credentials
  User → Provides username/password
  Agent → Calls authenticateDuolingo tool
  Agent → Calls syncDuolingoData tool
  Agent → Begins practice with synced vocabulary

Subsequent Sessions:
  Agent → Auto-check if sync needed (24h threshold)
  Agent → Calls getDuolingoWeakWords tool
  Agent → Focuses practice on low-strength words
```

## Testing Strategy

### Manual Testing Checklist

**Phase 1: Backend Testing**
- [ ] Install dependencies
- [ ] Database migration succeeds
- [ ] `authenticateDuolingo` with valid credentials → JWT stored
- [ ] `syncDuolingoData` → units/lexemes/learningProgress populated
- [ ] Verify strength → SRS mapping (sample 10 words)
- [ ] `getDuolingoWeakWords` → returns low SRS words
- [ ] Test error handling (invalid password, network failure)

**Phase 2: Agent Testing**
- [ ] Run `pnpm dev:tutor-duolingo`
- [ ] Connect to LiveKit room
- [ ] Test authentication flow in conversation
- [ ] Test sync flow in conversation
- [ ] Verify agent uses weak words in practice
- [ ] Test with empty Duolingo account

### Test Duolingo Account Setup
1. Create test account at duolingo.com
2. Complete 5-10 Russian lessons
3. Note username/password for testing
4. **Never commit credentials to git**

## Environment Variables

Add to `agents/.env.local`:

```bash
# Duolingo Integration (for future encryption)
DUOLINGO_ENCRYPTION_KEY=your-secure-key-here
```

## Edge Cases & Error Handling

| Scenario | Handling Strategy |
|----------|------------------|
| Invalid credentials | Return error message, prompt retry |
| Empty Duolingo account | Inform user to complete lessons first |
| JWT expires | Detect 401 error, prompt re-authentication |
| Network failure | Retry with exponential backoff (3 attempts) |
| Sync during conversation | Non-blocking, continue on failure |

## Future Extensibility: Web App

When building the web app, these backend tools are ready to use:

```typescript
// Future web API route
// app/api/duolingo/sync/route.ts

import { syncDuolingoData } from '@/agents/src/tools/duolingo';

export async function POST(request: Request) {
  const { userId } = await request.json();
  const result = await syncDuolingoData.execute({ userId });
  return Response.json(result);
}
```

## Security Considerations

**Current (MVP):**
- Store credentials in database for testing
- Use environment variables for sensitive keys

**Production TODO:**
- Encrypt passwords with AES-256
- Use `DUOLINGO_ENCRYPTION_KEY` from environment
- Consider OAuth if official API becomes available
- Rate limiting on sync operations

## Package.json Script Addition

```json
{
  "scripts": {
    "dev:tutor": "tsx src/tutor.ts dev",
    "dev:tutor-duolingo": "tsx src/tutor_duolingo.ts dev"
  }
}
```

## Success Criteria

✅ User can authenticate with Duolingo credentials
✅ Vocabulary syncs to database with correct SRS mapping
✅ Agent uses synced data for personalized practice
✅ Weak words identified and prioritized
✅ System handles errors gracefully
✅ Works with users starting from scratch

## Next Steps

1. Review this plan
2. Create feature branch: `git checkout -b feature/duolingo-integration`
3. Follow implementation sequence (Phase 1 → Phase 5)
4. Test thoroughly before merging
5. Document any API changes discovered during implementation

## References

- [Duolingo API Endpoints](https://tschuy.com/duolingo/api/endpoints.html)
- [Duolingo API Data Structures](https://tschuy.com/duolingo/api/data.html)
- Existing tool pattern: `agents/src/tools/supervisor.ts`
- Existing agent pattern: `agents/src/tutor.ts`
- Existing context pattern: `agents/src/lib/context.ts`
