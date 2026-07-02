import { db } from '../db/index.js';
import { users, userVocabulary, lexemes } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { analyzeUtteranceWithLocalLLM } from '../tools/supervisor-functions.js';

// Mixed utterance test: "I went to the praia and ate pão"
const utterance = 'I went to the praia and ate pão';
const context = 'User is learning Portuguese. They mix English and Portuguese freely.';

const result = await analyzeUtteranceWithLocalLLM(
  utterance,
  context,
  'http://localhost:8094/v1',
  'gemma4-12b-it-qat',
  'Portuguese',
  undefined,
  '',
  undefined,
  'English',
);

console.log('=== Analysis result ===');
console.log('Utterance language:', result.analysis?.language);
console.log('Per-lemma language tags:');
for (const lex of result.analysis?.lexemes || []) {
  console.log(`  ${lex.lemma.padEnd(12)} pos=${lex.pos.padEnd(6)} lang=${lex.language} perf=${lex.performance}`);
}
console.log('\nRaw response (first 2000 chars):');
console.log((result.rawResponse || '').slice(0, 2000));

process.exit(0);
