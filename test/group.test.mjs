import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Companion, hash } from '../src/core.mjs';
import { QQClient } from '../src/qq.mjs';

const group = (id, content, groupId = 'group-a', member = 'member-a') => ({
  id, content, group_openid: groupId, author: { member_openid: member }, chat_type: 'group', message_type: 0
});
const privateMessage = (id, content, user = 'owner') => ({ id, content, author: { user_openid: user } });
const discard = async () => {};

async function fixture(t, generate = async () => '群聊回复', options = {}) {
  const tempRoot = resolve(process.cwd(), 'temp');
  const dir = await mkdtemp(join(tempRoot, 'group_test_'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(tempRoot + sep), 'only remove this test fixture inside project temp');
    await rm(dir, { recursive: true, force: true });
  });
  return new Companion({ dataDir: dir, pairingHash: hash('test-code'), generate, ...options }).init();
}

test('unpaired group members can chat without gaining private ownership', async t => {
  const calls = []; const replies = [];
  const at = '2026-10-22T04:00:00.000Z';
  const bot = await fixture(t, async input => { calls.push(structuredClone(input)); return '群聊回复'; }, { now: () => Date.parse(at) });
  await bot.handle(group('hello', '你好'), async text => replies.push(text));
  await bot.handle(privateMessage('private', '你好', 'member-a'), async text => assert.match(text, /配对/));
  assert.deepEqual(replies, ['群聊回复']);
  const speaker = bot.groupSpeaker('group-a', 'member-a');
  assert.deepEqual(calls, [{ messageId: 'hello', history: [], memory: [], text: '你好', roomHistory: [], roomMemory: [], speaker,
    participants: [{ speaker, memory: [] }], turnMessages: [{ speaker, content: '你好', messageId: 'hello', at }] }]);
  assert.equal(bot.state.owner, null);
  assert.deepEqual(bot.state.history, []);
  assert.deepEqual(bot.state.memory, []);
});

test('a paired owner never carries private history or memory into a group', async t => {
  const calls = [];
  const at = '2026-10-22T04:00:00.000Z';
  const bot = await fixture(t, async input => { calls.push(structuredClone(input)); return '回复'; }, { now: () => Date.parse(at) });
  await bot.handle(privateMessage('pair', '/pair test-code'), discard);
  await bot.handle(privateMessage('secret', '/remember 仅供私聊的记忆'), discard);
  await bot.handle(privateMessage('private-chat', '仅供私聊的内容'), discard);
  const privateHistory = structuredClone(bot.state.history);
  await bot.handle(group('owner-group', '群里的问题', 'group-a', 'owner'), discard);
  const speaker = bot.groupSpeaker('group-a', 'owner');
  assert.deepEqual(calls.at(-1), { messageId: 'owner-group', history: [], memory: [], text: '群里的问题', roomHistory: [], roomMemory: [], speaker,
    participants: [{ speaker, memory: [] }], turnMessages: [{ speaker, content: '群里的问题', messageId: 'owner-group', at }] });
  await bot.handle(group('group-secret', '/remember 群里的记忆', 'group-a', 'owner'), discard);
  await bot.handle(group('forget-group', '/forget', 'group-a', 'owner'), discard);
  assert.deepEqual(bot.state.history, privateHistory);
  assert.deepEqual(bot.state.memory, ['仅供私聊的记忆']);
  assert.equal(bot.state.owner, 'owner');
  await bot.handle(privateMessage('private-again', '继续私聊'), discard);
  assert.deepEqual(calls.at(-1), { messageId: 'private-again', history: privateHistory, memory: ['仅供私聊的记忆'], text: '继续私聊' });
});

test('group/member contexts and memory commands remain isolated across restart', async t => {
  const bot = await fixture(t);
  const identities = [['group-a', 'member-a', 'A 的记忆'], ['group-a', 'member-b', 'B 的记忆'], ['group-b', 'member-a', '另一群的记忆']];
  for (const [index, [groupId, member, note]] of identities.entries()) {
    await bot.handle(group(`remember-${index}`, `/remember ${note}`, groupId, member), discard);
    await bot.handle(group(`chat-${index}`, `问题 ${index}`, groupId, member), discard);
  }
  const observed = [];
  const restored = await new Companion({ dataDir: bot.dataDir, pairingHash: hash('test-code'), generate: async input => {
    observed.push(structuredClone(input)); return '重启后的回复';
  } }).init();
  for (const [index, [groupId, member, note]] of identities.entries()) {
    await restored.handle(group(`after-restart-${index}`, '继续', groupId, member), discard);
    assert.deepEqual(observed.at(-1).memory, [note]);
    assert.deepEqual(observed.at(-1).history, [{ role: 'user', content: `问题 ${index}` }, { role: 'assistant', content: '群聊回复' }]);
  }
  await restored.handle(group('reset-a', '/reset'), discard);
  await restored.handle(group('after-reset-a', '重新开始'), discard);
  assert.deepEqual(observed.at(-1).history, []);
  assert.deepEqual(observed.at(-1).memory, ['A 的记忆']);
  await restored.handle(group('forget-a', '/forget'), discard);
  const memories = [];
  for (const [index, [groupId, member]] of identities.entries()) {
    await restored.handle(group(`read-memory-${index}`, '/memory', groupId, member), async text => memories.push(text));
  }
  assert.match(memories[0], /没有/);
  assert.equal(memories[1], 'B 的记忆');
  assert.equal(memories[2], '另一群的记忆');
  assert.deepEqual(restored.state.history, []);
  assert.deepEqual(restored.state.memory, []);
});

test('group pairing directs members to private chat and never binds an owner', async t => {
  const bot = await fixture(t, async () => assert.fail('pairing command must not call the model'));
  const replies = [];
  await bot.handle(group('pair-group', '/pair test-code'), async text => replies.push(text));
  assert.equal(bot.state.owner, null);
  assert.match(replies[0], /单聊|私聊/);
  assert.doesNotMatch(replies[0], /test-code/);
  assert.deepEqual(bot.state.history, []);
  assert.deepEqual(bot.state.memory, []);
  await bot.handle(privateMessage('pair-private', '/pair test-code'), discard);
  assert.equal(bot.state.owner, 'owner');
});

test('empty group mentions get a text greeting and malformed group events are ignored', async t => {
  const bot = await fixture(t, async () => assert.fail('empty or malformed mention must not call the model'));
  const replies = [];
  await bot.handle(group('empty', '  '), async text => replies.push(text));
  assert.equal(replies.length, 1);
  assert.match(replies[0], /我在/);
  const missingGroup = group('bad-group', '你好'); delete missingGroup.group_openid;
  const missingMember = group('bad-member', '你好'); delete missingMember.author;
  const missingId = group(undefined, '你好');
  for (const malformed of [missingGroup, missingMember, missingId]) {
    await bot.handle(malformed, async () => assert.fail('invalid group target must not receive a reply'));
  }
  assert.equal(bot.state.owner, null);
  assert.deepEqual(bot.state.history, []);
});

test('group events deduplicate while identical IDs in other groups or private chat remain independent', async t => {
  let calls = 0;
  const bot = await fixture(t, async () => { calls++; return '回复'; });
  await bot.handle(privateMessage('pair', '/pair test-code'), discard);
  await bot.handle(privateMessage('same-id', '私聊'), discard);
  await Promise.all([bot.handle(group('same-id', '群 A'), discard), bot.handle(group('same-id', '群 A'), discard)]);
  await bot.handle(group('same-id', '群 B', 'group-b'), discard);
  assert.equal(calls, 3);
  assert.equal(bot.state.history.length, 2);
  const restored = await new Companion({ dataDir: bot.dataDir, pairingHash: hash('test-code'), generate: async () => assert.fail('delivered event must stay deduplicated after restart') }).init();
  await restored.handle(group('same-id', '群 A'), async () => assert.fail('duplicate must not be delivered'));
});

test('failed group delivery saves no answered history and the event can be retried', async t => {
  const observed = [];
  const bot = await fixture(t, async input => { observed.push(structuredClone(input)); return '回复'; });
  const message = group('retry', '你好');
  await assert.rejects(bot.handle(message, async () => { throw new Error('send-offline'); }), /send-offline/);
  assert.equal(Object.values(bot.state.groups).every(context => context.history.length === 0), true);
  await bot.handle(message, discard);
  assert.equal(observed.length, 2);
  assert.deepEqual(observed.map(input => input.history), [[], []]);
  assert.deepEqual(Object.values(bot.state.groups).map(context => context.history.length), [2]);
  await bot.handle(message, async () => assert.fail('successful retry must now be deduplicated'));
  assert.deepEqual(bot.state.history, []);
  assert.deepEqual(bot.state.memory, []);
});

test('a new group mention queues behind pending generation without a busy reply', async t => {
  let release; let started; let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const generating = new Promise(resolve => { started = resolve; });
  const bot = await fixture(t, async () => { calls++; started(); await gate; return '完成'; });
  const first = bot.handle(group('first-pending', '耗时问题'), discard);
  await generating;
  const replies = [];
  const second = bot.handle(group('second-pending', '另一个问题', 'group-b'), async text => replies.push(text));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.deepEqual(replies, []);
    assert.equal(bot.pending, 2);
    await bot.handle(group('first-pending', '耗时问题'), async () => assert.fail('an in-flight duplicate must not get another reply'));
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(replies, ['完成']);
  await bot.handle(group('second-pending', '另一个问题', 'group-b'), async () => assert.fail('a delivered queued reply must deduplicate'));
  assert.equal(calls, 2);
  await bot.handle(group('new-attempt', '另一个问题', 'group-b'), discard);
  assert.equal(calls, 3, 'a newly sent mention must run immediately after the previous generation finishes');
});

test('a slow group answer waits for the progress delivery and stores only the final conversation', { timeout: 3000 }, async t => {
  let finishGeneration; let finishHint; let hintStarted;
  const generated = new Promise(resolve => { finishGeneration = resolve; });
  const hintDelivery = new Promise(resolve => { finishHint = resolve; });
  const started = new Promise(resolve => { hintStarted = resolve; });
  t.after(() => { finishGeneration(); finishHint(); });
  const bot = await fixture(t, async () => { await generated; return '完整答案'; }, { progressDelayMs: 5 });
  const deliveries = [];
  const work = bot.handle(group('slow-answer', '请想一想'), async text => {
    if (text === '完整答案') { deliveries.push('answer'); return; }
    assert.match(text, /收到|正在|稍等|还在想/);
    deliveries.push('hint-start'); hintStarted();
    await hintDelivery;
    deliveries.push('hint-finish');
  });
  await started;
  finishGeneration();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deliveries, ['hint-start'], 'final answer must not race an unfinished progress send');
  finishHint();
  await work;
  assert.deepEqual(deliveries, ['hint-start', 'hint-finish', 'answer']);
  assert.deepEqual(Object.values(bot.state.groups).map(context => context.history), [[
    { role: 'user', content: '请想一想' }, { role: 'assistant', content: '完整答案' }
  ]]);
  assert.deepEqual(bot.state.history, []);
});

test('failed slow group generation waits for its progress send then rejects without saved history', { timeout: 3000 }, async t => {
  let failGeneration; let finishHint; let hintStarted;
  const failed = new Promise(resolve => { failGeneration = resolve; });
  const hintDelivery = new Promise(resolve => { finishHint = resolve; });
  const started = new Promise(resolve => { hintStarted = resolve; });
  t.after(() => { failGeneration(); finishHint(); });
  const bot = await fixture(t, async () => { await failed; throw new Error('model-offline'); }, { progressDelayMs: 5 });
  const replies = [];
  const work = bot.handle(group('slow-failure', '请想一想'), async text => {
    replies.push(text); hintStarted(); await hintDelivery;
  });
  let settled = false;
  work.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(work, /model-offline/);
  await started;
  failGeneration();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'caller fallback must wait until the progress send has finished');
  finishHint();
  await rejected;
  assert.equal(replies.length, 1);
  assert.match(replies[0], /收到|正在|稍等|还在想/);
  assert.equal(Object.values(bot.state.groups).every(context => context.history.length === 0), true);
  assert.deepEqual(bot.state.history, []);
  assert.equal(bot.state.seen.length, 0, 'a generation failure must remain retryable');
});

test('ordinary group follow-up replies never send a progress notice', async t => {
  const bot = await fixture(t, async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return '自然接话';
  }, { progressDelayMs: 5 });
  const replies = [];
  const result = await bot.handle({ ...group('ordinary', '接着刚才的话说'), explicit_mention: false }, async text => replies.push(text));
  assert.deepEqual(replies, ['自然接话']);
  assert.deepEqual(result, { status: 'replied' });
});

test('QQ group replies use the group endpoint and preserve passive reply sequencing', async () => {
  const calls = [];
  const client = new QQClient('1', 'dummy', { fetcher: async (url, request) => {
    calls.push({ url, request });
    return { ok: true, status: 200, json: async () => url.endsWith('getAppAccessToken')
      ? { access_token: 'test-token', expires_in: 7200 } : { id: 'reply' } };
  } });
  const message = group('incoming-id', '你好', 'group/a');
  await client.reply(message, '第一段', 1);
  await client.reply(message, '第二段', 2);
  assert.equal(calls.length, 3, 'token is reused for the second message');
  for (const [index, text] of ['第一段', '第二段'].entries()) {
    assert.equal(calls[index + 1].url, 'https://api.bot.qq.com/v2/groups/group%2Fa/messages');
    assert.equal(calls[index + 1].request.method, 'POST');
    assert.deepEqual(JSON.parse(calls[index + 1].request.body), { content: text, msg_type: 0, msg_id: 'incoming-id', msg_seq: index + 1 });
  }
});
