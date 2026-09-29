import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMaterials } from './material-groups';
import type { ContentSource } from './materials';
const lesson = (n: number, extra: Partial<ContentSource> = {}): ContentSource => ({
 id: `lesson-${n}`, title: `Pimsleur Modern Standard Arabic 1 - Unit ${String(n).padStart(2, '0')} (ASR transcript)`, language: 'ar', kind: 'audio', status: 'ready', chunkCount: 30, progress: 0, isActive: false, started: false, intent: 'study', profileStatus: 'needed', needsProfile: true, pendingQuestionCount: 3, ...extra,
});
test('sixteen reversed lessons become one course, numerically ordered with original source identity', () => {
 const sources = Array.from({length:16}, (_,i)=>lesson(16-i));
 const groups = groupMaterials(sources);
 assert.equal(groups.length,1);
 assert.equal(groups[0].title,'Pimsleur Modern Standard Arabic 1');
 assert.equal(groups[0].course,true);
 assert.deepEqual(groups[0].sources.map(s=>s.id),Array.from({length:16},(_,i)=>`lesson-${i+1}`));
 assert.equal(groups[0].sources[0],sources[15]);
 assert.equal(sources[0].id,'lesson-16');
});
test('does not merge PDFs, unrelated titles, other levels or languages', () => {
 const groups = groupMaterials([lesson(1), lesson(2), lesson(3,{id:'pdf',kind:'textbook'}), lesson(4,{id:'other',title:'Other course - Unit 04'}), lesson(5,{id:'level2',title:'Pimsleur Modern Standard Arabic 2 - Unit 05 (ASR transcript)'}), lesson(6,{id:'lang',language:'pt'})]);
 assert.equal(groups.length,5);
 assert.equal(groups[0].sources.length,2);
 assert.equal(groups[1].course,false);
 assert.equal(groups[2].course,false);
});
test('filtered singleton stays a course and empty library stays empty', () => {
 assert.equal(groupMaterials([lesson(9)])[0].course,true);
 assert.deepEqual(groupMaterials([]),[]);
});
