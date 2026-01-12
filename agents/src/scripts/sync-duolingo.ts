import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { performDuolingoSync, authenticateDuolingo } from '../tools/duolingo.js';
import { db } from '../db/index.js';
import { users, duolingoMetadata } from '../db/schema.js';
import { eq } from 'drizzle-orm';

function extractUserIdFromJwt(token: string): string | null {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    
    const payloadStr = Buffer.from(payloadPart, 'base64').toString('utf-8');
    const payload = JSON.parse(payloadStr);
    
    // 'sub' is standard for Subject (User ID)
    return payload.sub ? String(payload.sub) : null;
  } catch (e) {
    console.error('Failed to decode JWT:', e);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const userId = args[0] && !args[0].startsWith('--') ? args[0] : 'will.y.um'; // Default user
  
  // Parse flags
  const jwtIndex = args.indexOf('--jwt');
  const jwt = jwtIndex !== -1 ? args[jwtIndex + 1] : null;

  const userIndex = args.indexOf('--username');
  const duolingoUsername = userIndex !== -1 ? args[userIndex + 1] : null;

  const passIndex = args.indexOf('--password');
  const duolingoPassword = passIndex !== -1 ? args[passIndex + 1] : null;

  const langIndex = args.indexOf('--lang');
  const lang = langIndex !== -1 ? args[langIndex + 1] : 'ru';

  console.log(`Starting Duolingo Sync for user: ${userId} (${lang})`);

  // 1. Ensure user exists
  let user = await db.query.users.findFirst({
    where: eq(users.id, userId)
  });

  if (!user) {
    console.log(`User ${userId} not found. Creating...`);
    await db.insert(users).values({
      id: userId,
      createdAt: Date.now(),
      targetLanguage: lang,
      nativeLanguage: 'en',
      proficiencyLevel: 'beginner',
    });
    console.log(`User created.`);
  }

  // 2. Handle Full Authentication (Username/Password)
  if (duolingoUsername && duolingoPassword) {
    console.log(`Authenticating as ${duolingoUsername}...`);
    try {
        const { authenticateDuolingo } = await import('../tools/duolingo.js');
        // We can't call the tool directly as it returns an LLM tool object, 
        // we should call the execute method or the logic inside it.
        // Actually, let's just use the DuolingoClient directly here for the script.
        const { DuolingoClient } = await import('../lib/duolingoClient.js');
        const client = new DuolingoClient();
        const auth = await client.authenticate(duolingoUsername, duolingoPassword);
        
        const now = Date.now();
        await db.insert(duolingoMetadata).values({
            userId,
            duolingoUsername,
            duolingoPassword,
            duolingoJWT: auth.jwt,
            duolingoUserId: auth.userId,
            learningLanguage: lang,
            syncStatus: 'pending',
            createdAt: now,
            updatedAt: now,
        }).onConflictDoUpdate({
            target: duolingoMetadata.userId,
            set: {
                duolingoUsername,
                duolingoPassword,
                duolingoJWT: auth.jwt,
                duolingoUserId: auth.userId,
                learningLanguage: lang,
                updatedAt: now,
            }
        });
        console.log('Authentication successful and stored.');
    } catch (e: any) {
        console.error('Authentication failed:', e.message);
        process.exit(1);
    }
  } 
  // 3. Handle Manual JWT Injection (Legacy/Shortcut)
  else if (jwt) {
    console.log('Injecting provided JWT...');
    
    const duoUserId = extractUserIdFromJwt(jwt) || 'unknown_user';
    console.log(`Extracted Duolingo User ID: ${duoUserId}`);

    const now = Date.now();
    const finalUsername = duolingoUsername || 'manual_jwt_user';
    
    // Update metadata
    await db.insert(duolingoMetadata).values({
        userId,
        duolingoUsername: finalUsername,
        duolingoJWT: jwt,
        duolingoUserId: duoUserId,
        learningLanguage: lang,
        syncStatus: 'pending',
        createdAt: now,
        updatedAt: now,
    }).onConflictDoUpdate({
        target: duolingoMetadata.userId,
        set: {
            duolingoUsername: finalUsername,
            duolingoJWT: jwt,
            duolingoUserId: duoUserId,
            learningLanguage: lang,
            updatedAt: now,
        }
    });
    console.log(`JWT injected for username: ${finalUsername}`);
  }

  // 3. Perform Sync
  console.log('Running sync...');
  const result = await performDuolingoSync(userId);

  if (result.success) {
    console.log('✅ Sync Successful!');
    console.log('-------------------');
    console.log(result.message);
    if (result.stats) {
      console.log('Stats:');
      console.log(`  - New Words: ${result.stats.newWords}`);
      console.log(`  - Updated Words: ${result.stats.updatedWords}`);
      console.log(`  - New Skills: ${result.stats.newSkills}`);
      console.log(`  - New Grammar Rules: ${result.stats.newGrammar}`);
      console.log(`  - Total Vocab: ${result.stats.totalVocab}`);
    }
  } else {
    console.error('❌ Sync Failed!');
    console.error(result.message);
    console.log('\nTip: If you need to authenticate, use the --auth flag (not implemented in script, use agent) or provide --jwt:');
    console.log(`tsx agents/src/scripts/sync-duolingo.ts ${userId} --jwt <your_jwt_token>`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
