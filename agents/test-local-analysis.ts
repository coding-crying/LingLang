/**
 * Quick test of local LLM analysis
 * Run with: npx tsx test-local-analysis.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { analyzeUtteranceWithLocalLLM } from './src/tools/supervisor-functions.js';

async function main() {
  console.log('Testing local LLM analysis...\n');
  console.log(`Model: ${process.env.LOCAL_LLM_MODEL || 'gemma3:4b'}`);
  console.log(`URL: ${process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1'}\n`);

  const testCases = [
    'Я хочу воду',           // I want water
    'Привет, как дела?',      // Hello, how are you?
    'Я ем хлеб',             // I eat bread
    'Где моя книга?',        // Where is my book?
  ];

  for (const utterance of testCases) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Input: "${utterance}"`);

    const result = await analyzeUtteranceWithLocalLLM(
      utterance,
      'Conversational practice',
      process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1'
    );

    if (result) {
      console.log(`Language: ${result.language}`);
      console.log(`Lexemes:`);
      for (const lex of result.lexemes || []) {
        console.log(`  - ${lex.lemma} (${lex.pos}): ${lex.performance}`);
      }
    } else {
      console.log('❌ Analysis failed');
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log('Done!');
}

main().catch(console.error);
