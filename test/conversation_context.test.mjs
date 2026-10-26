import test from 'node:test';
import assert from 'node:assert/strict';
import { readConversationContext, readObservedMessage } from '../src/conversation_context.mjs';

const now = Date.parse('2026-10-22T04:00:00Z'), alice = 'member_0123456789abcdef';
const history = [
  { role: 'user', speaker: alice, content: '猫饼来了', messageId: 'user-1', at: now - 1000, token: 'never-copy' },
  { role: 'assistant', content: '你好', messageId: 'bot-1', referenceId: 'quote-index', at: now - 500 },
  { role: 'user', speaker: alice, content: 'foreign-secret', group_openid: 'room-b', at: now },
  { role: 'user', speaker: alice, content: 'old', at: now - 3 * 60 * 60_000 }
];

test('read-only group metadata returns only public observed data with a role whitelist and no invented roster', async () => {
  const calls = [];
  const context = await readConversationContext({ event: { group_openid: 'room-a' }, now,
    getRoomHistory: group => { calls.push(group); return history; }, getRoomMemory: () => [],
    role: { name: '柯霜', aliases: ['小柯'], description: '白发小龙娘', secret: 'private-role-setting' } });
  assert.deepEqual(calls, ['room-a']);
  assert.equal(context.kind, 'group');
  assert.deepEqual(context.active_members, [{ speaker: alice, message_count: 1, last_spoke_at: new Date(now - 1000).toISOString(), last_message_id: 'user-1' }]);
  assert.equal(context.own_recent_messages[0].messageId, 'bot-1');
  assert.match(context.coverage, /not a complete QQ roster/);
  assert.doesNotMatch(JSON.stringify(context), /never-copy|foreign-secret|private-role-setting|room-a/);
  context.own_recent_messages[0].content = 'mutated';
  assert.equal(history[1].content, '你好');
});

test('message lookup accepts an observed reference, rejects unknown IDs, and private context never invokes group callbacks', async () => {
  assert.equal((await readObservedMessage({ groupOpenid: 'room-a', messageId: 'quote-index', getRoomHistory: () => history })).messageId, 'bot-1');
  assert.equal(await readObservedMessage({ groupOpenid: 'room-a', messageId: 'unknown', getRoomHistory: () => history }), null);
  const privateContext = await readConversationContext({ event: { author: { user_openid: 'private' } }, getRoomHistory: () => assert.fail('group leak'), getRoomMemory: () => assert.fail('group leak') });
  assert.equal(privateContext.kind, 'private');
  assert.equal(privateContext.active_members, undefined);
});
