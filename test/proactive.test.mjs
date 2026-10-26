import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ProactiveCompanion } from '../src/proactive.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const mention = (id, content = '最近想找个好玩的游戏', groupId = 'actual-group', member = 'member-a') => ({
  chat_type: 'group', group_openid: groupId, id, content, author: { member_openid: member }
});
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const root = resolve(process.cwd(), 'temp');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'proactive_test_'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(root + sep));
    await rm(dir, { recursive: true, force: true });
  });
  let time = Date.parse('2026-10-22T10:00:00+08:00');
  let busy = false;
  const sent = [], generated = [];
  const config = {
    dataDir: dir, now: () => time, random: () => 0, isBusy: () => busy,
    generate: async input => {
      generated.push(input);
      return ['好无聊，要不要聊聊最近玩到的游戏？', '突然想起你们之前聊过联机，最近有试到有趣的吗？', '我在想，一款游戏最先吸引你的是画风还是故事？'][((generated.length - 1) % 3)];
    },
    send: async (group, text) => { sent.push({ group, text }); }, ...options
  };
  const bot = await new ProactiveCompanion(config).init();
  return { bot, dir, sent, generated, config, advance: ms => { time += ms; }, setTime: value => { time = Date.parse(value); }, setBusy: value => { busy = value; } };
}

test('only valid group @ events register rooms, with hashed keys and bounded real context', async t => {
  const f = await fixture(t);
  for (const invalid of [undefined, { ...mention('x'), chat_type: 'private' }, { ...mention('x'), group_openid: '' }, { ...mention('x'), id: null }, { ...mention('x'), author: {} }]) {
    assert.deepEqual(await f.bot.observe(invalid), { handled: false, reply: null });
  }
  assert.deepEqual(Object.values(f.bot.state.groups), []);
  for (let i = 0; i < 20; i++) await f.bot.observe(mention(String(i), `${i}:` + '话'.repeat(400), '__proto__'));
  const [key] = Object.keys(f.bot.state.groups), [room] = Object.values(f.bot.state.groups);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(room.groupOpenid, '__proto__');
  assert.equal(room.roomHistory.length, 12);
  assert.equal(Array.from(room.roomHistory[0].content).length, 300);
  assert.match(room.roomHistory[0].content, /^8:/);
  assert.equal(room.enabled, true);
});

test('due messages send once, wait for a real response, and have no daily two-message cap', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await f.bot.observe(mention(`message-${i}`)), { handled: false, reply: null });
    assert.equal(await f.bot.tick(), false);
    f.advance(30 * MINUTE);
    assert.equal(await f.bot.tick(), true);
    f.advance(30 * MINUTE);
    assert.equal(await f.bot.tick(), false);
  }
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[0].group, 'actual-group');
  assert.deepEqual(f.generated[0].history, []);
  assert.deepEqual(f.generated[0].memory, []);
  assert.equal(f.generated[0].mode, 'proactive');
  assert.equal(f.generated[2].topics.length, 2);
  await f.bot.observe(mention('message-2'));
  assert.equal(await f.bot.tick(), false, 'replayed incoming events do not reset awaitingReply');
});

test('pending personal forget blocks only its room before reading growth or generating', async t => {
  const blocked = new Set(['group-a']), snapshots = [];
  const f = await fixture(t, {
    isContextBlocked: group => blocked.has(group),
    characterGrowth: { snapshot: event => { snapshots.push(event.group_openid); return { revision: 1 }; } }
  });
  await f.bot.observe(mention('a', '群A话题', 'group-a'));
  await f.bot.observe(mention('b', '群B话题', 'group-b'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true);
  assert.deepEqual(snapshots, ['group-b']);
  assert.equal(f.sent[0].group, 'group-b');
  assert.equal(await f.bot.tick(), false);
  assert.equal(f.generated.length, 1);
  blocked.clear();
  assert.equal(await f.bot.tick(), true);
  assert.deepEqual(snapshots, ['group-b', 'group-a']);
});

test('forget becoming pending during generation discards the reply and growth update', async t => {
  let blocked = false, applied = 0;
  const entered = gate(), finish = gate();
  const f = await fixture(t, {
    isContextBlocked: () => blocked,
    characterGrowth: { snapshot: () => ({ revision: 1 }), apply: async () => { applied++; } },
    generate: async () => { entered.resolve(); await finish.promise;
      return { reply: '旧话题', character_updates: [{ kind: 'preference', text: '旧偏好' }] }; }
  });
  await f.bot.observe(mention('a'));
  f.advance(30 * MINUTE);
  const work = f.bot.tick();
  await entered.promise;
  blocked = true;
  finish.resolve();
  assert.equal(await work, false);
  assert.equal(f.sent.length, 0);
  assert.equal(applied, 0);
});

test('accepted delivery during a pending forget does not repersist old social or growth context', async t => {
  let blocked = false, applied = 0, expressionWrites = 0;
  const f = await fixture(t, {
    isContextBlocked: () => blocked,
    characterGrowth: { snapshot: () => ({ revision: 1 }), apply: async () => { applied++; } },
    setRoomExpression: async () => { expressionWrites++; },
    generate: async () => ({ reply: '旧话题', expression: { mood: 'calm' },
      character_updates: [{ kind: 'preference', text: '旧偏好' }] }),
    send: async () => { blocked = true; return { id: 'accepted-before-forget', sent_text: '旧话题' }; }
  });
  await f.bot.observe(mention('a'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true, 'a delivery already accepted remains a true delivery');
  const [room] = Object.values(f.bot.state.groups);
  assert.deepEqual(room.topics, []);
  assert.deepEqual(room.recentSent, []);
  assert.equal(applied, 0);
  assert.equal(expressionWrites, 0);
});

test('ambient activity preserves unanswered state without executing unaddressed controls', async t => {
  const f = await fixture(t);
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true);
  const [room] = Object.values(f.bot.state.groups);
  const topics = structuredClone(room.topics);
  for (const [index, content] of ['/quiet', '/wake', '/forget', '/reset', '安静一会儿', '出来聊聊', '我们在聊别的事情'].entries()) {
    f.advance(5 * MINUTE);
    assert.deepEqual(await f.bot.observe(mention(`ordinary-${index}`, content), { addressed: false }), { handled: false, reply: null });
    assert.equal(room.awaitingReply, true);
    assert.equal(room.quietUntil, 0);
    assert.deepEqual(room.topics, topics);
  }
  f.advance(HOUR);
  assert.equal(await f.bot.tick(), false);
  assert.equal(f.sent.length, 1);
  assert.ok(room.roomHistory.some(item => item.content === '我们在聊别的事情'));
  await f.bot.observe(mention('direct-response', '小柯，我们聊聊游戏吧'), { addressed: true });
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true);
});

test('ordinary messages postpone idle time and cancel a generated topic while a group is talking', async t => {
  const started = gate(), finish = gate();
  const f = await fixture(t, { generate: async () => { started.resolve(); await finish.promise; return '这个话题已经过时'; } });
  const first = mention('first', '普通群消息');
  delete first.chat_type;
  first.t = 'GROUP_MESSAGE_CREATE';
  await f.bot.observe(first, { addressed: false });
  f.advance(29 * MINUTE);
  await f.bot.observe(mention('second', '大家还在聊天'), { addressed: false });
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), false);
  f.advance(29 * MINUTE);
  const work = f.bot.tick();
  await started.promise;
  await f.bot.observe(mention('third', '继续刚才的话题'), { addressed: false });
  finish.resolve();
  assert.equal(await work, false);
  assert.equal(f.sent.length, 0);
  assert.equal(Object.values(f.bot.state.groups)[0].awaitingReply, false);
});

test('an ordinary event can later be recognized as the same addressed event exactly once', async t => {
  const f = await fixture(t);
  const message = mention('same-id', '/quiet');
  assert.deepEqual(await f.bot.observe(message, { addressed: false }), { handled: false, reply: null });
  assert.match((await f.bot.observe(message, { addressed: true })).reply, /安静/);
  const [room] = Object.values(f.bot.state.groups);
  assert.equal(room.version, 2);
  assert.deepEqual(await f.bot.observe(message, { addressed: true }), { handled: true, reply: null });
  assert.equal(room.version, 2);
});

test('proactive generation uses a cloned public room snapshot including bot replies and speaker identity', async t => {
  const snapshot = [
    { role: 'user', speaker: 'member_group_hash', content: '我们昨天在聊什么游戏？', messageId: 'seen-user', at: 123 },
    { role: 'assistant', speaker: 'xiao_ke', content: '刚才聊的是双人成行。', reply_to: 'member_group_hash', at: 124 }
  ];
  const requested = [];
  const f = await fixture(t, { getRoomHistory: async id => { requested.push(id); return snapshot; } });
  await f.bot.observe(mention('fallback', '这个旧摘要不应覆盖新公开上下文'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true);
  assert.deepEqual(requested, ['actual-group']);
  assert.deepEqual(f.generated[0].roomHistory, snapshot);
  assert.notEqual(f.generated[0].roomHistory, snapshot);
  assert.notEqual(f.generated[0].roomHistory[0], snapshot[0]);
  assert.doesNotMatch(JSON.stringify(f.generated[0].roomHistory), /旧摘要/);
  snapshot[0].content = '后续修改';
  assert.match(f.generated[0].roomHistory[0].content, /昨天/);
});

test('successful normal replies reset only their own room idle timer without clearing unanswered state', async t => {
  const f = await fixture(t);
  await f.bot.observe(mention('a', '群A话题', 'group-a'));
  await f.bot.observe(mention('b', '群B话题', 'group-b'));
  assert.equal(await f.bot.markReplied('unregistered-group'), false);
  f.advance(29 * MINUTE);
  assert.equal(await f.bot.markReplied('group-a'), true);
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), true);
  assert.equal(f.sent[0].group, 'group-b');
  assert.equal(await f.bot.tick(), false);
  f.advance(29 * MINUTE);
  assert.equal(await f.bot.tick(), true);
  assert.equal(f.sent[1].group, 'group-a');
  await f.bot.markReplied('group-a');
  f.advance(HOUR);
  assert.equal(await f.bot.tick(), false);
  assert.equal(f.sent.length, 2);
});

test('ordinary group activity during an actual send does not pretend someone answered the bot', async t => {
  const entered = gate(), finish = gate();
  const f = await fixture(t, { send: async () => { entered.resolve(); await finish.promise; } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  const work = f.bot.tick();
  await entered.promise;
  await f.bot.observe(mention('other-chat', '我们去吃饭'), { addressed: false });
  finish.resolve();
  assert.equal(await work, true);
  assert.equal(Object.values(f.bot.state.groups)[0].awaitingReply, true);
  f.advance(HOUR);
  assert.equal(await f.bot.tick(), false);
});

test('forget and reset erase shared proactive context and need a new real message to rearm', async t => {
  for (const command of ['/forget', '/reset']) {
    const f = await fixture(t);
    await f.bot.observe(mention('old', '这段内容要被清除'));
    f.advance(30 * MINUTE);
    assert.equal(await f.bot.tick(), true);
    assert.equal(Object.values(f.bot.state.groups)[0].topics.length, 1);
    assert.deepEqual(await f.bot.observe(mention('erase', command)), { handled: false, reply: null });
    f.advance(HOUR);
    assert.equal(await f.bot.tick(), false);
    const restored = await new ProactiveCompanion(f.config).init();
    const [room] = Object.values(restored.state.groups);
    assert.deepEqual(room.roomHistory, []);
    assert.deepEqual(room.topics, []);
    assert.equal(room.awaitingReply, true);
    assert.equal(await restored.tick(), false);
    await restored.observe(mention('fresh', '我们换个新话题'));
    f.advance(30 * MINUTE);
    assert.equal(await restored.tick(), true);
    assert.deepEqual(f.generated.at(-1).roomHistory, [{ role: 'user', content: '我们换个新话题' }]);
    assert.deepEqual(f.generated.at(-1).topics, []);
    assert.doesNotMatch(JSON.stringify(f.generated.at(-1)), /这段内容要被清除/);
  }
});

test('quiet works for any member for 24h; ordinary @ remains quiet; wake restores after one minute', async t => {
  const f = await fixture(t);
  const quiet = mention('quiet', '<@12345> 安静一会儿', 'actual-group', 'other-member');
  assert.match((await f.bot.observe(quiet)).reply, /一天/);
  assert.deepEqual(await f.bot.observe(quiet), { handled: true, reply: null });
  f.advance(HOUR);
  await f.bot.observe(mention('still-chatting'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal((await f.bot.observe(mention('wake', '出来聊聊'))).handled, true);
  assert.equal(await f.bot.tick(), false);
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), true);
  assert.equal((await f.bot.observe(mention('quiet-again', '/quiet'))).handled, true);
  f.advance(DAY);
  assert.equal(await f.bot.tick(), true, '24-hour quiet period expires');
});

test('Beijing quiet hours follow recent late-night activity; stale rooms never initiate', async t => {
  const f = await fixture(t);
  f.setTime('2026-10-22T23:00:00+08:00');
  await f.bot.observe(mention('evening'));
  f.setTime('2026-10-23T03:00:00+08:00');
  assert.equal(await f.bot.tick(), false);
  await f.bot.observe(mention('night-owl'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true, 'recent explicit activity allows the real late-night schedule');
  await f.bot.observe(mention('another-night-message'));
  f.advance(3 * HOUR);
  assert.equal(await f.bot.tick(), false);
  f.setTime('2026-10-23T09:00:00+08:00');
  assert.equal(await f.bot.tick(), true);
  await f.bot.observe(mention('last-message'));
  f.advance(7 * DAY);
  assert.equal(await f.bot.tick(), false);
});

test('generation in flight is cancelled by a fresh message or quiet command', async t => {
  for (const content of ['有个新问题', '/quiet']) {
    const started = gate(), finish = gate();
    const f = await fixture(t, { generate: async () => { started.resolve(); await finish.promise; return '过时的主动消息'; } });
    await f.bot.observe(mention('initial'));
    f.advance(30 * MINUTE);
    const work = f.bot.tick();
    await started.promise;
    await f.bot.observe(mention('interrupt', content));
    finish.resolve();
    assert.equal(await work, false);
    assert.equal(f.sent.length, 0);
    assert.equal(Object.values(f.bot.state.groups)[0].awaitingReply, false);
  }
});

test('busy and concurrent ticks cannot send duplicate or interrupt a normal reply', async t => {
  const started = gate(), finish = gate();
  const f = await fixture(t, { generate: async () => { started.resolve(); await finish.promise; return '一句话'; } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  f.setBusy(true);
  assert.equal(await f.bot.tick(), false);
  f.setBusy(false);
  const work = f.bot.tick();
  await started.promise;
  assert.equal(await f.bot.tick(), false);
  f.setBusy(true);
  finish.resolve();
  assert.equal(await work, false);
  assert.equal(f.sent.length, 0);
});

test('reservation is persisted before send and restart never repeats an uncertain attempt', async t => {
  const f = await fixture(t);
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  f.bot.send = async () => {
    const disk = JSON.parse(await readFile(join(f.dir, 'social_state.json'), 'utf8'));
    const room = Object.values(disk.groups)[0];
    assert.equal(room.awaitingReply, true);
    assert.ok(room.reservation);
    const restored = await new ProactiveCompanion({ ...f.config, send: async () => assert.fail('reservation cannot replay') }).init();
    assert.equal(await restored.tick(), false);
  };
  assert.equal(await f.bot.tick(), true);
  const restored = await new ProactiveCompanion(f.config).init();
  assert.equal(await restored.tick(), false);
  const [room] = Object.values(restored.state.groups);
  assert.equal(room.topics.length, 1);
  assert.equal(room.reservation, null);
  assert.equal(room.roomHistory.length, 1);
});

test('send uncertainty saves no sent history, does not retry, and stores no raw error secrets', async t => {
  const f = await fixture(t, { send: async () => { throw new Error('network issue with sensitive raw response'); } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  f.advance(HOUR);
  assert.equal(await f.bot.tick(), false);
  const [room] = Object.values(f.bot.state.groups);
  assert.equal(room.lastAttemptReason, 'qq_send_uncertain');
  assert.equal(room.lastSentAt, 0);
  assert.deepEqual(room.topics, []);
  assert.equal(room.awaitingReply, true);
  assert.doesNotMatch(await readFile(join(f.dir, 'social_state.json'), 'utf8'), /sensitive/);
});

test('403 permission block survives new mentions and restart, and only wake clears it', async t => {
  let calls = 0;
  const f = await fixture(t, { send: async () => { calls++; throw new Error('qq_api_error_403'); } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  await f.bot.observe(mention('reply'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  const restored = await new ProactiveCompanion(f.config).init();
  assert.equal(await restored.tick(), false);
  assert.equal(calls, 1);
  assert.equal((await restored.observe(mention('wake', '/wake'))).handled, true);
  f.advance(MINUTE);
  assert.equal(await restored.tick(), false);
  assert.equal(calls, 2);
  assert.equal(Object.values(restored.state.groups)[0].lastAttemptReason, 'qq_api_error_403');
});

test('HTTP 403 blocks even when QQ supplies a different business error code', async t => {
  const f = await fixture(t, { send: async () => {
    const error = new Error('qq_api_error_123456');
    error.status = 403;
    throw error;
  } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  const [room] = Object.values(f.bot.state.groups);
  assert.equal(room.blocked, true);
  assert.equal(room.lastAttemptReason, 'qq_api_error_123456');
});

test('QQ 40034105 permission block persists and ordinary messages cannot clear it with wake-like text', async t => {
  let attempts = 0;
  const f = await fixture(t, { send: async () => { attempts++; throw new Error('qq_api_error_40034105'); } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  const restored = await new ProactiveCompanion(f.config).init();
  await restored.observe(mention('ordinary-wake', '/wake'), { addressed: false });
  await restored.observe(mention('direct-reply', '你好'), { addressed: true });
  f.advance(HOUR);
  assert.equal(await restored.tick(), false);
  assert.equal(Object.values(restored.state.groups)[0].blocked, true);
  assert.equal(Object.values(restored.state.groups)[0].lastAttemptReason, 'qq_api_error_40034105');
  assert.equal(attempts, 1);
  await restored.observe(mention('direct-wake', '/wake'), { addressed: true });
  f.advance(MINUTE);
  assert.equal(await restored.tick(), false);
  assert.equal(attempts, 2);
});

test('a quiet command arriving during reservation persistence cancels the actual send', async t => {
  const entered = gate(), finish = gate();
  const f = await fixture(t);
  await f.bot.observe(mention('first'));
  const persist = f.bot.persist.bind(f.bot);
  let paused = false;
  f.bot.persist = async () => {
    await persist();
    if (!paused && Object.values(f.bot.state.groups)[0].reservation) {
      paused = true;
      entered.resolve();
      await finish.promise;
    }
  };
  f.advance(30 * MINUTE);
  const work = f.bot.tick();
  await entered.promise;
  await f.bot.observe(mention('quiet-while-saving', '/quiet'));
  finish.resolve();
  assert.equal(await work, false);
  assert.equal(f.sent.length, 0);
  const room = Object.values(JSON.parse(await readFile(join(f.dir, 'social_state.json'), 'utf8')).groups)[0];
  assert.equal(room.awaitingReply, false);
  assert.equal(room.reservation, null);
  assert.ok(room.quietUntil > room.lastInteractionAt);
});

test('generation failure backs off without treating the unsent message as awaiting a reply', async t => {
  let attempts = 0;
  const f = await fixture(t, { generate: async () => { attempts++; throw new Error('model failure'); } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(await f.bot.tick(), false);
  assert.equal(attempts, 1);
  assert.equal(Object.values(f.bot.state.groups)[0].awaitingReply, false);
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(attempts, 2);
  assert.equal(f.sent.length, 0);
});

test('concurrent observations persist latest rooms, and a response during send stays scheduled', async t => {
  const entered = gate(), finish = gate();
  const f = await fixture(t, { send: async () => { entered.resolve(); await finish.promise; } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.bot.observe(mention(`m${i}`, '真实群消息', `g${i % 2}`))));
  f.advance(30 * MINUTE);
  const work = f.bot.tick();
  await entered.promise;
  await f.bot.observe(mention('new-during-send', '我在', 'g0'));
  finish.resolve();
  assert.equal(await work, true);
  const restored = await new ProactiveCompanion(f.config).init();
  const room = Object.values(restored.state.groups).find(item => item.groupOpenid === 'g0');
  assert.equal(room.version, 11);
  assert.equal(room.awaitingReply, false);
  assert.equal(room.topics.length, 1);
  assert.equal(room.roomHistory.at(-1).content, '我在');
  assert.equal(Object.keys(restored.state.groups).length, 2);
});

test('one short message supports object replies and truncates by characters', async t => {
  const f = await fixture(t, { generate: async () => ({ reply: '🐉'.repeat(400) }) });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true);
  assert.equal(f.sent.length, 1);
  assert.equal(Array.from(f.sent[0].text).length, 300);
  f.bot.start();
  assert.equal(f.bot.timer.hasRef(), false);
  f.bot.stop();
  assert.equal(f.bot.timer, null);
});

test('a silent model decision persists a short wake and unfinished intention without sending', async t => {
  const calls = [];
  const f = await fixture(t, { generate: async input => {
    calls.push(structuredClone(input));
    return calls.length === 1
      ? { reply: '这段不应该发送', social: { action: 'silent', next_wake_ms: MINUTE, active_topic: '刚才的联机游戏', pending_thought: '等安静后问问是否更喜欢合作' } }
      : { reply: '你们联机时更爱合作，还是互相捣乱？', social: { action: 'say', next_wake_ms: MINUTE } };
  } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(f.sent.length, 0);
  const restored = await new ProactiveCompanion(f.config).init();
  assert.equal(Object.values(restored.state.groups)[0].awaitingReply, false);
  f.advance(MINUTE);
  assert.equal(await restored.tick(), true);
  assert.equal(calls[1].socialState.wakeReason, 'model_timer');
  assert.equal(calls[1].socialState.active_topic, '刚才的联机游戏');
  assert.equal(calls[1].socialState.pending_thought, '等安静后问问是否更喜欢合作');
  assert.equal(Object.values(restored.state.groups)[0].pendingThought, null, 'spoken intentions are consumed');
  f.advance(MINUTE);
  assert.equal(await restored.tick(), false, 'a model timer cannot bypass awaiting a real response');
  assert.equal(f.sent.length, 1);
});

test('normal replies can plan a short continuation using only the provided public room memory', async t => {
  const f = await fixture(t, { getRoomMemory: group => {
    assert.equal(group, 'actual-group');
    return [{ kind: 'convention', text: '本群将联机叫作开黑', source: '我们说开黑就是联机', speaker: 'member_group_hash', messageId: 'known-public-message', credentials: 'never-include' }];
  } });
  await f.bot.observe(mention('first'));
  await f.bot.markReplied('actual-group', { social: { action: 'say', next_wake_ms: 90_000, active_topic: '合作游戏' } });
  f.advance(89_000);
  assert.equal(await f.bot.tick(), false);
  f.advance(1000);
  assert.equal(await f.bot.tick(), true);
  assert.deepEqual(f.generated[0].memory, []);
  assert.deepEqual(f.generated[0].history, []);
  assert.equal(f.generated[0].roomMemory[0].text, '本群将联机叫作开黑');
  assert.equal(f.generated[0].socialState.active_topic, '合作游戏');
  assert.doesNotMatch(JSON.stringify(f.generated[0]), /never-include|credentials/);
});

test('a proactive opportunity carries only its own room expression continuity into the combined prompt',async t=>{
  const f=await fixture(t,{getRoomExpression:group=>{
    assert.equal(group,'actual-group');return {mood:'playful',energy:.7,continuity:'刚才把锅藏起来的梗'};
  }});
  await f.bot.observe(mention('first'));f.advance(30*MINUTE);assert.equal(await f.bot.tick(),true);
  assert.deepEqual(f.generated[0].expressionState,{mood:'playful',energy:.7,continuity:'刚才把锅藏起来的梗'});
  const {conversationPrompt}=await import('../src/model_client.mjs');
  const prompt=conversationPrompt('小柯',f.generated[0]);
  const data=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
  assert.deepEqual(data.expression_state,f.generated[0].expressionState);
  assert.equal(data.saved_memory,undefined);
});

test('observed silent outcomes persist plans without inventing sends or lifting protection', async t => {
  const f = await fixture(t);
  const plan = { social: { action: 'silent', next_wake_ms: MINUTE, pending_thought: '稍后续接合作游戏' } };
  assert.equal(await f.bot.markObserved('unknown-group', plan), false);
  await f.bot.observe(mention('first'));
  assert.equal(await f.bot.markObserved('actual-group', plan), true);
  let room = Object.values(f.bot.state.groups)[0];
  assert.equal(room.lastSentAt, 0);
  assert.equal(room.awaitingReply, false);
  assert.deepEqual(room.topics, []);
  assert.deepEqual(room.recentSent, []);
  const restored = await new ProactiveCompanion(f.config).init();
  assert.equal(Object.values(restored.state.groups)[0].pendingThought.text, '稍后续接合作游戏');
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), true);
  const lastSentAt = room.lastSentAt, topics = structuredClone(room.topics), recentSent = structuredClone(room.recentSent);
  await f.bot.markObserved('actual-group', plan);
  assert.equal(room.awaitingReply, true);
  assert.equal(room.lastSentAt, lastSentAt);
  assert.deepEqual(room.topics, topics);
  assert.deepEqual(room.recentSent, recentSent);
  await f.bot.observe(mention('mute', '/quiet'));
  const quietUntil = room.quietUntil;
  await f.bot.markObserved('actual-group', plan);
  assert.equal(room.quietUntil, quietUntil);
  f.advance(2 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  await f.bot.observe(mention('wake', '/wake'));
  f.bot.send = async () => { throw Object.assign(new Error('qq_api_error_403'), { status: 403 }); };
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), false);
  await f.bot.markObserved('actual-group', plan);
  assert.equal(room.blocked, true);
  assert.equal(room.awaitingReply, true);
  assert.equal(room.lastSentAt, lastSentAt);
  assert.deepEqual(room.recentSent, recentSent);
  assert.equal(f.sent.length, 1);
});

test('new ambient activity stays unanswered until a real engaged reply',async t=>{
  const f=await fixture(t);await f.bot.observe(mention('start'));f.advance(30*MINUTE);
  assert.equal(await f.bot.tick(),true);
  let room=Object.values(f.bot.state.groups)[0];assert.equal(room.awaitingReply,true);
  await f.bot.observe(mention('ambient','我先去拿快递'),{addressed:false});
  await f.bot.markObserved('actual-group',{social:{action:'silent'}});
  assert.equal(room.awaitingReply,true);
  await f.bot.markReplied('actual-group',{social:{action:'say'},engaged:true});
  assert.equal(room.awaitingReply,false);
});

test('a newly arrived group message cancels both a stale generated reply and its social plan', async t => {
  const started = gate(), finish = gate();
  const f = await fixture(t, { generate: async () => {
    started.resolve(); await finish.promise;
    return { reply: '', social: { action: 'silent', next_wake_ms: MINUTE, active_topic: '过时的话题', pending_thought: '过时的追问' } };
  } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  const work = f.bot.tick();
  await started.promise;
  await f.bot.observe(mention('new-topic', '换个话题聊美食'), { addressed: false });
  finish.resolve();
  assert.equal(await work, false);
  const [room] = Object.values(f.bot.state.groups);
  assert.equal(room.activeTopic, null);
  assert.equal(room.pendingThought, null);
  assert.equal(room.wakeReason, 'idle_opportunity');
});

test('repeated proactive wording is suppressed without fabricating another sent topic', async t => {
  let count = 0;
  const f = await fixture(t, { generate: async () => ++count === 1 ? '我们来聊一款最近很喜欢的游戏吧！' : '我们来聊一款最近很喜欢的游戏吧。' });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), true);
  await f.bot.observe(mention('reply', '你好'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  const [room] = Object.values(f.bot.state.groups);
  assert.equal(f.sent.length, 1);
  assert.equal(room.topics.length, 1);
  assert.equal(room.recentSent.length, 1);
  assert.equal(room.awaitingReply, false);
  assert.equal(room.quietDecisions, 1);
});

test('repeated silent decisions back off while fresh conversation restores a normal opportunity', async t => {
  let calls = 0;
  const f = await fixture(t, { generate: async () => { calls++; return { reply: '', social: { action: 'silent', next_wake_ms: 1 } }; } });
  await f.bot.observe(mention('first'));
  f.advance(30 * MINUTE);
  assert.equal(await f.bot.tick(), false);
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), false);
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(calls, 2);
  f.advance(MINUTE);
  assert.equal(await f.bot.tick(), false);
  assert.equal(calls, 3);
  assert.equal(Object.values(f.bot.state.groups)[0].quietDecisions, 3);
  await f.bot.observe(mention('fresh', '我们刚玩了一局'), { addressed: false });
  assert.equal(Object.values(f.bot.state.groups)[0].quietDecisions, 0);
});

test('model plans never lift a human quiet period or QQ permission block', async t => {
  const quiet = await fixture(t);
  await quiet.bot.observe(mention('quiet', '/quiet'));
  await quiet.bot.markReplied('actual-group', { social: { action: 'say', next_wake_ms: 0, active_topic: '想冒泡', quietUntil: 0, blocked: false } });
  quiet.advance(MINUTE);
  assert.equal(await quiet.bot.tick(), false);
  assert.equal(quiet.generated.length, 0);
  const denied = await fixture(t, { send: async () => { throw new Error('qq_api_error_40034105'); } });
  await denied.bot.observe(mention('first'));
  denied.advance(30 * MINUTE);
  await denied.bot.tick();
  await denied.bot.observe(mention('again'));
  await denied.bot.markReplied('actual-group', { social: { action: 'say', next_wake_ms: MINUTE, blocked: false } });
  denied.advance(MINUTE);
  assert.equal(await denied.bot.tick(), false);
  assert.equal(denied.generated.length, 1);
});

test('forget clears temporary model intentions, and expiry does not resurrect them on restart', async t => {
  const f = await fixture(t);
  await f.bot.observe(mention('first'));
  await f.bot.markReplied('actual-group', { social: { active_topic: '旧计划', pending_thought: '想接着问的事情', next_wake_ms: HOUR } });
  await f.bot.observe(mention('forget', '/forget'));
  let restored = await new ProactiveCompanion(f.config).init();
  assert.equal(Object.values(restored.state.groups)[0].activeTopic, null);
  assert.equal(Object.values(restored.state.groups)[0].pendingThought, null);
  await restored.observe(mention('new'));
  await restored.markReplied('actual-group', { social: { active_topic: '新计划', pending_thought: '短期想法' } });
  f.advance(2 * HOUR + 1);
  restored = await new ProactiveCompanion(f.config).init();
  assert.equal(Object.values(restored.state.groups)[0].activeTopic, null);
  assert.equal(Object.values(restored.state.groups)[0].pendingThought, null);
});

test('activity hours may be configured while permission and response checks remain effective', async t => {
  const f = await fixture(t, { isAwake: () => true });
  f.setTime('2026-10-22T23:00:00+08:00');
  await f.bot.observe(mention('first'));
  f.setTime('2026-10-23T03:00:00+08:00');
  assert.equal(await f.bot.tick(), true);
  f.advance(HOUR);
  assert.equal(await f.bot.tick(), false);
  const sleeping = await fixture(t, { isAwake: () => false });
  await sleeping.bot.observe(mention('first'));
  sleeping.advance(30 * MINUTE);
  assert.equal(await sleeping.bot.tick(), false);
});
