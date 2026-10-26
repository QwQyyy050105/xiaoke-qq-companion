import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ProactiveCompanion } from '../src/proactive.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const event = (id, content = '我们聊聊游戏', group = 'room-a') => ({ id, content, group_openid: group, chat_type: 'group', author: { member_openid: 'member-a' } });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waveSelection = () => ({ fit: 'contextual', message_id: '', catalog_evidence: '小柯挥手', intent: '用挥手表情自然打个招呼。' });
async function fixture(t, options = {}) {
  const root = resolve(process.cwd(), 'temp');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(join(root, 'proactive_extensions_'));
  let time = Date.parse('2026-10-22T04:00:00Z');
  const generated = [], sent = [];
  const config = { dataDir, now: () => time, random: () => 0, isAwake: () => true,
    getMediaCatalog: () => [{ id: 'approved_wave', label: '小柯挥手', type: 'sticker' }],
    getVoiceCatalog: () => [{ id: 'voice_hello', label: '小柯问好' }],
    generate: async input => { generated.push(input); return { reply: '', social: { action: 'say' }, media: { send_id: 'approved_wave', selection: waveSelection() } }; },
    send: async (group, text, options) => { sent.push({ group, text, options }); }, ...options };
  const bot = await new ProactiveCompanion(config).init();
  t.after(async () => { await bot.writeQueue; assert.ok(resolve(dataDir).startsWith(root + sep)); await rm(dataDir, { recursive: true, force: true }); await assert.rejects(access(dataDir), { code: 'ENOENT' }); });
  const due = async (id = 'first', group = 'room-a') => { await bot.observe(event(id, undefined, group)); time += 30 * MINUTE; };
  return { bot, config, dataDir, generated, sent, due, advance: ms => { time += ms; } };
}

test('proactive catalogs are scoped metadata copies, rank stickers ahead of avatars and authorize only original IDs', async t => {
  const calls = [], inputs = [];
  const images = [
    { id: 'approved_avatar', type: 'avatar', label: '小柯头像', path: 'secret-file', token: 'secret-token' },
    { id: 'collected_wave', type: 'sticker', title: '挥手', label: '小柯挥手', tags: ['招呼'], group_openid: 'room-a' },
    { id: 'foreign_image', type: 'sticker', group_openid: 'room-b', label: '别群专用' }
  ];
  const f = await fixture(t, {
    getMediaCatalog: async group => { calls.push(['images', group]); return images; },
    getVoiceCatalog: group => { calls.push(['voices', group]); return [{ id: 'voice_hello', label: '你好', path: 'voice-secret' }]; },
    generate: async input => {
      inputs.push(structuredClone(input));
      input.mediaCatalog.push({ id: 'forged_image', label: '模型添加' });
      input.mediaCatalog[0].label = '模型修改';
      return { reply: '来打个招呼。', media: { send_id: 'collected_wave', voice_id: 'voice_hello', selection: waveSelection() } };
    }
  });
  await f.due();
  assert.equal(await f.bot.tick(), true);
  assert.deepEqual(calls, [['images', 'room-a'], ['voices', 'room-a']]);
  assert.deepEqual(inputs[0].mediaCatalog.map(item => item.id), ['collected_wave', 'approved_avatar']);
  assert.doesNotMatch(JSON.stringify(inputs[0]), /secret-file|secret-token|voice-secret|foreign_image|group_openid/);
  assert.equal(typeof f.sent[0].options.isCurrent, 'function');
  const { isCurrent, ...selectedOptions } = f.sent[0].options;
  assert.deepEqual({ ...f.sent[0], options: selectedOptions }, { group: 'room-a', text: '来打个招呼。', options: { mediaId: 'collected_wave', voiceId: 'voice_hello' } });
  assert.match(Object.values(f.bot.state.groups)[0].recentSent[0].text, /小柯挥手/);
  assert.doesNotMatch(Object.values(f.bot.state.groups)[0].recentSent[0].text, /模型修改/);
  assert.equal(images[1].label, '小柯挥手');
});

test('media-only proactive replies send once without empty text records and keep unanswered protection after restart', async t => {
  const f = await fixture(t);
  await f.due();
  assert.equal(await f.bot.tick(), true);
  assert.equal(typeof f.sent[0].options.isCurrent, 'function');
  assert.deepEqual(f.sent.map(({ options: { isCurrent, ...options }, ...item }) => ({ ...item, options })), [{ group: 'room-a', text: '', options: { mediaId: 'approved_wave', voiceId: '' } }]);
  const room = Object.values(f.bot.state.groups)[0];
  assert.deepEqual(room.topics, ['[发送图片：小柯挥手]']);
  assert.equal(room.awaitingReply, true);
  f.advance(60 * MINUTE);
  await f.bot.observe(event('ordinary', '大家聊别的'), { addressed: false });
  f.advance(60 * MINUTE);
  const restored = await new ProactiveCompanion(f.config).init();
  assert.equal(await restored.tick(), false);
  assert.equal(f.sent.length, 1);
});

test('voice-only replies use actual receipts and delivered bubble contents, never the unsent draft', async t => {
  const f = await fixture(t, {
    generate: async () => ({ reply: '这句话被发送层裁掉', media: { voice_id: 'voice_hello' } }),
    send: async (group, text, options) => {
      assert.equal(options.isCurrent(), true);
      const { isCurrent, ...selectedOptions } = options;
      assert.deepEqual(selectedOptions, { mediaId: '', voiceId: 'voice_hello' });
      return { delivered_messages: [{ content: '[发送语音：实际问候录音]', messageId: 'actual-voice' }] };
    }
  });
  await f.due();
  assert.equal(await f.bot.tick(), true);
  const room = Object.values(f.bot.state.groups)[0];
  assert.deepEqual(room.topics, ['[发送语音：实际问候录音]']);
  assert.doesNotMatch(await readFile(join(f.dataDir, 'social_state.json'), 'utf8'), /被发送层裁掉/);
  await f.bot.observe(event('again'));
  f.advance(30 * MINUTE);
  f.bot.generate = async () => ({ reply: '', media: { voice_id: 'voice_hello' } });
  f.bot.send = async (_group, text) => { assert.equal(text, ''); return { sent_text: '[发送语音：另一段问好]' }; };
  assert.equal(await f.bot.tick(), true);
  assert.equal(room.recentSent.at(-1).text, '[发送语音：另一段问好]');
});

test('invented IDs, cross-kind IDs, mutated catalogs and silent decisions cannot send media', async t => {
  for (const output of [
    { reply: '', media: { send_id: 'foreign_image', voice_id: 'unknown_voice' } },
    { reply: '', media: { send_id: 'voice_hello', voice_id: 'approved_wave' } },
    { reply: '', media: { send_id: 'forged_image' } },
    { reply: '不要发', social: { action: 'silent' }, media: { send_id: 'approved_wave', selection: waveSelection() } }
  ]) {
    const f = await fixture(t, { generate: async input => { input.mediaCatalog.push({ id: 'forged_image' }); return output; } });
    await f.due();
    assert.equal(await f.bot.tick(), false);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(Object.values(f.bot.state.groups)[0].recentSent, []);
    assert.equal(Object.values(f.bot.state.groups)[0].awaitingReply, false);
  }
});

test('media errors and explicitly empty delivery receipts never create sent history or repeated retries', async t => {
  for (const send of [async () => { throw Object.assign(new Error('qq_api_error_403'), { status: 403 }); }, async () => ({ sent_text: '', delivered_messages: [] })]) {
    const f = await fixture(t, { send });
    await f.due();
    assert.equal(await f.bot.tick(), false);
    const [room] = Object.values(f.bot.state.groups);
    assert.equal(room.awaitingReply, true);
    assert.equal(room.lastSentAt, 0);
    assert.deepEqual(room.topics, []);
    assert.deepEqual(room.recentSent, []);
    f.advance(60 * MINUTE);
    assert.equal(await f.bot.tick(), false);
  }
});

test('quiet and indefinite waits suppress media opportunities; duplicate stickers are not resent after rearming', async t => {
  const f = await fixture(t);
  await f.due();
  const [{ scope }] = f.bot.snapshot();
  await f.bot.control(scope, 'quiet');
  f.advance(60 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(f.generated.length, 0);
  await f.bot.control(scope, 'wake');
  await f.bot.markObserved('room-a', { social: { wait: { mode: 'indefinite', keywords: [], speakers: [], match: 'any' } } });
  f.advance(60 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  await f.bot.observe(event('direct'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true);
  await f.bot.observe(event('response'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(f.sent.length, 1);
});

test('local snapshots are body-free copies and scoped controls persist without bypassing existing restrictions', async t => {
  const f = await fixture(t);
  await f.bot.observe(event('a', 'private-body-room-a'));
  await f.bot.observe(event('b', 'private-body-room-b', 'room-b'));
  const [a, b] = f.bot.snapshot();
  assert.match(a.scope, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(f.bot.snapshot()), /room-a|room-b|member-a|private-body|groupOpenid|roomHistory|pending_thought/);
  a.enabled = false;
  assert.equal(f.bot.snapshot()[0].enabled, true);
  assert.equal(await f.bot.control('room-a', 'disable'), false);
  assert.equal(await f.bot.control(a.scope, 'invented'), false);
  assert.equal(await f.bot.control(a.scope, 'disable'), true);
  let restored = await new ProactiveCompanion(f.config).init();
  assert.equal(restored.snapshot().find(item => item.scope === a.scope).enabled, false);
  assert.equal(restored.snapshot().find(item => item.scope === b.scope).enabled, true);
  await f.bot.control(a.scope, 'quiet');
  const quietUntil = f.bot.snapshot()[0].quietUntil;
  await f.bot.control(a.scope, 'enable');
  assert.equal(f.bot.snapshot()[0].quietUntil, quietUntil);
  assert.equal(quietUntil, f.config.now() + DAY);
  await f.bot.control(a.scope, 'wake');
  assert.equal(f.bot.snapshot()[0].quietUntil, 0);
  assert.equal(f.bot.snapshot()[0].nextAt, f.config.now() + MINUTE);
  assert.equal(await f.bot.tick(), false, 'wake schedules a later opportunity, not an immediate send');
  restored = await new ProactiveCompanion(f.config).init();
  assert.equal(restored.snapshot()[0].nextAt, f.config.now() + MINUTE);
});

test('enable preserves QQ permission blocking and unanswered state, while explicit wake allows one fresh attempt', async t => {
  let sends = 0;
  const f = await fixture(t, { send: async () => { sends++; throw new Error('qq_api_error_403'); } });
  await f.due();
  await f.bot.tick();
  const [{ scope }] = f.bot.snapshot();
  await f.bot.control(scope, 'disable');
  await f.bot.control(scope, 'enable');
  assert.equal(f.bot.snapshot()[0].blocked, true);
  assert.equal(f.bot.snapshot()[0].awaitingReply, true);
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(sends, 1);
  await f.bot.control(scope, 'wake');
  assert.equal(sends, 1);
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(sends, 2);
  assert.equal(f.bot.snapshot()[0].blocked, true);
});

test('disable or quiet during media generation immediately invalidates the pending draft', async t => {
  for (const action of ['disable', 'quiet']) {
    const entered = gate(), finish = gate();
    const f = await fixture(t, { generate: async () => { entered.resolve(); await finish.promise; return { reply: '', media: { send_id: 'approved_wave', selection: waveSelection() } }; } });
    await f.due();
    const work = f.bot.tick();
    await entered.promise;
    const [{ scope, generatingOrSending }] = f.bot.snapshot();
    assert.equal(generatingOrSending, true);
    await f.bot.control(scope, action);
    finish.resolve();
    assert.equal(await work, false);
    assert.equal(f.sent.length, 0);
    assert.equal(f.bot.snapshot()[0].generatingOrSending, false);
    assert.equal(f.bot.snapshot()[0].awaitingReply, false);
    const restored = await new ProactiveCompanion(f.config).init();
    assert.equal(await restored.tick(), false);
  }
});

test('disable during reservation persistence cancels the send and removes unanswered reservation state', async t => {
  const f = await fixture(t);
  await f.due();
  const entered = gate(), finish = gate();
  const persist = f.bot.persist.bind(f.bot);
  let paused = false;
  f.bot.persist = async () => {
    await persist();
    if (!paused && Object.values(f.bot.state.groups)[0].reservation) { paused = true; entered.resolve(); await finish.promise; }
  };
  const work = f.bot.tick();
  await entered.promise;
  await f.bot.control(f.bot.snapshot()[0].scope, 'disable');
  finish.resolve();
  assert.equal(await work, false);
  assert.equal(f.sent.length, 0);
  const room = Object.values(f.bot.state.groups)[0];
  assert.equal(room.reservation, null);
  assert.equal(room.awaitingReply, false);
  assert.equal(room.enabled, false);
});
