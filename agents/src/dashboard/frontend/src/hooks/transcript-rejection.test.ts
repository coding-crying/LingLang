import assert from 'node:assert/strict';
import { applyStreamEvent, initialConversationState } from './useConversationStream.js';

const partial = applyStreamEvent(initialConversationState, {
  type: 'user.transcript.partial', ts: 1, data: { itemId: 'phantom', text: 'The tutor greeting' },
});
assert.equal(partial.turns.length, 1);
const rejected = applyStreamEvent(partial, {
  type: 'user.transcript.rejected', ts: 2, data: { itemId: 'phantom', reason: 'silent-span' },
});
assert.equal(rejected.turns.length, 0, 'Rejected phantom must not leave an eternal live bubble');
assert.equal(rejected.pendingUserQueue.length, 0);
const accepted = applyStreamEvent(partial, {
  type: 'user.transcript', ts: 2, data: { itemId: 'phantom', text: 'Real learner speech', turnSeq: 1 },
});
assert.equal(applyStreamEvent(accepted, {
  type: 'user.transcript.rejected', ts: 3, data: { itemId: 'phantom' },
}), accepted, 'Do not erase finalized learner history on a stale rejection');
assert.equal(applyStreamEvent(partial, {
  type: 'user.transcript.rejected', ts: 3, data: {},
}), partial, 'An unkeyed rejection cannot erase unrelated speech');
console.log('transcript rejection: 5 assertions passed');
