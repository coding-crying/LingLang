import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLearnerPromptContext } from './tutor-prompt-context.js';
import { buildInstructions } from '../config/prompts/base.js';
test('shared prompt context retains all legacy teaching signals and active lesson',()=>{
 const view={demandWords:[{lemma:'كتاب',translation:'book'}],activeChunk:{card:'If it fits naturally, practise introductions.'}} as any;
 const base={targetLanguage:'Arabic',nativeLanguage:'English',userLevel:'beginner',persona:'Be witty and patient.',frontier:{state:'balance' as const,directive:'Keep it natural.',dueWords:'مرحبا (hello)',newWords:''},recentErrors:'None',grammarHints:'None',goalUpdate:'Respond to their question.',previousSessionContext:'Discussed travel last time.',mixLine:'Explain in English when needed.',adaptive:{sessionPhase:'opening' as const,turnCount:0,errorDensity:0,pacing:'medium' as const},realtime:true,modelGuidance:'One digestible move.'};
 const legacy={...base,demandWords:'كتاب (book)',lessonCard:view.activeChunk.card};
 const shared=buildLearnerPromptContext(view,base);
 assert.deepEqual(shared,legacy);
 assert.equal(buildInstructions(shared),buildInstructions(legacy));
 assert.match(buildInstructions(shared),/introductions/);
});
