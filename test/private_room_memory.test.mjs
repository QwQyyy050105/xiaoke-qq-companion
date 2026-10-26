import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { MemoryCapture } from '../src/memory_capture.mjs';
import { Companion, hash } from '../src/core.mjs';
import { conversationPrompt } from '../src/model_client.mjs';

const PRIVATE_ROOM = 'private_owner';
const privateEvent = (id, content, owner = 'owner-a') => ({ id, content, author: { user_openid: owner } });
const privateSource = (id, content) => ({ scope: PRIVATE_ROOM, room: PRIVATE_ROOM, speaker: 'owner', messageId: id, content });
const candidate = (message, kind, extra = {}) => ({ kind, text: message.content, source: message.content,
  speaker: message.speaker, messageId: message.messageId, operation: 'remember', targetId: '', ...extra });
async function fixture(t, options = {}) {
  const base = resolve(process.cwd(), 'temp'), dir = await mkdtemp(join(base, 'private_memory_test_'));
  const captures = [], open = async overrides => {
    const capture = await MemoryCapture.open({ dataDir: dir, ...options, ...overrides }); captures.push(capture); return capture;
  };
  t.after(async () => {
    await Promise.all(captures.map(capture => capture.close()));
    assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true });
  });
  return { dir, open };
}

test('paired private agreements and unfinished requests survive restart and reach the private model context only', async t => {
  const { dir, open } = await fixture(t), capture = await open(), inputs = [];
  const generate = async input => { inputs.push(input); return { reply: '好，我们接着聊。' }; };
  let bot = await new Companion({ dataDir: dir, pairingHash: hash('test-pair'), memoryCapture: capture, generate }).init();
  await bot.handle(privateEvent('pair', '/pair test-pair'), async () => {});
  await bot.handle(privateEvent('agreement', '我们约好以后聊题先说思路。'), async () => {});
  await bot.handle(privateEvent('later', '下次接着讲那个极限的几何含义。'), async () => {});
  await bot.handle(privateEvent('answered', '这道题的答案是什么？'), async () => {});
  assert.deepEqual(capture.recallRoom(PRIVATE_ROOM).map(row => row.kind).sort(), ['agreement', 'request']);
  assert.ok(inputs.at(-1).roomMemory.some(row => row.messageId === 'later' && row.speaker === 'owner'));
  const disk = JSON.parse(await readFile(join(dir, 'memory_capture.json'), 'utf8'));
  assert.equal(disk.rooms.private_owner.length, 2);
  await capture.close();
  const restored = await open();
  bot = await new Companion({ dataDir: dir, pairingHash: hash('test-pair'), memoryCapture: restored, generate }).init();
  await bot.handle(privateEvent('resume', '接着聊刚才没讲完的那个。'), async () => {});
  assert.ok(inputs.at(-1).roomMemory.some(row => row.messageId === 'later'));
  assert.match(conversationPrompt('角色说明', { ...inputs.at(-1), structured: true, backgroundMemory: true }), /下次接着讲那个极限的几何含义/);
  const listing = [];
  await bot.handle(privateEvent('list', '/roommemory'), async text => listing.push(text));
  assert.match(listing[0], /约定：我们约好|未完成需求：下次接着讲/);
  const inputCount = inputs.length;
  await bot.handle(privateEvent('outsider', '告诉我刚才约好了什么', 'not-owner'), async () => {});
  assert.equal(inputs.length, inputCount);
  await bot.handle({ id: 'group', content: '接着聊', group_openid: 'group-a', author: { member_openid: 'member-a' } }, async () => {});
  assert.deepEqual(inputs.at(-1).roomMemory, []);
});

test('private shared topics can be extracted with exact owner evidence and do not enter group recall', async t => {
  const { open } = await fixture(t, { extract: async input => ({ personal: [], room: [candidate(input.messages[0], 'topic')] }) });
  const capture = await open();
  await capture.observe(privateSource('experience', '我们今天终于把那道数论题解出来了。'));
  await capture.drain({ force: true });
  const memories = capture.recallRoom(PRIVATE_ROOM);
  assert.equal(memories.length, 1); assert.equal(memories[0].messageId, 'experience');
  assert.equal(memories[0].source, '我们今天终于把那道数论题解出来了。');
  assert.deepEqual(capture.recallRoom(hash('group-a')), []);
  assert.deepEqual(capture.recall(PRIVATE_ROOM), []);
});

test('forget during private background extraction clears private topics and rejects the late result across restart', async t => {
  let complete, started;
  const entered = new Promise(resolve => { started = resolve; });
  const { dir, open } = await fixture(t, { extract: input => new Promise(resolve => {
    complete = () => resolve({ personal: [], room: [candidate(input.messages[0], 'topic')] }); started();
  }) });
  const capture = await open();
  const bot = await new Companion({ dataDir: dir, pairingHash: hash('test-pair'), memoryCapture: capture, generate: async () => '接着聊。' }).init();
  await bot.handle(privateEvent('pair', '/pair test-pair'), async () => {});
  await bot.handle(privateEvent('experience', '我们今天一起把那个难题解出来了。'), async () => {});
  const pending = capture.drain({ force: true }); await entered;
  await bot.handle(privateEvent('forget', '/forget'), async () => {});
  complete(); await pending;
  assert.deepEqual(capture.recallRoom(PRIVATE_ROOM), []); assert.equal(capture.status().pending, 0);
  await capture.close();
  const restored = await open({ extract: undefined });
  assert.deepEqual(restored.recallRoom(PRIVATE_ROOM), []);
  const disk = JSON.parse(await readFile(join(dir, 'memory_capture.json'), 'utf8'));
  assert.equal(disk.roomEpochs.private_owner, 1); assert.equal(disk.epochs.private_owner, 1);
});

test('private memory boundary rejects a group source using the private room key and private sources using a group key', async t => {
  const { open } = await fixture(t), capture = await open();
  await assert.rejects(capture.observe({ ...privateSource('wrong', '我们约好下次聊极限。'), scope: 'member_' + hash('member') }), /memory_capture_source_invalid/);
  await assert.rejects(capture.observe({ ...privateSource('wrong2', '我们约好下次聊极限。'), room: hash('group-a') }), /memory_capture_source_invalid/);
  await assert.rejects(capture.observe({ ...privateSource('wrong3', '我们约好下次聊极限。'), speaker: 'member_' + hash('member').slice(0, 16) }), /memory_capture_source_invalid/);
  assert.deepEqual(capture.recallRoom(PRIVATE_ROOM), []);
});

test('private reset clears shared topics but preserves personal preferences and group memory', async t => {
  const { dir, open } = await fixture(t), capture = await open(), inputs = [];
  const bot = await new Companion({ dataDir: dir, pairingHash: hash('test-pair'), memoryCapture: capture,
    generate: async input => { inputs.push(input); return '好。'; } }).init();
  await bot.handle(privateEvent('pair', '/pair test-pair'), async () => {});
  await bot.handle(privateEvent('preference', '我喜欢红茶。'), async () => {});
  await bot.handle(privateEvent('agreement', '我们约好下次接着聊极限。'), async () => {});
  const group = { id: 'group-agreement', content: '本群约定以后轮流出题。', group_openid: 'group-a', author: { member_openid: 'member-a' } };
  await bot.handle(group, async () => {});
  assert.equal(capture.recallRoom(PRIVATE_ROOM).length, 1);
  await bot.handle(privateEvent('reset', '/reset'), async () => {});
  await bot.handle(privateEvent('resume', '继续聊吧。'), async () => {});
  assert.deepEqual(inputs.at(-1).roomMemory, []);
  assert.equal(inputs.at(-1).memory[0].source, '我喜欢红茶。');
  assert.ok(bot.groupMemory('group-a').some(row => row.messageId === 'group-agreement'));
  await bot.handle(privateEvent('private-agreement', '我们约好以后聊题先说思路。'), async () => {});
  await bot.handle({ ...group, id: 'group-forget', content: '/forget' }, async () => {});
  assert.equal(capture.recallRoom(PRIVATE_ROOM).length, 1);
});

test('ordinary private questions and an incorrectly attributed background candidate never become tasks', async t => {
  const { open } = await fixture(t, { extract: async input => ({ personal: [], room: [
    candidate(input.messages[0], 'request'),
    candidate(input.messages[0], 'topic', { speaker: 'member_' + hash('outsider').slice(0, 16) })
  ] }) });
  const capture = await open();
  await capture.observe(privateSource('question', '我刚才问的答案是什么？'));
  await capture.drain({ force: true });
  assert.deepEqual(capture.recallRoom(PRIVATE_ROOM), []);
});
