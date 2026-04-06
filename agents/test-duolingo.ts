import { authenticateDuolingo, syncDuolingoData, getDuolingoWeakWords } from './src/tools/duolingo.js';

const userId = 'test-duolingo-user';
const duolingoEmail = 'wilherman21@gmail.com';
const duolingoPassword = 'chocolate21';
const language = 'ru'; // Russian

async function testDuolingoIntegration() {
  console.log('=== Testing Duolingo Integration ===\n');

  try {
    // Step 1: Authentication
    console.log('📝 Step 1: Authenticating with Duolingo...');
    console.log(`   Email: ${duolingoEmail}`);
    console.log(`   Language: ${language}`);

    const authResult = await authenticateDuolingo.execute({
      userId,
      duolingoUsername: duolingoEmail,
      duolingoPassword,
      language,
    });

    console.log('   Result:', authResult);

    if (!authResult.success) {
      console.error('\n❌ Authentication failed! Stopping test.');
      return;
    }

    console.log('   ✅ Authentication successful!\n');

    // Step 2: Sync Data
    console.log('📦 Step 2: Syncing vocabulary and progress from Duolingo...');

    const syncResult = await syncDuolingoData.execute({ userId });

    console.log('   Result:', syncResult);

    if (!syncResult.success) {
      console.error('\n❌ Sync failed!');
      return;
    }

    console.log('   ✅ Sync successful!');
    if (syncResult.stats) {
      console.log(`   📊 Stats:`);
      console.log(`      - New words: ${syncResult.stats.newWords}`);
      console.log(`      - Updated words: ${syncResult.stats.updatedWords}`);
      console.log(`      - New skills: ${syncResult.stats.newSkills}`);
      console.log(`      - Total vocabulary: ${syncResult.stats.totalVocab}`);
    }
    console.log('');

    // Step 3: Get Weak Words
    console.log('🎯 Step 3: Finding weak words that need practice...');

    const weakWordsResult = await getDuolingoWeakWords.execute({
      userId,
      limit: 10
    });

    console.log('   Result:', weakWordsResult.message);

    if (weakWordsResult.count > 0) {
      console.log(`   📚 Found ${weakWordsResult.count} words needing practice:\n`);
      weakWordsResult.weakWords.forEach((word, idx) => {
        console.log(`      ${idx + 1}. ${word.word} (${word.translation})`);
        console.log(`         Strength: ${word.strengthDescription} (Level ${word.srsLevel})`);
        console.log(`         Last seen: ${word.lastSeen}`);
      });
    } else {
      console.log('   ℹ️  No weak words found (or no vocabulary synced yet)');
    }

    console.log('\n✅ All tests completed successfully!');

  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    throw error;
  }
}

testDuolingoIntegration().catch(console.error);
