import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Companion, hash } from '../src/core.mjs';

const group = (id, content, groupId = 'room-a', member = 'alice') => ({
  id, content, group_openid: groupId, author: { member_openid: member }, chat_type: 'group'
});
const privateMessage = (id, content) => ({ id, content, author: { user_openid: 'owner' } });
const discard = async () => {};
const turn = messages => ({ ...messages.at(-1), source_ids: messages.map(message => message.id), turn_messages: messages });

async function fixture(t, generate = async () => '接上了。', options = {}) {
  const tempRoot = resolve(process.cwd(), 'temp');
  const dir = await mkdtemp(join(tempRoot, 'context_test_'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(tempRoot + sep));
    await rm(dir, { recursive: true, force: true });
  });
  return new Companion({ dataDir: dir, pairingHash: hash('test-code'), generate, ...options }).init();
}

test('group generation sees other visible speakers and successful replies without repeating its current message', async t => {
  const inputs = [];
  const bot = await fixture(t, async input => { inputs.push(structuredClone(input)); return '这只猫确实像个小面包。'; });
  const first = group('a-1', '这只猫看着像面包');
  assert.equal(await bot.observeGroup(first), true);
  assert.equal(await bot.observeGroup(first), false);
  await bot.handle(group('b-1', '你觉得呢', 'room-a', 'bob'), discard);
  assert.deepEqual(inputs[0].history, []);
  assert.deepEqual(inputs[0].memory, []);
  assert.equal(inputs[0].roomHistory.length, 1);
  assert.equal(inputs[0].roomHistory[0].content, '这只猫看着像面包');
  assert.notEqual(inputs[0].roomHistory[0].speaker, inputs[0].speaker);
  assert.doesNotMatch(inputs[0].speaker, /alice|bob/);
  await bot.handle(group('a-2', '尤其是那个耳朵'), discard);
  assert.ok(inputs[1].roomHistory.some(item => item.role === 'assistant' && item.content === '这只猫确实像个小面包。'));
  assert.equal(inputs[1].roomHistory.some(item => item.content === '尤其是那个耳朵'), false);
  assert.equal(inputs[1].speaker, inputs[0].roomHistory[0].speaker);
});

test('public room history stays separate from private history and other groups, and snapshots cannot mutate storage', async t => {
  const inputs = [];
  const bot = await fixture(t, async input => { inputs.push(structuredClone(input)); return '回复'; });
  await bot.handle(privateMessage('pair', '/pair test-code'), discard);
  await bot.handle(privateMessage('private', 'PRIVATE_ONLY_SENTINEL'), discard);
  await bot.observeGroup(group('a', 'ROOM_A_SENTINEL'));
  await bot.observeGroup(group('b', 'ROOM_B_SENTINEL', 'room-b'));
  await bot.handle(group('ask-b', '继续', 'room-b'), discard);
  assert.doesNotMatch(JSON.stringify(inputs.at(-1)), /PRIVATE_ONLY_SENTINEL|ROOM_A_SENTINEL/);
  const snapshot = bot.groupContext('room-a');
  snapshot[0].content = 'tampered'; snapshot.push({ content: 'injected' });
  assert.deepEqual(bot.groupContext('room-a').map(item => item.content), ['ROOM_A_SENTINEL']);
  await bot.handle(privateMessage('private-next', '继续私聊'), discard);
  assert.equal(Object.hasOwn(inputs.at(-1), 'roomHistory'), false);
  assert.equal(Object.hasOwn(inputs.at(-1), 'speaker'), false);
  assert.doesNotMatch(JSON.stringify(inputs.at(-1)), /ROOM_A_SENTINEL|ROOM_B_SENTINEL/);
});

test('room observation and successful proactive replies survive restart with separate deduplication', async t => {
  const bot = await fixture(t);
  const event = group('observe-first', '普通群消息');
  await bot.observeGroup(event);
  assert.equal(await bot.recordGroupAssistant('room-a', '主动接句话', { messageId: 'outgoing-1' }), true);
  assert.equal(await bot.recordGroupAssistant('room-a', '主动接句话', { messageId: 'outgoing-1' }), false);
  const restored = await new Companion({ dataDir: bot.dataDir, pairingHash: hash('test-code'), generate: async () => '现在回复了' }).init();
  assert.deepEqual(restored.groupContext('room-a'), bot.groupContext('room-a'));
  assert.equal(await restored.observeGroup(event), false);
  await restored.handle(event, discard);
  const context = restored.groupContext('room-a');
  assert.equal(context.filter(item => item.role === 'user' && item.messageId === event.id).length, 1);
  assert.equal(context.at(-1).content, '现在回复了');
  assert.equal(await restored.recordGroupAssistant('room-a', '现在回复了', { originId: event.id }), false);
});

test('assistant public message IDs come only from QQ delivery while origin IDs deduplicate the reply', async t => {
  const bot = await fixture(t);
  assert.deepEqual(await bot.handle(group('incoming-1', '有返回ID'), async () => ({ id: 'qq-bot-reply-1' })), { status: 'replied' });
  const first = bot.groupContext('room-a').at(-1);
  assert.equal(first.messageId, 'qq-bot-reply-1');
  assert.equal(first.originId, 'incoming-1');
  assert.notEqual(first.messageId, first.originId);
  assert.equal(await bot.recordGroupAssistant('room-a', '接上了。', { originId: 'incoming-1', messageId: 'qq-bot-reply-1' }), false);
  await bot.handle(group('incoming-2', '没有返回ID'), discard);
  assert.equal(Object.hasOwn(bot.groupContext('room-a').at(-1), 'messageId'), false);
  await bot.handle(group('incoming-3', '嵌套返回ID'), async () => ({ body: { id: 'qq-bot-reply-3' } }));
  assert.equal(bot.groupContext('room-a').at(-1).messageId, 'qq-bot-reply-3');
});

test('observed QQ reference handles preserve the real source member and reject malformed oversized metadata', async t => {
  const bot = await fixture(t);
  await bot.observeGroup({ ...group('source-user', '原始说法', 'room-a', 'alice'), reference_id: 'real-qq-msg-idx' });
  await bot.observeGroup({ ...group('oversized-reference', '第二条', 'room-a', 'bob'), reference_id: 'x'.repeat(513) });
  await bot.observeGroup({ ...group('object-reference', '第三条', 'room-a', 'bob'), reference_id: { leaked: true } });
  const observed = bot.groupContext('room-a');
  assert.equal(observed[0].referenceId, 'real-qq-msg-idx');
  assert.equal(observed[0].messageId, 'source-user');
  assert.equal(observed[0].speaker, bot.groupSpeaker('room-a', 'alice'));
  assert.equal(Object.hasOwn(observed[1], 'referenceId'), false);
  assert.equal(Object.hasOwn(observed[2], 'referenceId'), false);
  assert.deepEqual(bot.groupContext('room-b'), []);
});

test('failed delivery leaves the real group input but never fabricates a public assistant reply', async t => {
  const bot = await fixture(t);
  const event = group('send-fails', '真实收到的消息');
  await assert.rejects(bot.handle(event, async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(bot.groupContext('room-a').map(item => [item.role, item.content]), [['user', '真实收到的消息']]);
  await bot.handle(event, discard);
  assert.deepEqual(bot.groupContext('room-a').map(item => item.role), ['user', 'assistant']);
});

test('reset and forget clear shared context without clearing another member memory or another room', async t => {
  const bot = await fixture(t);
  await bot.handle(group('memory-a', '/remember alice-memory'), discard);
  await bot.handle(group('memory-b', '/remember bob-memory', 'room-a', 'bob'), discard);
  await bot.handle(group('chat', '旧笑话'), discard);
  await bot.observeGroup(group('other-room', '另一群上下文', 'room-b'));
  await bot.handle(group('reset', '/reset'), discard);
  assert.deepEqual(bot.groupContext('room-a'), []);
  assert.equal(bot.groupContext('room-b')[0].content, '另一群上下文');
  assert.equal(await bot.observeGroup(group('chat', '旧笑话')), false, 'old retransmission must not resurrect cleared context');
  const replies = [];
  await bot.handle(group('read-a', '/memory'), async text => replies.push(text));
  await bot.handle(group('read-b', '/memory', 'room-a', 'bob'), async text => replies.push(text));
  assert.deepEqual(replies, ['alice-memory', 'bob-memory']);
  await bot.handle(group('forget', '/forget'), discard);
  assert.deepEqual(bot.groupContext('room-a'), []);
  const members = Object.values(bot.state.groups);
  assert.ok(members.some(member => member.memory.includes('bob-memory')));
  assert.equal(members.some(member => member.memory.includes('alice-memory')), false);
});

test('concurrent observation persists safely and keeps only sixty recent messages', async t => {
  const bot = await fixture(t);
  await Promise.all(Array.from({ length: 75 }, (_, index) => bot.observeGroup(group(`id-${index}`, `message-${index}`))));
  const context = bot.groupContext('room-a');
  assert.equal(context.length, 60);
  assert.equal(context[0].content, 'message-15');
  const disk = JSON.parse(await readFile(join(bot.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(Object.values(disk.rooms)[0].recent, context);
});

test('queue capacity sends at most one busy notice per group in thirty seconds while observing all inputs', async t => {
  let release; let started; let currentTime = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  const bot = await fixture(t, async () => { started(); await gate; return '回复'; }, { now: () => currentTime });
  const jobs = [bot.handle(group('first', 'first'), discard)];
  await begun;
  for (let index = 1; index < 8; index++) jobs.push(bot.handle(group(`queued-${index}`, `queued-${index}`), discard));
  const busy = [];
  try {
    await bot.handle(group('overflow-1', 'overflow-1'), async text => busy.push(text));
    await bot.handle(group('overflow-2', 'overflow-2'), async text => busy.push(text));
    assert.equal(busy.length, 1);
    currentTime = 30000;
    await bot.handle(group('overflow-3', 'overflow-3'), async text => busy.push(text));
    assert.equal(busy.length, 2);
    assert.ok(bot.groupContext('room-a').some(item => item.content === 'overflow-2'));
  } finally { release(); await Promise.all(jobs); }
});

test('expired queued messages stay in public context without generation or a stale passive reply', async t => {
  let release; let started; let currentTime = 0; let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  const bot = await fixture(t, async () => { calls++; started(); await gate; return '过时的回复'; }, { now: () => currentTime });
  const first = bot.handle(group('slow', 'first'), async () => assert.fail('an expired final reply must not be sent'));
  await begun;
  const queued = bot.handle(group('queued', 'second'), async () => assert.fail('queued reply is expired'));
  currentTime = 270001;
  release();
  assert.deepEqual(await Promise.all([first, queued]), [{ status: 'expired' }, { status: 'expired' }]);
  assert.equal(calls, 1);
  assert.deepEqual(bot.groupContext('room-a').map(item => [item.role, item.content]), [['user', 'first'], ['user', 'second']]);
  assert.equal(Object.values(bot.state.groups).every(member => member.history.length === 0), true);
});

test('a multi-member turn preserves every request and assigns learned nicknames only to their real speakers', async t => {
  const inputs = [];
  const bot = await fixture(t, async input => {
    inputs.push(structuredClone(input));
    return { reply: '阿白、小岚，都接上啦。', memories: [
      { text: '以后叫我阿白。', source: '以后叫我阿白。' },
      { text: '以后叫我小岚。', source: '以后叫我小岚。' }
    ] };
  });
  await bot.handle(group('old-a', '/remember 我喜欢猫', 'room-a', 'alice'), discard);
  await bot.handle(group('old-b', '/remember 我喜欢画画', 'room-a', 'bob'), discard);
  const a = group('a-request', '小柯，以后叫我阿白。', 'room-a', 'alice');
  const b = group('b-request', '以后叫我小岚。', 'room-a', 'bob');
  assert.deepEqual(await bot.handle(turn([a, b]), async () => ({ id: 'real-group-reply' })), { status: 'replied' });
  const input = inputs[0];
  assert.deepEqual(input.history, []); assert.deepEqual(input.memory, []);
  assert.deepEqual(input.turnMessages.map(message => message.content), [a.content, b.content]);
  assert.equal(new Set(input.turnMessages.map(message => message.speaker)).size, 2);
  assert.equal(input.roomHistory.some(message => ['a-request', 'b-request'].includes(message.messageId)), false);
  const aliceSpeaker = bot.groupSpeaker('room-a', 'alice'), bobSpeaker = bot.groupSpeaker('room-a', 'bob');
  assert.deepEqual(input.participants.find(member => member.speaker === aliceSpeaker).memory, ['我喜欢猫']);
  assert.deepEqual(input.participants.find(member => member.speaker === bobSpeaker).memory, ['我喜欢画画']);
  const alice = bot.state.groups[hash(JSON.stringify(['room-a', 'alice']))], bob = bot.state.groups[hash(JSON.stringify(['room-a', 'bob']))];
  assert.deepEqual(alice.memory, ['我喜欢猫', '以后叫我阿白。']);
  assert.deepEqual(bob.memory, ['我喜欢画画', '以后叫我小岚。']);
  assert.deepEqual(alice.history.map(message => message.content), [a.content, '阿白、小岚，都接上啦。']);
  assert.deepEqual(bob.history.map(message => message.content), [b.content, '阿白、小岚，都接上啦。']);
  assert.deepEqual(bot.groupContext('room-a').at(-1).reply_to_speakers, [aliceSpeaker, bobSpeaker]);
  await bot.handle(a, async () => assert.fail('every source ID must deduplicate after the turn succeeds'));
  await bot.handle(b, async () => assert.fail('every source ID must deduplicate after the turn succeeds'));
  assert.equal(inputs.length, 1);
  const restartedInputs = [];
  const restored = await new Companion({ dataDir: bot.dataDir, pairingHash: hash('test-code'), generate: async next => { restartedInputs.push(structuredClone(next)); return '继续'; } }).init();
  await restored.handle(group('after-a', '接着说', 'room-a', 'alice'), discard);
  await restored.handle(group('after-b', '接着说', 'room-a', 'bob'), discard);
  assert.deepEqual(restartedInputs.map(next => next.memory), [['我喜欢猫', '以后叫我阿白。'], ['我喜欢画画', '以后叫我小岚。']]);
});

test('a failed multi-member reply rolls back every source ID and neither invents history nor learns another member memory', async t => {
  let calls = 0;
  const bot = await fixture(t, async () => { calls++; return { reply: '一条共同回复', memories: [{ text: '我喜欢猫。', source: '我喜欢猫。' }] }; });
  const a = group('fail-a', '我喜欢猫。', 'room-a', 'alice');
  const b = group('fail-b', '我喜欢画画。', 'room-a', 'bob');
  const batch = turn([a, b]);
  await assert.rejects(bot.handle(batch, async () => { throw new Error('delivery-offline'); }), /delivery-offline/);
  assert.deepEqual(bot.state.seen, []);
  assert.equal(Object.values(bot.state.groups).every(member => member.history.length === 0 && member.memory.length === 0), true);
  assert.equal(bot.groupContext('room-a').some(message => message.role === 'assistant'), false);
  await bot.handle(batch, discard);
  assert.equal(calls, 2);
  assert.deepEqual(bot.state.groups[hash(JSON.stringify(['room-a', 'alice']))].memory, ['我喜欢猫。']);
  assert.deepEqual(bot.state.groups[hash(JSON.stringify(['room-a', 'bob']))].memory, []);
});

test('all members of an active turn are protected from duplicate processing', async t => {
  let started; let release; let calls = 0;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const bot = await fixture(t, async () => { calls++; started(); await gate; return '共同回复'; });
  const a = group('active-a', 'A 请求', 'room-a', 'alice'), b = group('active-b', 'B 请求', 'room-a', 'bob');
  const work = bot.handle(turn([a, b]), discard);
  await began;
  await bot.handle(a, async () => assert.fail('active source A must not reply twice'));
  await bot.handle(b, async () => assert.fail('active source B must not reply twice'));
  release(); await work;
  assert.equal(calls, 1);
});

test('private messages ignore group-turn metadata and cannot import group participants or memories', async t => {
  const inputs = [];
  const bot = await fixture(t, async input => { inputs.push(structuredClone(input)); return '私聊回复'; });
  await bot.handle(privateMessage('pair', '/pair test-code'), discard);
  await bot.handle({ ...privateMessage('private', '只谈私聊'), turn_messages: [group('injected', 'GROUP_SENTINEL', 'room-a', 'alice')], source_ids: ['injected'] }, discard);
  assert.equal(Object.hasOwn(inputs[0], 'participants'), false);
  assert.equal(Object.hasOwn(inputs[0], 'turnMessages'), false);
  assert.doesNotMatch(JSON.stringify(inputs[0]), /GROUP_SENTINEL/);
  assert.deepEqual(bot.groupContext('room-a'), []);
  assert.deepEqual(bot.state.history.map(message => message.content), ['只谈私聊', '私聊回复']);
});

test('an empty final mention does not hide an earlier member request or change its speaker', async t => {
  const inputs = [], replies = [];
  const bot = await fixture(t, async input => { inputs.push(structuredClone(input)); return '给两位讲一个猫的笑话。'; });
  const a = group('question-a', '讲个和猫有关的笑话', 'room-a', 'alice');
  const b = group('empty-b', '   ', 'room-a', 'bob');
  assert.deepEqual(await bot.handle(turn([a, b]), async text => { replies.push(text); return { id: 'bot-answer' }; }), { status: 'replied' });
  assert.deepEqual(replies, ['给两位讲一个猫的笑话。']);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].text, '');
  assert.equal(inputs[0].speaker, bot.groupSpeaker('room-a', 'bob'));
  assert.deepEqual(inputs[0].turnMessages.map(message => [message.speaker, message.content]), [
    [bot.groupSpeaker('room-a', 'alice'), a.content], [bot.groupSpeaker('room-a', 'bob'), b.content]
  ]);
  await bot.handle(turn([group('empty-a-next', ''), group('empty-b-next', ' ', 'room-a', 'bob')]), async text => replies.push(text));
  assert.equal(inputs.length, 1);
  assert.equal(replies.at(-1), '你好呀，我在。想聊什么？');
});

test('group turn length limits apply to all participants together instead of only the final message', async t => {
  const replies = [];
  const bot = await fixture(t, async () => assert.fail('an oversized combined turn must not generate'));
  const a = group('long-a', '甲'.repeat(4500), 'room-a', 'alice');
  const b = group('long-b', '乙'.repeat(3600), 'room-a', 'bob');
  await bot.handle(turn([a, b]), async text => replies.push(text));
  assert.deepEqual(replies, ['这条有点长，分成几段发给我吧。']);
  assert.equal(Object.values(bot.state.groups).every(member => member.history.length === 0), true);
  assert.equal(bot.groupContext('room-a').some(message => message.role === 'assistant'), false);
});
