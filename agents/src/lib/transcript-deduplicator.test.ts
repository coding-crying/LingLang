import assert from 'node:assert/strict';
import { TranscriptDeduplicator } from './transcript-deduplicator.js';

const d = new TranscriptDeduplicator();
assert.equal(d.accept('Sí', 'turn-1', 1000), true);
assert.equal(d.accept('Sí', 'turn-2', 1100), true, 'new utterance ID means new practice, even with identical words');
assert.equal(d.accept('Sí', 'turn-1', 2000), false, 'replayed older event must not grade twice');
const legacy = new TranscriptDeduplicator();
assert.equal(legacy.accept('Sim', undefined, 1000), true);
assert.equal(legacy.accept('Sim', undefined, 1300), false);
assert.equal(legacy.accept('Sim', undefined, 1501), true, 'ID-less suppression expires; duplicate arrivals do not extend it');
assert.equal(legacy.accept('Sim', undefined, 900), true, 'clock rollback must not suppress a turn forever');
console.log('transcript dedupe: 7 assertions passed');
