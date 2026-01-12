import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { DuolingoClient } from '../lib/duolingoClient.js';

async function main() {
  const username = 'will.y.um';
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjYzMDcyMDAwMDAsImlhdCI6MCwic3ViIjozODczMDA5MjV9.rt2Qdmi7xIKsM90bC0MJL-7EP4DkewXG2UOcq3jmRpc';
  
  console.log('Inspecting Duolingo response structure...');
  const client = new DuolingoClient();
  client.setJWT(jwt);

  try {
    const userData = await client.getUserData('387300925', username);
    
    // Check inside language_data
    if (userData.language_data && userData.language_data.ru) {
        const skills = userData.language_data.ru.skills;
        if (skills && skills.length > 0) {
            console.log('Found skills:', skills.length);
            console.log('First Skill Keys:', Object.keys(skills[0]));
            
            // Check for words/lexemes inside the skill
            if (skills[0].words) console.log('Found "words" in skill:', skills[0].words.slice(0, 2));
            if (skills[0].lexemes) console.log('Found "lexemes" in skill:', skills[0].lexemes.slice(0, 2));
            if (skills[0].vocabulary) console.log('Found "vocabulary" in skill:', skills[0].vocabulary);
        } else {
            console.log('No skills in language_data.ru');
        }
    } else {
        console.log('No language_data.ru found');
    }

  } catch (e: any) {
    console.error('Error:', e.message);
  }
}

main();
