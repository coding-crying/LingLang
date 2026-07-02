# Duolingo Authentication Workaround

## The Challenge

Duolingo's unofficial API has become more restrictive and now requires:
- CSRF tokens for the web login endpoint
- Browser cookies and session management
- Potentially CAPTCHA solving

The simple POST to `/login` no longer works for programmatic access.

## Temporary Solutions

### Option 1: Manual JWT Extraction (Recommended for Testing)

1. **Login to Duolingo in your browser**
   - Go to https://www.duolingo.com
   - Login with your credentials

2. **Extract the JWT token**
   - Open Developer Tools (F12)
   - Go to Application → Cookies → https://www.duolingo.com
   - Find the `jwt_token` cookie
   - Copy its value

3. **Use the JWT directly in the database**

```bash
cd /home/will/Desktop/LingLang/agents
sqlite3 tutor.db

INSERT INTO users (id, created_at, target_language, native_language, proficiency_level)
VALUES ('test-user', 1735127000000, 'ru', 'en', 'beginner');

INSERT INTO duolingo_metadata (
  user_id, duolingo_username, duolingo_jwt, duolingo_user_id,
  learning_language, created_at, updated_at, sync_status
)
VALUES (
  'test-user',
  'wilherman21@gmail.com',
  'YOUR_JWT_TOKEN_HERE',  -- Paste the JWT from browser
  'wilherman21@gmail.com',
  'ru',
  1735127000000,
  1735127000000,
  'pending'
);
```

4. **Test the sync tool directly**

```typescript
// test-duolingo-sync.ts
import { syncDuolingoData, getDuolingoWeakWords } from './src/tools/duolingo.js';

const userId = 'test-user';

// Skip auth, go straight to sync (JWT already in DB)
const syncResult = await syncDuolingoData.execute({ userId });
console.log('Sync result:', syncResult);

const weakWords = await getDuolingoWeakWords.execute({ userId, limit: 10 });
console.log('Weak words:', weakWords);
```

### Option 2: Browser Automation (Future Implementation)

For production, consider using Puppeteer or Playwright:

```typescript
import puppeteer from 'puppeteer';

async function authenticateWithBrowser(username: string, password: string) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://www.duolingo.com/login');
  await page.type('input[type="email"]', username);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');

  // Wait for redirect
  await page.waitForNavigation();

  // Extract JWT from cookies
  const cookies = await page.cookies();
  const jwtCookie = cookies.find(c => c.name === 'jwt_token');

  await browser.close();

  return jwtCookie?.value;
}
```

### Option 3: Use Duolingo API Wrapper

Some community packages handle auth complexity:
- `duolingo-api` (npm) - May be outdated
- Direct GraphQL API endpoints (if available)

## Simpler Alternative: Mock Data for Testing

For immediate testing of the agent and conversation flow, create mock data:

```bash
# Create test script: create-mock-duolingo-data.ts
import { db } from './src/db/index.js';
import { users, units, lexemes, learningProgress } from './src/db/schema.js';

const userId = 'test-user';

// Create user
await db.insert(users).values({
  id: userId,
  createdAt: Date.now(),
  targetLanguage: 'ru',
  nativeLanguage: 'en',
  proficiencyLevel: 'beginner',
});

// Create mock Duolingo unit
await db.insert(units).values({
  id: 'duo-ru-basics',
  title: 'Basics',
  description: 'Duolingo Basics skill',
  language: 'ru',
  order: 0,
  difficulty: 'beginner',
});

// Create mock vocabulary
const mockVocab = [
  { word: 'привет', translation: 'hello', pos: 'INTJ', strength: 0.3 },
  { word: 'спасибо', translation: 'thank you', pos: 'INTJ', strength: 0.5 },
  { word: 'да', translation: 'yes', pos: 'PART', strength: 0.8 },
  { word: 'нет', translation: 'no', pos: 'PART', strength: 0.2 },
  { word: 'пожалуйста', translation: 'please/you\'re welcome', pos: 'INTJ', strength: 0.4 },
];

for (const vocab of mockVocab) {
  const lexemeId = `duo-ru-${vocab.word}-${vocab.pos}`;

  await db.insert(lexemes).values({
    id: lexemeId,
    lemma: vocab.word,
    pos: vocab.pos,
    language: 'ru',
    translation: vocab.translation,
    unitId: 'duo-ru-basics',
  });

  await db.insert(learningProgress).values({
    userId,
    lexemeId,
    srsLevel: Math.floor(vocab.strength * 5),
    lastSeen: Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000,
    nextReview: Date.now() + Math.random() * 7 * 24 * 60 * 60 * 1000,
    encounters: Math.floor(Math.random() * 10) + 1,
    correctUses: Math.floor(Math.random() * 5),
  });
}

console.log('Mock Duolingo data created!');
```

Run it:
```bash
npx tsx create-mock-duolingo-data.ts
```

Then test the agent:
```bash
pnpm dev:tutor-duolingo
```

The agent will have vocabulary to work with and you can test the conversation flow!

## Long-term Solutions

1. **Build web app with OAuth-like flow**
   - User authenticates in browser
   - Web app stores JWT in database
   - Agent reads from database

2. **Contact Duolingo**
   - Request official API access
   - Partner program for educational use

3. **Alternative data sources**
   - Allow manual vocabulary input
   - Import from other platforms (Anki, Memrise)
   - User-created curriculum

## Current Status

✅ Database schema complete
✅ Sync logic complete
✅ Agent implementation complete
✅ Context management complete
⚠️  Authentication requires browser-based workaround

The backend is 100% ready - we just need a JWT token to test it!
