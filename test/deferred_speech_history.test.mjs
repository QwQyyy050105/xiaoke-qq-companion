import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { Companion, hash } from '../src/core.mjs';

const base = path.resolve('temp');
const privateEvent = (id, content = '用语音聊聊', owner = 'owner') => ({ id, content, author: { user_openid: owner } });
const groupEvent = (id, content = '用语音聊聊', group = 'group-a', member = 'member-a') =>
  ({ id, content, group_openid: group, author: { member_openid: member } });
const deferred = (content = '', id = '') => ({ deferredSpeech: { jobId: 'synthetic-voice-job' }, sent_text: content,
  delivered_messages: id ? [{ content, messageId: id }] : [] });
const memberKey = (group, member) => hash(JSON.stringify([group, member]));
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, { generate = async () => ({ reply: '尚未送达的完整回答', speech: { text: '尚未送达的语音正文' } }), ...options } = {}) {
  const dir = await mkdtemp(path.join(base, 'deferred_speech_history_'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(dir)), await realpath(base));
    await rm(dir, { recursive: true, force: true });
  });
  const bot = await new Companion({ dataDir: dir, pairingHash: hash('synthetic-pair-code'), generate, ...options }).init();
  bot.state.owner = 'owner'; await bot.persist();
  return bot;
}
const disk = async bot => JSON.parse(await readFile(bot.statePath, 'utf8'));

test('deferred private speech keeps received feedback growth while recording only delivered speech history', async t => {
  const observed = [], growth = [];
  const bot = await fixture(t, { generate: async () => ({ reply: '声称已经完成的计划回答', speech: { text: '计划语音' },
    memories: ['喜欢猫'], character_updates: [{ text: '计划性格更新' }], room_memories: [{ operation: 'resolve', text: '完成语音需求' }],
    social: { action: 'say', clear_topic: true } }),
    memoryCapture: { observe: async value => observed.push(value), recall: () => [], recallRoom: () => [] },
    characterGrowth: { snapshot: () => ({ revision: 0 }), apply: async (...values) => growth.push(values) } });
  const event = privateEvent('private-deferred', '我喜欢猫，用语音聊聊');
  const result = await bot.handle(event, async () => deferred('我把声音准备一下。', 'progress-1'));
  assert.equal(result.status, 'deferred_speech'); assert.equal(result.social, undefined);
  assert.deepEqual(bot.state.history.map(item => [item.role, item.content]), [['user', event.content], ['assistant', '我把声音准备一下。']]);
  assert.equal(observed.length, 1); assert.equal(observed[0].content, event.content);
  assert.equal(growth.length, 1); assert.deepEqual(bot.state.memory, []);
  assert.doesNotMatch(JSON.stringify(await disk(bot)), /声称已经完成|计划语音|计划性格更新|媒体回复已送达/);
});

test('unconfirmed or absent progress leaves only the user until an actual final message receipt arrives', async t => {
  const bot = await fixture(t, { generate: async () => ({ reply: '', speech: { text: '尚未送达的纯语音' } }) });
  const event = privateEvent('no-progress'), epoch = bot.deliveryEpoch(event);
  await bot.handle(event, async () => ({ ...deferred('仅有字符串，没有消息回执'), delivered_messages: [{ content: '也没有消息 id' }] }));
  assert.deepEqual(bot.state.history.map(item => item.role), ['user']);
  assert.equal(await bot.recordDeliveredAssistant(event, '[语音：现在真的说出来了]', {}, { epoch }), false);
  assert.equal(await bot.recordDeliveredAssistant(event, '[语音：现在真的说出来了]', { id: 'voice-1' }, { epoch }), true);
  assert.deepEqual(bot.state.history.map(item => item.content), [event.content, '[语音：现在真的说出来了]']);
});

test('deferred group completion keeps the real unfinished request without committing model-selected room memory', async t => {
  const bot = await fixture(t, { generate: async input => ({ reply: '语音需求已经完成', speech: { text: '计划语音' },
    room_memories: [{ kind: 'topic', text: '龙角就是天线。', source: '龙角就是天线。', operation: 'remember',
      speaker: input.turnMessages[0].speaker, messageId: input.turnMessages[0].messageId }] }) });
  const event = groupEvent('group-request', '稍后发一段晚安语音，龙角就是天线。');
  await bot.handle(event, async () => deferred());
  assert.deepEqual(bot.state.groups[memberKey('group-a', 'member-a')].history.map(item => item.role), ['user']);
  assert.equal(bot.groupContext('group-a').some(item => item.role === 'assistant'), false);
  assert.doesNotMatch(JSON.stringify(bot.state.rooms), /语音需求已经完成|计划语音/);
  assert.ok(bot.groupMemory('group-a').some(item => item.kind === 'request' && item.status !== 'resolved'));
  assert.equal(bot.groupMemory('group-a').some(item => item.kind === 'topic'), false);
});

test('the next same-scope turn continues while deferred speech is pending and sees only actually delivered history', async t => {
  const inputs = [];
  const bot = await fixture(t, { generate: async input => { inputs.push(structuredClone(input)); return inputs.length === 1
    ? { reply: '未发送的第一句', speech: { text: '未发送的第一段语音' } } : { reply: '第二条正常聊天' }; } });
  const first = privateEvent('first'), token = bot.deliveryEpoch(first);
  await bot.handle(first, async () => deferred('声音在准备。', 'progress-first'));
  assert.equal(bot.pending, 0);
  await bot.handle(privateEvent('second', '那先聊别的'), async () => ({ id: 'second-reply', sent_text: '第二条正常聊天' }));
  assert.equal(inputs.length, 2); assert.deepEqual(inputs[1].history.map(item => item.content), [first.content, '声音在准备。']);
  assert.equal(await bot.recordDeliveredAssistant(first, '[语音：现在接上第一句]', { body: { id: 'late-voice' } }, { epoch: token }), true);
  assert.equal(bot.state.history.at(-1).content, '[语音：现在接上第一句]');
});

test('final receipt history stays in its owner or exact group/member and mismatched tokens are rejected', async t => {
  const bot = await fixture(t), own = privateEvent('private-final'), group = groupEvent('group-final');
  bot.state.history = [{ role: 'user', content: '私聊原文' }];
  bot.state.groups[memberKey('group-a', 'member-b')] = { history: [{ role: 'user', content: '另一个成员原文' }], memory: [] };
  bot.state.groups[memberKey('group-b', 'member-a')] = { history: [{ role: 'user', content: '另一个群原文' }], memory: [] };
  const ownEpoch = bot.deliveryEpoch(own), groupEpoch = bot.deliveryEpoch(group);
  assert.equal(await bot.recordDeliveredAssistant(group, '错误绑定', { id: 'wrong-1' }, { epoch: ownEpoch }), false);
  assert.equal(await bot.recordDeliveredAssistant(groupEvent('group-final', '', 'group-a', 'member-b'), '错成员', { id: 'wrong-2' }, { epoch: groupEpoch }), false);
  assert.equal(await bot.recordDeliveredAssistant(groupEvent('group-final', '', 'group-b'), '错群', { id: 'wrong-3' }, { epoch: groupEpoch }), false);
  assert.equal(await bot.recordDeliveredAssistant(group, '[语音：只给这个群]', { messageId: 'group-voice' }, { epoch: groupEpoch }), true);
  assert.deepEqual(bot.state.history.map(item => item.content), ['私聊原文']);
  assert.deepEqual(bot.state.groups[memberKey('group-a', 'member-b')].history.map(item => item.content), ['另一个成员原文']);
  assert.deepEqual(bot.state.groups[memberKey('group-b', 'member-a')].history.map(item => item.content), ['另一个群原文']);
  assert.equal(bot.state.groups[memberKey('group-a', 'member-a')].history.at(-1).content, '[语音：只给这个群]');
  assert.equal(bot.groupContext('group-a').at(-1).messageId, 'group-voice'); assert.deepEqual(bot.groupContext('group-b'), []);
  assert.equal(await bot.recordDeliveredAssistant(own, '[语音：主人私聊]', { id: 'private-voice' }, { epoch: ownEpoch }), true);
  assert.equal(bot.groupContext('group-a').length, 1);
  assert.equal(bot.deliveryEpoch(privateEvent('stranger', '', 'other')), null);
  assert.equal(bot.deliveryEpoch({ ...own, chat_type: 'group' }), null);
  assert.equal(bot.deliveryEpoch({ ...group, group_openid: { invalid: true } }), null);
});

test('a batched group voice is attached only to the validated participants of that same group', async t => {
  const bot = await fixture(t), event = { ...groupEvent('batch'), turn_messages: [
    groupEvent('member-a-question', '甲的问题'), groupEvent('member-b-question', '乙的问题', 'group-a', 'member-b'),
    groupEvent('foreign-question', '别群问题', 'group-b', 'foreign-member')
  ] }, epoch = bot.deliveryEpoch(event);
  await bot.handle(event, async () => deferred());
  // The QQ transport already records public group receipts before the deferred
  // callback adds the corresponding personal contexts.
  await bot.recordGroupAssistant('group-a', '[语音：一起接上]', { messageId: 'batch-voice', originId: event.id,
    speakers: ['member-a', 'member-b'].map(member => bot.groupSpeaker('group-a', member)) });
  await bot.recordDeliveredAssistant(event, '[语音：一起接上]', { id: 'batch-voice' }, { epoch });
  for (const member of ['member-a', 'member-b']) assert.equal(bot.state.groups[memberKey('group-a', member)].history.at(-1).messageId, 'batch-voice');
  assert.equal(bot.state.groups[memberKey('group-a', 'foreign-member')], undefined);
  assert.equal(bot.state.groups[memberKey('group-b', 'foreign-member')], undefined);
  assert.equal(bot.groupContext('group-a').at(-1).reply_to_speakers.length, 2);
  assert.equal(bot.groupContext('group-a').filter(item => item.messageId === 'batch-voice').length, 1);
});

test('message receipt deduplication survives restart, changed text and a later reset', async t => {
  const bot = await fixture(t), event = privateEvent('dedup'), epoch = bot.deliveryEpoch(event);
  assert.equal(await bot.recordDeliveredAssistant(event, '实际语音', { id: 'dedup-voice' }, { epoch }), true);
  assert.equal(await bot.recordDeliveredAssistant(event, '重复但正文换了', { id: 'dedup-voice' }, { epoch }), false);
  const restored = await new Companion({ dataDir: bot.dataDir, generate: async () => '' }).init();
  assert.equal(await restored.recordDeliveredAssistant(event, '重启后重复', { id: 'dedup-voice' }, { epoch: restored.deliveryEpoch(event) }), false);
  await restored.handle(privateEvent('dedup-reset', '/reset'), async () => ({}));
  assert.equal(await restored.recordDeliveredAssistant(event, '清空后重复', { id: 'dedup-voice' }, { epoch: restored.deliveryEpoch(event) }), false);
  assert.deepEqual(restored.state.history, []);
});

test('forget and reset invalidate old tokens immediately without invalidating another scope', async t => {
  const bot = await fixture(t), group = groupEvent('old-group'), privateMessage = privateEvent('old-private');
  const groupEpoch = bot.deliveryEpoch(group), ownEpoch = bot.deliveryEpoch(privateMessage);
  bot.invalidateDeliveries(groupEvent('forget-by-another-member', '/forget', 'group-a', 'member-b'));
  assert.equal(bot.isDeliveryCurrent(group, groupEpoch), false); assert.equal(bot.isDeliveryCurrent(privateMessage, ownEpoch), true);
  assert.equal(await bot.recordDeliveredAssistant(group, '不能复活', { id: 'old-group-voice' }, { epoch: groupEpoch }), false);
  const pending = bot.handle(privateEvent('reset-now', '/reset'), async () => ({}));
  assert.equal(bot.isDeliveryCurrent(privateMessage, ownEpoch), false); await pending;
  assert.equal(await bot.recordDeliveredAssistant(privateMessage, '不能复活', { id: 'old-private-voice' }, { epoch: ownEpoch }), false);
  assert.deepEqual(bot.state.history, []);
});

for (const type of ['private', 'group']) test(type + ' forget while final-receipt persistence is queued cannot resurrect history on disk', async t => {
  const bot = await fixture(t), event = type === 'private' ? privateEvent('persisting') : groupEvent('persisting');
  const epoch = bot.deliveryEpoch(event), gate = barrier(); bot.persistence = gate.promise;
  const recording = bot.recordDeliveredAssistant(event, '保存期间到达的真实语音', { id: 'persisting-voice' }, { epoch });
  const forgetting = bot.handle(type === 'private' ? privateEvent('forget', '/forget') : groupEvent('forget', '/forget'), async () => ({}));
  assert.equal(bot.isDeliveryCurrent(event, epoch), false); gate.resolve();
  assert.equal(await recording, false); await forgetting; await bot.persistence;
  const saved = await disk(bot);
  assert.doesNotMatch(JSON.stringify(saved.history), /保存期间/);
  assert.doesNotMatch(JSON.stringify(saved.groups), /保存期间/);
  assert.doesNotMatch(JSON.stringify(saved.rooms), /保存期间/);
  assert.equal(await bot.recordDeliveredAssistant(event, '旧回执重放', { id: 'persisting-voice' }, { epoch }), false);
});

test('forget while deferred send is returning prevents stale user/progress history from being published later', async t => {
  const bot = await fixture(t), ready = barrier(), gate = barrier();
  const first = bot.handle(privateEvent('in-send'), async () => { ready.resolve(); await gate.promise; return deferred('过期进度', 'obsolete-progress'); });
  await ready.promise; const forgetting = bot.handle(privateEvent('forget-during-send', '/forget'), async () => ({}));
  gate.resolve(); await first; await forgetting;
  assert.deepEqual(bot.state.history, []); assert.deepEqual((await disk(bot)).history, []);
});

for (const type of ['private', 'group']) test(type + ' early final receipt is ordered after user/progress and never duplicated', async t => {
  const bot = await fixture(t), event = type === 'private' ? privateEvent('early') : groupEvent('early'), epoch = bot.deliveryEpoch(event);
  await bot.handle(event, async () => {
    assert.equal(await bot.recordDeliveredAssistant(event, '[语音：已经送达]', { id: 'early-voice' }, { epoch }), true);
    return { ...deferred('实际准备进度', 'early-progress'), delivered_messages: [
      { content: '实际准备进度', messageId: 'early-progress' }, { content: '[语音：已经送达]', messageId: 'early-voice' }
    ] };
  });
  const history = type === 'private' ? bot.state.history : bot.state.groups[memberKey('group-a', 'member-a')].history;
  assert.deepEqual(history.map(item => item.content), [event.content, '实际准备进度', '[语音：已经送达]']);
  if (type === 'group') assert.deepEqual(bot.groupContext('group-a').map(item => item.content), [event.content, '实际准备进度', '[语音：已经送达]']);
  assert.equal(await bot.recordDeliveredAssistant(event, '[语音：已经送达]', { id: 'early-voice' }, { epoch }), false);
});

test('missing receipt, a false guard, and a failed persistence never claim a newly recorded delivery', async t => {
  const bot = await fixture(t), event = privateEvent('guarded'), epoch = bot.deliveryEpoch(event);
  for (const receipt of [{}, { id: '' }, { id: 12 }, { id: 'false-success', success: false }]) assert.equal(await bot.recordDeliveredAssistant(event, '实际语音', receipt, { epoch }), false);
  assert.equal(await bot.recordDeliveredAssistant(event, '实际语音', { id: 'guarded-voice' }, { epoch, guard: () => false }), false);
  const persist = bot.persist.bind(bot); bot.persist = async () => { throw Error('synthetic disk failure'); };
  await assert.rejects(bot.recordDeliveredAssistant(event, '实际语音', { id: 'retry-voice' }, { epoch }), /synthetic disk failure/);
  assert.deepEqual(bot.state.history, []); assert.deepEqual(bot.state.deliveredAssistantReceipts, []);
  bot.persist = persist; assert.equal(await bot.recordDeliveredAssistant(event, '实际语音', { id: 'retry-voice' }, { epoch }), true);
});

test('ordinary fast-path replies retain existing history and growth behavior', async t => {
  const growth = [];
  const bot = await fixture(t, { generate: async () => ({ reply: '普通同步回答', character_updates: [{ text: '已送达的变化' }] }),
    characterGrowth: { snapshot: () => ({ revision: 0 }), apply: async (...values) => growth.push(values) } });
  const result = await bot.handle(privateEvent('fast'), async () => ({ id: 'fast-message', sent_text: '实际同步回答' }));
  assert.equal(result.status, 'replied'); assert.equal(bot.state.history.at(-1).content, '实际同步回答');
  assert.equal(growth.length, 1); assert.deepEqual(bot.state.deliveredAssistantReceipts, []);
});

test('only the final model reply has the server-owned chatReply flag, never the slow-model progress notice', async t => {
  const progress = barrier(), finish = barrier(), sent = [];
  const bot = await fixture(t, { progressDelayMs: 5, generate: async () => { await finish.promise; return { reply: '最终回答', chatReply: false }; } });
  const work = bot.handle(groupEvent('slow-generation'), async (text, options) => {
    sent.push({ text, options });
    if (!options?.chatReply) progress.resolve();
    return { id: 'actual-' + sent.length, sent_text: text };
  });
  await progress.promise; assert.equal(sent.length, 1); assert.equal(sent[0].options?.chatReply, undefined);
  finish.resolve(); await work;
  assert.equal(sent.length, 2); assert.equal(sent[1].text, '最终回答'); assert.equal(sent[1].options.chatReply, true);
});

test('a failed final-receipt write does not evict previously retained history or room deduplication', async t => {
  const bot = await fixture(t), event = groupEvent('failed-full-history'), token = bot.deliveryEpoch(event);
  const context = bot.state.groups[memberKey('group-a', 'member-a')] = { history: Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: 'old-' + index })), memory: [] };
  const room = bot.room('group-a'); room.recent = Array.from({ length: 60 }, (_, index) => ({ role: 'user', content: 'room-' + index })); room.assistantSeen = ['existing-room-key'];
  const originalHistory = structuredClone(context.history), originalRoom = structuredClone(room);
  bot.persist = async () => { throw Error('synthetic disk failure'); };
  await assert.rejects(bot.recordDeliveredAssistant(event, 'new actual voice', { id: 'failed-full-voice' }, { epoch: token }), /synthetic disk failure/);
  assert.deepEqual(context.history, originalHistory); assert.deepEqual(room, originalRoom);
});
