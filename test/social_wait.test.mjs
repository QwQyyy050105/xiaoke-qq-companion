import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { groupMemberSpeaker, normalizeWaitPlan, matchWaitPlan } from '../src/social_wait.mjs';
import { ProactiveCompanion } from '../src/proactive.mjs';

const now = Date.parse('2026-10-22T04:00:00Z');
const event = (id, content, member = 'alice', group = 'room-a') => ({ id, content, author: { member_openid: member }, group_openid: group, chat_type: 'group' });
const member = groupMemberSpeaker('room-a', 'alice');
const plan = (extra = {}) => ({ mode: 'condition', keywords: ['猫饼'], speakers: [], match: 'any', ...extra });
async function fixture(t, options = {}) {
  const root = resolve(process.cwd(), 'temp');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(join(root, 'social_wait_'));
  let clock = now;
  const sent = [], generated = [];
  const config = { dataDir, now: () => clock, random: () => 0, isAwake: () => true,
    generate: async input => { generated.push(input); return { reply: '想起一个新话题。', social: { action: 'say' } }; },
    send: async (group, text) => sent.push({ group, text }), ...options };
  const bot = await new ProactiveCompanion(config).init();
  t.after(async () => { await bot.writeQueue; assert.ok(resolve(dataDir).startsWith(root + sep)); await rm(dataDir, { recursive: true, force: true }); await assert.rejects(access(dataDir), { code: 'ENOENT' }); });
  return { bot, config, sent, generated, advance: ms => { clock += ms; } };
}

test('wait matching uses current text, short English boundaries and actual members; filters unknown speakers', () => {
  const normalized = normalizeWaitPlan(plan({ keywords: ['DS', '猫饼'], speakers: [member, 'member_ffffffffffffffff', 'real-QQ-id'] }), { allowedSpeakers: [member], now });
  assert.deepEqual(normalized.speakers, [member]);
  assert.equal(matchWaitPlan(normalized, event('quoted', '随便聊聊\n> 猫饼', 'bob')), null);
  assert.equal(matchWaitPlan(normalized, event('long-word', 'ADS', 'bob')), null);
  assert.equal(matchWaitPlan(normalized, event('english', '用 DS 吧', 'bob')).reason, 'keyword');
  assert.equal(matchWaitPlan(normalized, event('speaker', '你好')).reason, 'speaker');
  assert.equal(matchWaitPlan(normalized, event('other-room', '你好', 'alice', 'room-b')), null);
  const both = normalizeWaitPlan(plan({ speakers: [member], match: 'all' }), { allowedSpeakers: [member], now });
  assert.equal(matchWaitPlan(both, event('only-keyword', '猫饼', 'bob')), null);
  assert.equal(matchWaitPlan(both, event('both', '猫饼')).reason, 'keyword_and_speaker');
  assert.equal(normalizeWaitPlan(plan({ keywords: [], speakers: ['invented'] }), { allowedSpeakers: [member], now }), null);
});

test('keyword waits persist across restart, suppress timers and wake only once from an actual matching event', async t => {
  const f = await fixture(t);
  await f.bot.observe(event('first', '聊聊猫'));
  await f.bot.markObserved('room-a', { social: { action: 'silent', wait: plan() } });
  f.advance(24 * 60 * 60_000);
  assert.equal(await f.bot.tick(), false);
  const restored = await new ProactiveCompanion(f.config).init();
  assert.equal(restored.context('room-a').wait.mode, 'condition');
  assert.deepEqual(await restored.observe(event('other', '聊聊狗', 'bob'), { addressed: false }), { handled: false, reply: null });
  assert.equal(await restored.tick(), false);
  const matched = await restored.observe(event('match', '猫饼来了', 'bob'), { addressed: false });
  assert.deepEqual(matched.wake, { reason: 'keyword', messageId: 'match' });
  assert.equal(restored.context('room-a').wait.mode, 'timer');
  assert.equal((await restored.observe(event('match', '猫饼来了', 'bob'), { addressed: false })).wake, undefined);
  assert.equal(f.sent.length, 0, 'observe requests routing, never sends a second spontaneous reply');
});

test('indefinite lurking stays quiet through unrelated messages but direct calls and reset can always release it', async t => {
  const f = await fixture(t);
  await f.bot.observe(event('first', '你好'));
  await f.bot.markReplied('room-a', { social: { wait: plan({ mode: 'indefinite', keywords: [] }) } });
  for (let i = 0; i < 3; i++) {
    f.advance(60 * 60_000);
    await f.bot.observe(event(`ordinary-${i}`, '普通聊天', 'bob'), { addressed: false });
    assert.equal(await f.bot.tick(), false);
  }
  assert.equal(f.bot.context('room-a').nextOpportunityAt, null);
  await f.bot.observe(event('direct', '小柯，你在吗'), { addressed: true });
  assert.equal(f.bot.context('room-a').wait.mode, 'timer');
  await f.bot.markObserved('room-a', { social: { wait: plan() } });
  await f.bot.observe(event('forget', '/forget'), { addressed: true });
  assert.deepEqual(f.bot.context('room-a').knownSpeakers, []);
  assert.deepEqual(f.bot.context('room-a').wait, { mode: 'timer', keywords: [], speakers: [], match: 'any' });
});

test('a model can combine a finite timer with earlier conditions, while quiet and other rooms cannot be bypassed', async t => {
  const f = await fixture(t);
  await f.bot.observe(event('first', '你好'));
  await f.bot.markObserved('room-a', { social: { next_wake_ms: 60_000, wait: plan({ mode: 'timer' }) } });
  f.advance(60_000);
  assert.equal(await f.bot.tick(), true);
  await f.bot.observe(event('quiet', '/quiet'), { addressed: true });
  await f.bot.markObserved('room-a', { social: { wait: plan() } });
  assert.equal((await f.bot.observe(event('keyword', '猫饼', 'bob'), { addressed: false })).wake, undefined);
  assert.equal((await f.bot.observe(event('foreign', '猫饼', 'alice', 'room-b'), { addressed: false })).wake, undefined);
});
