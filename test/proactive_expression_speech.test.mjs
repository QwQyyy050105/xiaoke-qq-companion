import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ProactiveCompanion } from '../src/proactive.mjs';

const MINUTE = 60000;
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (id, content = '今天这道题终于解出来了', group = 'room-a') => ({
  id, content, group_openid: group, chat_type: 'group', author: { member_openid: 'alice' }
});
const ready = { enabled: true, ready: true, paused: false, pending: 0, lastSentAt: 0 };
const output = { reply: '', social: { action: 'say' }, speech: { text: '解出来以后，连晚风都轻快了。', mood: 'happy' },
  expression: { mood: 'happy', energy: .7, continuity: '解题后的轻快' } };

async function fixture(t, options = {}) {
  const root = resolve(process.cwd(), 'temp'); await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(join(root, 'proactive_expression_speech_'));
  let now = Date.parse('2026-10-23T12:00:00+08:00');
  const sent = [], commits = [], generated = [];
  const config = { dataDir, now: () => now, random: () => 0, isAwake: () => true,
    getSpeechStatus: () => ({ ...ready }),
    generate: async input => { generated.push(structuredClone(input)); return structuredClone(output); },
    send: async (group, text, options) => {
      sent.push({ group, text, options });
      return { sent_text: options.speech ? `[发送语音：${options.speech.text}]` : text };
    },
    setRoomExpression: async (group, expression, isCurrent) => { assert.equal(isCurrent(), true); commits.push({ group, expression }); },
    ...options
  };
  const bot = await new ProactiveCompanion(config).init();
  t.after(async () => {
    await bot.writeQueue; assert.ok(resolve(dataDir).startsWith(root + sep));
    await rm(dataDir, { recursive: true, force: true }); await assert.rejects(access(dataDir), { code: 'ENOENT' });
  });
  return { bot, config, dataDir, generated, sent, commits, advance: ms => { now += ms; },
    due: async () => { await bot.observe(event('first')); now += 30 * MINUTE; } };
}

test('dynamic proactive speech awaits a confirmed receipt before recording speech and expression', async t => {
  const entered = gate(), finish = gate(); let options;
  const f = await fixture(t, { send: async (_group, _text, selection) => {
    options = selection; entered.resolve(); await finish.promise;
    return { delivered_messages: [{ content: '[发送语音：实际送达的话]', messageId: 'voice-1' }] };
  } });
  await f.due(); const work = f.bot.tick(); await entered.promise;
  assert.deepEqual(options.speech, output.speech);
  assert.equal(f.commits.length, 0);
  assert.deepEqual(Object.values(f.bot.state.groups)[0].recentSent, []);
  finish.resolve(); assert.equal(await work, true);
  const room = Object.values(f.bot.state.groups)[0];
  assert.equal(room.recentSent[0].text, '[发送语音：实际送达的话]');
  assert.equal(room.awaitingReply, true);
  assert.deepEqual(f.commits, [{ group: 'room-a', expression: { ...output.expression, at: f.config.now() } }]);
  f.advance(60 * MINUTE); assert.equal(await f.bot.tick(), false);
});

test('paused, unavailable, busy and cooling voices use text without invoking the dynamic speech path', async t => {
  for (const status of [undefined, { ...ready, paused: true }, { ...ready, ready: false }, { ...ready, enabled: false },
    { ...ready, pending: 1 }, { ...ready, lastSentAt: Date.parse('2026-10-23T12:29:00+08:00') }]) {
    const f = await fixture(t, { getSpeechStatus: () => status }); await f.due();
    assert.equal(await f.bot.tick(), true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].text, output.speech.text);
    assert.equal(f.sent[0].options.speech, undefined);
    assert.equal(f.generated[0].speechStatus.available, false);
    assert.equal(Object.values(f.bot.state.groups)[0].recentSent[0].text, output.speech.text);
    assert.doesNotMatch(await readFile(join(f.dataDir, 'social_state.json'), 'utf8'), /发送语音/);
  }
});

test('a failed voice-status read degrades to ordinary text without blocking the proactive conversation', async t => {
  const f = await fixture(t, { getSpeechStatus: async () => { throw new Error('resource_control_unavailable'); } });
  await f.due(); assert.equal(await f.bot.tick(), true);
  assert.equal(f.sent[0].text, output.speech.text); assert.equal(f.sent[0].options.speech, undefined);
  assert.equal(f.generated[0].speechStatus.available, false); assert.equal(f.commits.length, 1);
});

test('failed or absent dynamic speech receipts never update sent state or expression and cannot auto-retry', async t => {
  for (const send of [async () => { throw new Error('voice_paused'); }, async () => undefined,
    async () => ({ sent_text: '', delivered_messages: [] })]) {
    const f = await fixture(t, { send }); await f.due();
    assert.equal(await f.bot.tick(), false);
    const room = Object.values(f.bot.state.groups)[0];
    assert.equal(room.lastSentAt, 0); assert.deepEqual(room.topics, []); assert.deepEqual(room.recentSent, []);
    assert.equal(f.commits.length, 0);
    f.advance(60 * MINUTE); assert.equal(await f.bot.tick(), false);
    const restored = await new ProactiveCompanion(f.config).init(); assert.equal(await restored.tick(), false);
  }
});

test('a pause discovered inside the send callback records only the confirmed fallback text', async t => {
  const f = await fixture(t, { send: async (_group, _text, options) => {
    assert.ok(options.speech); return { sent_text: options.speech.text, delivered_messages: [{ content: options.speech.text, messageId: 'text-1' }] };
  } });
  await f.due(); assert.equal(await f.bot.tick(), true);
  assert.equal(Object.values(f.bot.state.groups)[0].topics[0], output.speech.text);
  assert.doesNotMatch(await readFile(join(f.dataDir, 'social_state.json'), 'utf8'), /发送语音/);
  assert.equal(f.commits.length, 1);
});

test('new conversation during send prevents an older proactive expression overwriting the current one', async t => {
  const entered = gate(), finish = gate();
  const f = await fixture(t, { send: async () => { entered.resolve(); await finish.promise; return { sent_text: '刚才那句确实送达了。' }; } });
  await f.due(); const work = f.bot.tick(); await entered.promise;
  await f.bot.observe(event('newer', '换个话题吧'));
  finish.resolve(); assert.equal(await work, true);
  assert.equal(f.commits.length, 0);
  assert.equal(Object.values(f.bot.state.groups)[0].awaitingReply, false);
});

test('a newer message during preparation cancels before QQ send without setting unanswered state', async t => {
  const entered = gate(), finish = gate(); let transportCalls = 0;
  const f = await fixture(t, { send: async (_group, _text, options) => {
    assert.equal(options.isCurrent(), true); entered.resolve(); await finish.promise;
    if (!options.isCurrent()) throw new Error('proactive_stale');
    transportCalls++; return { sent_text: '这句不应该发送' };
  } });
  await f.due(); const work = f.bot.tick(); await entered.promise;
  await f.bot.observe(event('newer', '我们已经换话题了'));
  finish.resolve(); assert.equal(await work, false);
  const room = Object.values(f.bot.state.groups)[0];
  assert.equal(transportCalls, 0); assert.equal(room.awaitingReply, false);
  assert.equal(room.lastAttemptReason, null); assert.deepEqual(room.recentSent, []);
  assert.equal(f.commits.length, 0);
});

test('forget during an actual send cannot resurrect its body when a later success receipt arrives', async t => {
  const entered = gate(), finish = gate();
  const f = await fixture(t, { send: async () => {
    entered.resolve(); await finish.promise; return { sent_text: '清空前已经开始发送的旧话题' };
  } });
  await f.due(); const work = f.bot.tick(); await entered.promise;
  await f.bot.observe(event('forget', '/forget'));
  finish.resolve(); assert.equal(await work, true);
  const room = Object.values(f.bot.state.groups)[0];
  assert.equal(room.contextEpoch, 1); assert.deepEqual(room.topics, []); assert.deepEqual(room.recentSent, []);
  assert.equal(f.commits.length, 0); assert.ok(room.lastSentAt > 0);
  const restored = await new ProactiveCompanion(f.config).init();
  assert.deepEqual(Object.values(restored.state.groups)[0].recentSent, []);
  assert.doesNotMatch(await readFile(join(f.dataDir, 'social_state.json'), 'utf8'), /清空前已经开始发送的旧话题/);
});

test('a new message during guarded expression persistence invalidates the old state update', async t => {
  const entered = gate(), finish = gate(); let changed = false;
  const f = await fixture(t, { setRoomExpression: async (_group, _expression, isCurrent) => {
    entered.resolve(); await finish.promise; if (isCurrent()) changed = true;
  } });
  await f.due(); const work = f.bot.tick(); await entered.promise;
  await f.bot.observe(event('newer', '/forget'));
  finish.resolve(); assert.equal(await work, true);
  assert.equal(changed, false);
  assert.equal(Object.values(f.bot.state.groups)[0].recentSent.length, 0);
});

test('speech respects silence, media priority and recent duplicate suppression', async t => {
  const silent = await fixture(t, { generate: async () => ({ ...output, social: { action: 'silent' } }) });
  await silent.due(); assert.equal(await silent.bot.tick(), false);
  assert.equal(silent.sent.length, 0); assert.equal(silent.commits.length, 0);
  const picture = await fixture(t, { getMediaCatalog: () => [{ id: 'approved_wave', type: 'sticker', title: '挥手' }],
    generate: async () => ({ ...output, media: { send_id: 'approved_wave', selection: {
      fit:'contextual',message_id:'',catalog_evidence:'挥手',intent:'自然打招呼，发一张挥手表情'
    } } }),
    send: async (_group, _text, options) => {
      assert.equal(options.mediaId, 'approved_wave'); assert.equal(options.speech, undefined);
      return { sent_text: '[发送图片：挥手]' };
    } });
  await picture.due(); assert.equal(await picture.bot.tick(), true);
  const repeated = await fixture(t); await repeated.due(); assert.equal(await repeated.bot.tick(), true);
  await repeated.bot.observe(event('response')); repeated.advance(30 * MINUTE);
  assert.equal(await repeated.bot.tick(), false); assert.equal(repeated.sent.length, 1);
});

test('invalid or overlong speech cannot trigger synthesis and expression write failure cannot replay a delivered message', async t => {
  const invalid = await fixture(t, { generate: async () => ({ reply: '保留这一句文字。', speech: { text: '字'.repeat(121) }, expression: { mood: 'forged' } }) });
  await invalid.due(); assert.equal(await invalid.bot.tick(), true);
  assert.equal(invalid.sent[0].options.speech, undefined); assert.equal(invalid.sent[0].text, '保留这一句文字。');
  assert.equal(invalid.commits.length, 0);
  const failed = await fixture(t, { setRoomExpression: async () => { throw new Error('disk_failure'); } });
  await failed.due(); assert.equal(await failed.bot.tick(), true);
  failed.advance(60 * MINUTE); assert.equal(await failed.bot.tick(), false); assert.equal(failed.sent.length, 1);
});
