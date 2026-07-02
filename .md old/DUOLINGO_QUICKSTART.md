# Duolingo Integration - Quick Start Guide

## What Was Built

A complete Duolingo API integration for the LingLang tutoring system that:

✅ Authenticates with Duolingo using username/password
✅ Syncs vocabulary, skills, and progress data to your database
✅ Maps Duolingo strength (0-1.0) to your SRS levels (0-5)
✅ Provides a separate Duolingo-focused tutor agent
✅ Focuses practice on weak vocabulary items

## Files Created/Modified

### New Files
- `agents/src/lib/duolingoClient.ts` - HTTP client for Duolingo API
- `agents/src/tools/duolingo.ts` - 3 LLM tools (auth, sync, weak words)
- `agents/src/tutor_duolingo.ts` - Duolingo tutor agent
- `DUOLINGO_INTEGRATION_PLAN.md` - Full implementation plan

### Modified Files
- `agents/src/db/schema.ts` - Added `duolingoMetadata` table
- `agents/src/lib/context.ts` - Added `getInitialContextForDuolingo()` method
- `agents/package.json` - Added `dev:tutor-duolingo` script
- Database migrated with new table

### Existing App - Not Affected
✅ `agents/src/tutor.ts` - Unchanged
✅ `agents/src/db/schema.ts` - Only additions, no modifications to existing tables
✅ `pnpm dev:tutor` - Still works as before

## How to Test

### Prerequisites

1. **Duolingo Test Account**
   - Create a test account at duolingo.com
   - Complete 5-10 lessons in Russian (or any language)
   - Note the username and password

2. **Local Services Running**
   Make sure these are running:
   - STT (Faster Whisper): `http://localhost:8000/v1`
   - LLM (Ollama): `http://localhost:11434/v1`
   - TTS (Fish Speech): `http://localhost:8004/v1`
   - LiveKit server (if testing in cloud)

### Testing the Backend Tools

#### Option 1: Direct Tool Testing (Recommended First)

Create a test script to verify the tools work:

```typescript
// agents/test-duolingo.ts
import { authenticateDuolingo, syncDuolingoData, getDuolingoWeakWords } from './src/tools/duolingo.js';

const userId = 'test-user-123';
const duolingoUsername = 'YOUR_DUOLINGO_USERNAME';
const duolingoPassword = 'YOUR_DUOLINGO_PASSWORD';
const language = 'ru'; // or 'es', 'fr', etc.

async function test() {
  console.log('=== Testing Duolingo Integration ===\n');

  // Test 1: Authentication
  console.log('1. Testing authentication...');
  const authResult = await authenticateDuolingo.execute({
    userId,
    duolingoUsername,
    duolingoPassword,
    language,
  });
  console.log('Auth result:', authResult);

  if (!authResult.success) {
    console.error('Authentication failed! Check credentials.');
    return;
  }

  // Test 2: Sync Data
  console.log('\n2. Testing data sync...');
  const syncResult = await syncDuolingoData.execute({ userId });
  console.log('Sync result:', syncResult);

  // Test 3: Get Weak Words
  console.log('\n3. Testing weak words retrieval...');
  const weakWordsResult = await getDuolingoWeakWords.execute({
    userId,
    limit: 5
  });
  console.log('Weak words:', weakWordsResult);
}

test().catch(console.error);
```

Run it:
```bash
cd /home/will/Desktop/LingLang/agents
tsx test-duolingo.ts
```

#### Option 2: Database Inspection

After running the test above, check the database:

```bash
cd /home/will/Desktop/LingLang/agents
sqlite3 tutor.db

# Check metadata
SELECT * FROM duolingo_metadata;

# Check synced units (skills)
SELECT * FROM units WHERE id LIKE 'duo-%';

# Check synced vocabulary
SELECT COUNT(*) FROM lexemes WHERE id LIKE 'duo-%';

# Check learning progress
SELECT l.lemma, l.translation, lp.srsLevel
FROM learning_progress lp
JOIN lexemes l ON l.id = lp.lexemeId
WHERE lp.userId = 'test-user-123'
ORDER BY lp.srsLevel ASC
LIMIT 10;
```

### Testing the Full Agent

#### Step 1: Start the Duolingo Tutor

```bash
cd /home/will/Desktop/LingLang/agents
pnpm dev:tutor-duolingo
```

You should see:
```
[Duolingo Tutor] Prewarming VAD...
[Duolingo Tutor] VAD prewarmed successfully
[Worker] Agent ready and listening...
```

#### Step 2: Connect via LiveKit

Connect to the room using:
- LiveKit Playground
- Web app
- Mobile app

Your participant identity will be used as the `userId`.

#### Step 3: Conversation Flow

**First-time user:**
```
Agent: "Hi! I'm your Duolingo-powered language tutor. Ready to practice?"

User: "Yes, I want to practice my Russian from Duolingo."

Agent: "Great! To get started, I'll need your Duolingo credentials.
        What's your Duolingo username?"

User: "my-username"

Agent: "And your password?"

User: "my-password"

[Agent calls authenticateDuolingo tool]

Agent: "Successfully connected! Now let me sync your vocabulary..."

[Agent calls syncDuolingoData tool]

Agent: "Perfect! I found 47 words. Let's practice the ones you need help with."

[Agent calls getDuolingoWeakWords tool]

Agent: "I see you're learning 'привет'. Let's use it in conversation..."
```

**Returning user:**
```
Agent: "Hi! I'm your Duolingo-powered language tutor. Ready to practice?"

User: "Yes, let's practice."

Agent: "Great! Let me check which words need practice..."

[Agent calls getDuolingoWeakWords tool]

Agent: "You're working on 'спасибо' and 'пожалуйста'.
        How would you thank someone in Russian?"
```

## How the System Works

### Architecture

```
User → LiveKit → Duolingo Tutor Agent
                      ↓
         ┌────────────┼────────────┐
         ↓            ↓            ↓
   Auth Tool    Sync Tool    Weak Words Tool
         ↓            ↓            ↓
    Duolingo API  Duolingo API    Database
         ↓            ↓            ↓
      Store JWT   Store Vocab   Query SRS
         ↓            ↓            ↓
      Database     Database     Return List
```

### Data Flow

1. **Authentication:**
   - User provides Duolingo credentials
   - Tool calls Duolingo `/login` endpoint
   - JWT stored in `duolingo_metadata` table
   - JWT reused for subsequent calls

2. **Sync:**
   - Tool fetches vocabulary from `/vocabulary/overview`
   - Tool fetches skills from `/users/<id>` endpoint
   - Skills → `units` table (curriculum structure)
   - Vocabulary → `lexemes` table
   - Strength mapping → `learning_progress` table
   - Sync timestamp recorded

3. **Practice:**
   - Tool queries `learning_progress` for low SRS levels (0-2)
   - Returns words with strength < 0.6
   - Agent uses these words in conversation
   - (Future: feedback updates SRS levels)

### Strength to SRS Mapping

| Duolingo Strength | Description | SRS Level | Next Review |
|-------------------|-------------|-----------|-------------|
| 0.0 - 0.2 | New | 0 | 1 day |
| 0.2 - 0.4 | Learning | 1 | 2 days |
| 0.4 - 0.6 | Reviewing | 2 | 4 days |
| 0.6 - 0.8 | Familiar | 3 | 8 days |
| 0.8 - 0.95 | Well Known | 4 | 16 days |
| 0.95 - 1.0 | Mastered | 5 | 32 days |

## Troubleshooting

### Issue: "Invalid Duolingo credentials"

**Cause:** Username/password incorrect or Duolingo changed their auth endpoint

**Solutions:**
- Verify credentials by logging in at duolingo.com
- Check if Duolingo shows CAPTCHA (may need to auth via browser first)
- Check console logs for exact error from Duolingo API

### Issue: "Not authenticated. Call authenticate() first."

**Cause:** JWT not stored or expired

**Solutions:**
- Re-authenticate using the tool
- Check `duolingo_metadata` table for stored JWT
- Verify JWT is not expired (check `lastSyncTimestamp`)

### Issue: "No vocabulary found"

**Cause:** User's Duolingo account has no completed lessons

**Solutions:**
- Complete 3-5 lessons on Duolingo
- Try syncing with a different language code
- Check Duolingo API response in logs

### Issue: Agent not calling tools

**Cause:** LLM not deciding to use tools based on instructions

**Solutions:**
- Be more explicit in conversation: "Please sync my Duolingo data"
- Check agent instructions for clarity
- Verify tools are registered in agent config
- Check LLM model supports function calling (ministral does)

### Issue: Database errors

**Cause:** Schema mismatch or missing tables

**Solutions:**
```bash
cd /home/will/Desktop/LingLang/agents
npx drizzle-kit push
```

## Next Steps

### Immediate Improvements

1. **Add Translation Fetching**
   Currently translations are placeholder `"(Duolingo import - translation pending)"`
   - Could fetch from Duolingo dictionary API
   - Could integrate Google Translate API
   - Could allow manual entry via web UI

2. **Dynamic Language Support**
   Currently hardcoded to Russian
   - Pass language code from metadata to STT/TTS
   - Maintain separate voice files per language
   - Update agent instructions per language

3. **Auto-Sync on Session Start**
   Add logic to automatically sync if data is stale (>24 hours)

4. **Feedback Loop**
   Connect supervisor tool to update SRS levels based on practice

### Web App Integration

When you build the web app:

1. **Settings Page**
   - "Connect Duolingo" button
   - Calls `POST /api/duolingo/auth` → authenticateDuolingo tool
   - Shows sync status and last sync time

2. **Dashboard**
   - Display vocabulary count
   - Show weak words
   - Trigger manual sync

3. **Security**
   - Encrypt passwords before storing
   - Add `DUOLINGO_ENCRYPTION_KEY` to .env
   - Consider OAuth if Duolingo adds official API

## Security Notes

⚠️ **Current Implementation (Development Only):**
- Passwords stored in plaintext in database
- No rate limiting
- No encryption

🔒 **Before Production:**
1. Add password encryption (AES-256)
2. Add rate limiting for Duolingo API calls
3. Add authentication for web API endpoints
4. Consider using Duolingo OAuth (if available)
5. Add CSRF protection
6. Sanitize all user inputs

## API Reference

### Tool: `authenticateDuolingo`

**Parameters:**
- `userId` (string) - LingLang user ID
- `duolingoUsername` (string) - Duolingo username/email
- `duolingoPassword` (string) - Duolingo password
- `language` (string) - Language code (e.g., "ru", "es")

**Returns:**
```typescript
{
  success: boolean,
  message: string
}
```

### Tool: `syncDuolingoData`

**Parameters:**
- `userId` (string) - LingLang user ID

**Returns:**
```typescript
{
  success: boolean,
  message: string,
  stats?: {
    newWords: number,
    updatedWords: number,
    newSkills: number,
    totalVocab: number
  }
}
```

### Tool: `getDuolingoWeakWords`

**Parameters:**
- `userId` (string) - LingLang user ID
- `limit` (number) - Max words to return (default: 5)

**Returns:**
```typescript
{
  weakWords: Array<{
    word: string,
    translation: string,
    pos: string,
    srsLevel: number,
    strengthDescription: string,
    lastSeen: string
  }>,
  count: number,
  message: string
}
```

## Support

If you encounter issues:
1. Check console logs for detailed error messages
2. Verify database schema is up to date
3. Test tools directly before testing in agent
4. Check Duolingo API status (unofficial API may change)
5. Review full implementation plan in `DUOLINGO_INTEGRATION_PLAN.md`
