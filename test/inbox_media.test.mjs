import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rm, access } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { GroupInbox } from '../src/inbox.mjs';
import { prepareConversationInput } from '../src/conversation_input.mjs';
import { Companion, hash } from '../src/core.mjs';
import { GroupRouter } from '../src/routing.mjs';

const event = (id, member, extra = {}) => ({ id, content: `来自 ${member}`, group_openid: 'group-a',
  author: { member_openid: member }, explicit_mention: false, allow_silence: true, ...extra });
const attachment = name => ({ url: `https://example.invalid/${name}.png`, content_type: 'image/png' });
const inboxFor = handle => new GroupInbox({ handle, batchParticipants: true, delayMs: 100, gapMs: 0,
  sleep: async () => { await new Promise(resolve => setImmediate(resolve)); } });

test('multi-member batches retain independent cloned attachment and quote metadata for each original author', async () => {
  let batch;
  const inbox = inboxFor(async item => { batch = item; });
  const a = event('a', 'alice', { attachments: [attachment('alice')], message_scene: { ext: ['ref_msg_idx=alice-quote'] },
    message_reference: { message_id: 'alice-previous' }, msg_elements: [{ type: 'text', content: 'alice metadata' }], message_type: 7 });
  const b = event('b', 'bob', { attachments: [attachment('bob')], message_scene: { ext: ['ref_msg_idx=bob-quote'] },
    message_reference: { message_id: 'bob-previous' }, msg_elements: [{ type: 'text', content: 'bob metadata' }], message_type: 8 });
  const jobs = [inbox.enqueue(a), inbox.enqueue(b)];
  a.attachments[0].url = 'https://example.invalid/tampered.png';
  a.message_scene.ext[0] = 'tampered'; b.msg_elements[0].content = 'tampered';
  await Promise.all(jobs);
  assert.deepEqual(batch.turn_messages.map(message => [message.id, message.author.member_openid, message.attachments[0].url]), [
    ['a', 'alice', 'https://example.invalid/alice.png'], ['b', 'bob', 'https://example.invalid/bob.png']
  ]);
  assert.deepEqual(batch.turn_messages.map(message => message.message_scene.ext), [['ref_msg_idx=alice-quote'], ['ref_msg_idx=bob-quote']]);
  assert.deepEqual(batch.turn_messages.map(message => message.message_reference.message_id), ['alice-previous', 'bob-previous']);
  assert.deepEqual(batch.turn_messages.map(message => message.msg_elements[0].content), ['alice metadata', 'bob metadata']);
  assert.deepEqual(batch.turn_messages.map(message => message.message_type), [7, 8]);
});

test('preparing a batch never gives an earlier plain message the last member attachment or quote', async () => {
  const observed = []; let requested; let prepared;
  const media = {
    observe: message => observed.push(structuredClone(message)),
    contextFor: () => ({ images: observed.flatMap(message => (message.attachments || []).map((_, i) => ({ id: `pic-${message.id}-${i}`, message_id: message.id }))) }),
    visionFiles: async (_, options) => { requested = options.ids; return []; }
  };
  const inbox = inboxFor(async batch => { prepared = await prepareConversationInput(media, batch, [
    { speaker: 'member_original', messageId: 'original-user', referenceId: 'bob-quote', content: '被引用原文' }
  ]); });
  await Promise.all([
    inbox.enqueue(event('plain-a', 'alice')),
    inbox.enqueue(event('picture-b', 'bob', { attachments: [attachment('bob')], message_scene: { ext: ['ref_msg_idx=bob-quote'] },
      message_reference: { message_id: 'original-user' } }))
  ]);
  assert.equal(Object.hasOwn(observed[0], 'attachments'), false);
  assert.equal(Object.hasOwn(observed[0], 'message_scene'), false);
  assert.equal(Object.hasOwn(observed[0], 'message_reference'), false);
  assert.equal(observed[0].author.member_openid, 'alice');
  assert.equal(observed[1].author.member_openid, 'bob');
  assert.deepEqual(requested, ['pic-picture-b-0']);
  assert.equal(prepared.quotes.length, 1);
  assert.equal(prepared.quotes[0].speaker, 'member_original');
  assert.equal(prepared.quotes[0].content, '被引用原文');
  assert.equal(prepared.quotes[0].sourceMessageId, 'picture-b');
});

test('a batch permits silence only when every member turn is ordinary and explicitly allows it', async () => {
  for (const first of [
    { allow_silence: false }, { explicit_mention: true, allow_silence: true }, { allow_silence: undefined }
  ]) {
    let batch;
    const inbox = inboxFor(async item => { batch = item; });
    await Promise.all([inbox.enqueue(event('a', 'alice', first)), inbox.enqueue(event('b', 'bob'))]);
    assert.equal(batch.allow_silence, false);
  }
  let ordinary;
  const inbox = inboxFor(async item => { ordinary = item; });
  await Promise.all([inbox.enqueue(event('a', 'alice')), inbox.enqueue(event('b', 'bob'))]);
  assert.equal(ordinary.allow_silence, true);
});

test('a queued duplicate with richer quote and attachment metadata revokes silence without duplicating its source', async () => {
  let batch;
  const inbox = inboxFor(async item => { batch = item; });
  const jobs = [inbox.enqueue(event('a', 'alice', { message_scene: { ext: ['msg_idx=original-a'], transport: 'initial' } })), inbox.enqueue(event('b', 'bob'))];
  jobs.push(inbox.enqueue(event('a', 'alice', { explicit_mention: true, allow_silence: false,
    message_scene: { ext: ['ref_msg_idx=bot-original'], kind: 'quote' },
    message_reference: { message_id: 'bot-original' }, attachments: [attachment('alice-later')] })));
  await Promise.all(jobs);
  assert.deepEqual(batch.source_ids, ['a', 'b']);
  assert.equal(batch.id, 'b');
  assert.equal(batch.allow_silence, false);
  assert.equal(batch.explicit_mention, true);
  assert.equal(batch.turn_messages[0].explicit_mention, true);
  assert.equal(batch.turn_messages[1].explicit_mention, false);
  assert.deepEqual(batch.turn_messages[0].message_scene, {
    ext: ['msg_idx=original-a', 'ref_msg_idx=bot-original'], transport: 'initial', kind: 'quote'
  });
  assert.equal(batch.turn_messages[0].message_reference.message_id, 'bot-original');
  assert.equal(batch.turn_messages[0].attachments[0].url, 'https://example.invalid/alice-later.png');
});

async function coreFixture(t, { generate, prepareInput = async () => ({}), releaseInput = async () => {} }) {
  const tempRoot = resolve(process.cwd(), 'temp');
  const dir = await mkdtemp(join(tempRoot, 'inbox_media_test_'));
  const bot = await new Companion({ dataDir: dir, pairingHash: hash('test-code'), generate,
    prepareInput: evt => prepareInput(evt, dir), releaseInput }).init();
  t.after(async () => {
    await bot.persistence;
    assert.ok(resolve(dir).startsWith(tempRoot + sep));
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(access(dir), error => error.code === 'ENOENT');
  });
  return { bot, dir };
}

test('successful delivery receipts preserve every actual bubble and image reference plus the text members really received', async t => {
  const { bot } = await coreFixture(t, { generate: async () => ({ reply: 'model aggregate text', messages: ['同一句。', '同一句。'] }) });
  const alice = event('alice-request', 'alice'), bob = event('bob-request', 'bob');
  const batch = { ...bob, turn_messages: [alice, bob], source_ids: [alice.id, bob.id] };
  const receipts = [
    { content: '同一句。', messageId: 'first-bubble', referenceId: 'first-qq-index' },
    { content: '同一句。', messageId: 'second-bubble', referenceId: 'second-qq-index' },
    { content: '[小柯发出图片：微笑]', messageId: 'image-bubble', referenceId: 'image-qq-index' }
  ];
  const actualText = receipts.map(item => item.content).join('\n\n');
  assert.deepEqual(await bot.handle(batch, async () => {
    for (const receipt of receipts) await bot.recordGroupAssistant('group-a', receipt.content, {
      ...receipt, originId: batch.id, speaker: bot.groupSpeaker('group-a', 'bob'),
      speakers: [bot.groupSpeaker('group-a', 'alice'), bot.groupSpeaker('group-a', 'bob')]
    });
    return { id: 'image-bubble', sent_text: actualText, delivered_messages: receipts };
  }), { status: 'replied' });
  const history = bot.groupContext('group-a');
  const assistant = history.filter(item => item.role === 'assistant');
  assert.deepEqual(assistant.map(item => [item.content, item.messageId, item.referenceId]), receipts.map(item => [item.content, item.messageId, item.referenceId]));
  assert.equal(assistant.every(item => item.originId === 'bob-request'), true);
  for (const item of assistant) assert.deepEqual(item.reply_to_speakers, [bot.groupSpeaker('group-a', 'alice'), bot.groupSpeaker('group-a', 'bob')]);
  for (const member of ['alice', 'bob']) {
    const context = bot.state.groups[hash(JSON.stringify(['group-a', member]))];
    assert.equal(context.history.at(-1).content, actualText);
    assert.doesNotMatch(JSON.stringify(context.history), /model aggregate text/);
  }
  const router = new GroupRouter();
  assert.equal((await router.decide(event('quote-first', 'alice', { message_reference: { message_id: 'first-bubble' } }), history)).reason, 'references_bot_reply');
  assert.equal((await router.decide(event('quote-image', 'bob', { message_scene: { ext: ['ref_msg_idx=image-qq-index'] } }), history)).reason, 'references_bot_reply');
  assert.equal(await bot.recordGroupAssistant('group-a', receipts[0].content, { originId: 'bob-request', messageId: receipts[0].messageId }), false);
});

test('legacy single-message delivery still records the generated reply once with the actual returned QQ ID', async t => {
  const { bot } = await coreFixture(t, { generate: async () => '普通回复。' });
  await bot.handle(event('legacy-request', 'alice'), async () => ({ body: { id: 'legacy-bot-id' } }));
  const assistant = bot.groupContext('group-a').filter(item => item.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].content, '普通回复。');
  assert.equal(assistant[0].messageId, 'legacy-bot-id');
  assert.equal(bot.state.groups[hash(JSON.stringify(['group-a', 'alice']))].history.at(-1).content, '普通回复。');
});

test('a partial delivery preserves acknowledged public receipts without committing unconfirmed answer or learned memory', async t => {
  const { bot } = await coreFixture(t, { generate: async () => ({ reply: '完整模型回复', memories: [{ text: '我喜欢猫。', source: '我喜欢猫。' }] }) });
  const input = event('partial-request', 'alice', { content: '我喜欢猫。' });
  await assert.rejects(bot.handle(input, async () => {
    await bot.recordGroupAssistant('group-a', '第一条已发出的回复', { originId: input.id, messageId: 'partial-bot-id', speaker: bot.groupSpeaker('group-a', 'alice') });
    throw new Error('later-bubble-failed');
  }), /later-bubble-failed/);
  const member = bot.state.groups[hash(JSON.stringify(['group-a', 'alice']))];
  assert.deepEqual(member.memory, []);
  assert.deepEqual(member.history, []);
  const assistant = bot.groupContext('group-a').filter(item => item.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].content, '第一条已发出的回复');
  assert.equal(assistant[0].messageId, 'partial-bot-id');
  assert.doesNotMatch(JSON.stringify(bot.groupContext('group-a')), /完整模型回复/);
});

for (const failure of ['length_rejection', 'pre_generation_persist', 'generation_failure', 'success']) {
  test(`prepared vision files are released on ${failure}`, async t => {
    let preparedPath, preparedObject, released = 0, generations = 0, failNextPersist = false;
    const { bot, dir } = await coreFixture(t, {
      prepareInput: async (evt, directory) => {
        preparedPath = join(directory, 'vision_fixture.png');
        await writeFile(preparedPath, 'isolated synthetic fixture, not a real image');
        preparedObject = { visionFiles: [{ id: 'fixture-image', path: preparedPath }], mediaCatalog: [{ id: 'fixture-image' }] };
        failNextPersist = failure === 'pre_generation_persist';
        return preparedObject;
      },
      releaseInput: async (prepared, evt) => {
        assert.equal(prepared, preparedObject); assert.equal(evt.id, 'input');
        assert.ok(resolve(preparedPath).startsWith(resolve(dir) + sep));
        released++; await unlink(preparedPath);
      },
      generate: async () => { generations++; if (failure === 'generation_failure') throw new Error('model-fixture-failure'); return '看到了。'; }
    });
    const persist = bot.persist.bind(bot);
    bot.persist = () => { if (failNextPersist) { failNextPersist = false; return Promise.reject(new Error('persist-fixture-failure')); } return persist(); };
    const input = event('input', 'alice', { content: failure === 'length_rejection' ? '长'.repeat(8001) : '看看图片' });
    const work = bot.handle(input, async () => ({ id: 'real-bot-id' }));
    if (failure === 'pre_generation_persist') await assert.rejects(work, /persist-fixture-failure/);
    else if (failure === 'generation_failure') await assert.rejects(work, /model-fixture-failure/);
    else await work;
    assert.equal(released, 1);
    assert.equal(generations, ['generation_failure', 'success'].includes(failure) ? 1 : 0);
    await assert.rejects(access(preparedPath), error => error.code === 'ENOENT');
  });
}
