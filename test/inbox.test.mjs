import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupInbox, OrderedGroupDispatch } from '../src/inbox.mjs';

const event = (id, content, member = 'alice', group = 'group-a') => ({
  id, content, group_openid: group, author: { member_openid: member }, chat_type: 'group'
});

function fixture(handle, options = {}) {
  let now = 1000;
  return new GroupInbox({ handle, delayMs: 10, gapMs: 20, now: () => now, sleep: async ms => {
    await new Promise(resolve => setImmediate(resolve));
    now += ms;
  }, ...options });
}

test('consecutive bubbles by the same group member coalesce with every source ID and share one result', async () => {
  const received = [];
  const inbox = fixture(async item => { received.push(structuredClone(item)); return { status: 'replied' }; });
  const jobs = [inbox.enqueue(event('one', '小柯，先说一半')), inbox.enqueue(event('two', '再补上一半')),
    inbox.enqueue(event('three', '最后一句'))];
  assert.equal(inbox.pending, 1);
  assert.equal(inbox.hasPendingFor(event('next', '还在说')), true);
  assert.deepEqual(await Promise.all(jobs), Array(3).fill({ status: 'replied' }));
  assert.equal(received.length, 1);
  assert.equal(received[0].content, '小柯，先说一半\n再补上一半\n最后一句');
  assert.deepEqual(received[0].source_ids, ['one', 'two', 'three']);
  assert.equal(received[0].id, 'three');
  assert.equal(inbox.pending, 0);
});

test('different members and different groups never have their text merged', async () => {
  const received = [];
  const inbox = fixture(async item => { received.push(item); });
  await Promise.all([
    inbox.enqueue(event('alice-1', 'Alice 的第一句')),
    inbox.enqueue(event('bob', 'Bob 的一句', 'bob')),
    inbox.enqueue(event('alice-2', 'Alice 的第二句')),
    inbox.enqueue(event('other-room', 'Alice 在另一群', 'alice', 'group-b'))
  ]);
  assert.equal(received.length, 4);
  assert.deepEqual(new Set(received.map(item => item.content)), new Set(['Alice 的第一句', 'Bob 的一句', 'Alice 的第二句', 'Alice 在另一群']));
  assert.equal(received.some(item => item.source_ids?.length > 1), false);
});

test('a normal group event upgraded to an at-event while queued does not duplicate its bubble', async () => {
  const received = [];
  const inbox = fixture(async item => { received.push(item); return { status: 'replied' }; });
  const one = inbox.enqueue(event('first', '小柯，我再补一句'));
  const ordinary = inbox.enqueue({ ...event('same-message', '这一句只有一次'), explicit_mention: false });
  const mention = inbox.enqueue({ ...event('same-message', '这一句只有一次'), explicit_mention: true });
  await Promise.all([one, ordinary, mention]);
  assert.equal(received.length, 1);
  assert.equal(received[0].content, '小柯，我再补一句\n这一句只有一次');
  assert.deepEqual(received[0].source_ids, ['first', 'same-message']);
});

test('redelivery during execution shares the active item instead of scheduling a second reply', async () => {
  let started; let release; let calls = 0;
  const begun = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const inbox = fixture(async () => { calls++; started(); await gate; return { status: 'replied' }; });
  const first = inbox.enqueue(event('active', '正在处理这一句'));
  await begun;
  const duplicate = inbox.enqueue({ ...event('active', '正在处理这一句'), explicit_mention: true });
  release();
  assert.deepEqual(await Promise.all([first, duplicate]), [{ status: 'replied' }, { status: 'replied' }]);
  assert.equal(calls, 1);
});

test('quiet and other control commands form separate queue items between ordinary bubbles', async () => {
  const received = [];
  const inbox = fixture(async item => { received.push(item.content); });
  const jobs = [inbox.enqueue(event('first', '先讲一句')), inbox.enqueue(event('quiet', '/quiet'))];
  assert.equal(inbox.hasPendingFor(event('next', '再讲一句')), false);
  jobs.push(inbox.enqueue(event('after', '再讲一句')));
  jobs.push(inbox.enqueue(event('wake', '出来聊聊')));
  await Promise.all(jobs);
  assert.deepEqual(received, ['先讲一句', '/quiet', '再讲一句', '出来聊聊']);
});

test('a failed queue item rejects its callers and does not prevent the following member from being answered', async () => {
  const received = [];
  const inbox = fixture(async item => {
    received.push(item.id);
    if (item.id === 'fail') throw new Error('generation-offline');
    return { status: 'replied' };
  });
  const failed = assert.rejects(inbox.enqueue(event('fail', '失败的请求')), /generation-offline/);
  const success = inbox.enqueue(event('ok', '接下来的请求', 'bob'));
  await failed;
  assert.deepEqual(await success, { status: 'replied' });
  assert.deepEqual(received, ['fail', 'ok']);
  assert.equal(inbox.pending, 0);
  assert.deepEqual(await inbox.enqueue(event('again', '后续还能用')), { status: 'replied' });
});

test('participant batching preserves each real speaker and uses the latest message as the reply target', async () => {
  const received = [];
  const inbox = fixture(async item => { received.push(item); return { status: 'replied' }; }, { batchParticipants: true });
  const a = inbox.enqueue(event('a-request', '小柯，讲个笑话', 'alice'));
  const b = inbox.enqueue(event('b-interruption', '要和猫有关', 'bob'));
  const context = inbox.pendingForGroup('group-a');
  assert.deepEqual(context.pendingMessages.map(message => message.content), ['小柯，讲个笑话', '要和猫有关']);
  assert.equal(context.pendingSpeakers.length, 2);
  assert.ok(context.pendingSpeakers.every(speaker => /^member_[a-f0-9]{16}$/.test(speaker)));
  await Promise.all([a, b]);
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'b-interruption');
  assert.equal(received[0].content, '要和猫有关');
  assert.equal(received[0].author.member_openid, 'bob');
  assert.deepEqual(received[0].source_ids, ['a-request', 'b-interruption']);
  assert.deepEqual(received[0].turn_messages.map(message => [message.author.member_openid, message.content]), [['alice', '小柯，讲个笑话'], ['bob', '要和猫有关']]);
  assert.deepEqual(inbox.pendingForGroup('group-a'), { pendingMessages: [], pendingSpeakers: [] });
});

test('participant batching keeps commands and other groups in separate turns', async () => {
  const received = [];
  const inbox = fixture(async item => { received.push(item); }, { batchParticipants: true });
  await Promise.all([
    inbox.enqueue(event('a', '普通消息', 'alice')),
    inbox.enqueue(event('quiet', '/quiet', 'bob')),
    inbox.enqueue(event('b', '另一条普通消息', 'bob')),
    inbox.enqueue(event('forget', '/forget', 'alice')),
    inbox.enqueue(event('reset', '/reset', 'bob')),
    inbox.enqueue(event('remember', '/remember 喜欢猫', 'alice')),
    inbox.enqueue(event('other-group', '别的群的消息', 'carol', 'group-b'))
  ]);
  assert.equal(received.length, 7);
  assert.ok(received.every(item => item.turn_messages.length === 1));
  assert.equal(received.find(item => item.group_openid === 'group-b').turn_messages[0].content, '别的群的消息');
});

async function busyFixture(options = {}) {
  let now = 0, release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  const received = [], sleeps = [];
  const inbox = new GroupInbox({ batchParticipants: true, coalesceWhileBusy: true, delayMs: 1600, gapMs: 1000,
    now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; await new Promise(resolve => setImmediate(resolve)); },
    handle: async item => {
      received.push(item);
      if (item.id === 'active') { started(); await gate; }
      return { status: 'replied', source_ids: item.source_ids };
    }, ...options });
  const jobs = [inbox.enqueue(event('active', '已经交给模型的 A 问题', 'alice'))];
  await begun;
  return { inbox, received, sleeps,
    enqueueAt(time, input) { now = time; const job = inbox.enqueue(input); jobs.push(job); return job; },
    async finish() { release(); return await Promise.all(jobs); }
  };
}

test('busy coalescing combines later B and C requests without mutating the active turn or adding a new wait window', async () => {
  const f = await busyFixture();
  const active = structuredClone(f.received[0]);
  let results;
  try {
    f.enqueueAt(3000, event('b', 'B 要求猫的笑话', 'bob'));
    f.enqueueAt(7000, event('c', 'C 补充要冷笑话', 'carol'));
    assert.equal(f.inbox.pending, 2);
    assert.deepEqual(f.received[0], active);
    assert.deepEqual(f.inbox.pendingForGroup('group-a').pendingMessages.map(message => message.messageId), ['active', 'b', 'c']);
  } finally { results = await f.finish(); }
  assert.equal(f.received.length, 2);
  assert.deepEqual(f.received[0], active);
  assert.equal(f.received[1].id, 'c');
  assert.deepEqual(f.received[1].source_ids, ['b', 'c']);
  assert.deepEqual(f.received[1].turn_messages.map(message => [message.author.member_openid, message.content]), [
    ['bob', 'B 要求猫的笑话'], ['carol', 'C 补充要冷笑话']
  ]);
  assert.deepEqual(results[1], results[2]);
  assert.deepEqual(f.sleeps, [1600, 1000]);
});

test('busy coalescing never crosses forget or other command barriers', async () => {
  const f = await busyFixture();
  try {
    f.enqueueAt(3000, event('b', '清空前的 B 发言', 'bob'));
    f.enqueueAt(5000, event('forget', '/forget', 'bob'));
    f.enqueueAt(7000, event('c', '清空后的 C 发言', 'carol'));
    f.enqueueAt(11000, event('d', '清空后的 D 补充', 'dave'));
    assert.equal(f.inbox.pending, 4);
  } finally { await f.finish(); }
  assert.deepEqual(f.received.map(item => item.source_ids), [['active'], ['b'], ['forget'], ['c', 'd']]);
  assert.deepEqual(f.received[3].turn_messages.map(message => message.author.member_openid), ['carol', 'dave']);
});

test('busy coalescing false and the default retain the existing time window', async () => {
  for (const coalesceWhileBusy of [false, undefined]) {
    const f = await busyFixture({ coalesceWhileBusy });
    try {
      f.enqueueAt(3000, event('b', 'B 的问题', 'bob'));
      f.enqueueAt(7000, event('c', 'C 的问题', 'carol'));
      assert.equal(f.inbox.pending, 3);
    } finally { await f.finish(); }
    assert.deepEqual(f.received.map(item => item.source_ids), [['active'], ['b'], ['c']]);
  }
});

test('busy coalescing still splits at the message and text capacity limits', async () => {
  const f = await busyFixture();
  try {
    for (let index = 0; index < 21; index++) f.enqueueAt(3000 + index * 3000, event(`m-${index}`, `成员 ${index} 的问题`, `member-${index}`));
    f.enqueueAt(70000, event('barrier', '/reset'));
    f.enqueueAt(73000, event('long-a', '甲'.repeat(4000), 'alice'));
    f.enqueueAt(76000, event('long-b', '乙'.repeat(4000), 'bob'));
  } finally { await f.finish(); }
  assert.deepEqual(f.received.map(item => item.turn_messages.length), [1, 20, 1, 1, 1, 1]);
  assert.deepEqual(f.received[1].source_ids, Array.from({ length: 20 }, (_, index) => `m-${index}`));
  assert.deepEqual(f.received.slice(-2).map(item => item.source_ids), [['long-a'], ['long-b']]);
});

test('pending room metadata includes active and queued speakers without exposing author credentials or mutable state', async () => {
  let started; let release;
  const begun = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const inbox = fixture(async () => { started(); await gate; }, { batchParticipants: true });
  const first = inbox.enqueue({ ...event('active-a', '正在回复 A'), token: 'SECRET_SENTINEL', author: { member_openid: 'alice', secret: 'AUTHOR_SECRET_SENTINEL' } });
  await begun;
  const second = inbox.enqueue(event('queued-b', '等待回复 B', 'bob'));
  const snapshot = inbox.pendingForGroup('group-a');
  assert.deepEqual(snapshot.pendingMessages.map(message => message.messageId), ['active-a', 'queued-b']);
  assert.doesNotMatch(JSON.stringify(snapshot), /alice|bob|SECRET_SENTINEL/);
  snapshot.pendingMessages[0].content = 'tampered'; snapshot.pendingSpeakers.length = 0;
  assert.equal(inbox.pendingForGroup('group-a').pendingMessages[0].content, '正在回复 A');
  assert.equal(inbox.pendingForGroup('group-a').pendingSpeakers.length, 2);
  release(); await Promise.all([first, second]);
});

test('queue overflow reports every rejected source explicitly and the same message can be retried later', async () => {
  const received = [];
  const inbox = fixture(async item => { received.push(item.id); return { status: 'replied' }; }, { batchParticipants: true, maxQueuedTurns: 1 });
  const first = inbox.enqueue(event('first', '/memory', 'alice'));
  const overflow = event('overflow', '/memory', 'bob');
  assert.deepEqual(await inbox.enqueue(overflow), {
    status: 'busy', reason: 'queue_capacity', pendingTurns: 1, source_ids: ['overflow']
  });
  assert.deepEqual(inbox.pendingForGroup('group-a').pendingMessages.map(message => message.messageId), ['first']);
  await first;
  assert.deepEqual(await inbox.enqueue(overflow), { status: 'replied' });
  assert.deepEqual(received, ['first', 'overflow']);
});

test('the default queue accepts more than eight separate turns and preserves expired results truthfully', async () => {
  const received = [];
  const inbox = fixture(async item => { received.push(item.id); return { status: 'expired' }; }, { batchParticipants: true });
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => inbox.enqueue(event(`queued-${index}`, '/memory'))));
  assert.equal(received.length, 10);
  assert.deepEqual(results, Array(10).fill({ status: 'expired' }));
  assert.deepEqual(await inbox.enqueue(event('queued-0', '/memory')), { status: 'expired' });
  assert.equal(received.length, 10);
});

test('ordered dispatch delivers a slow earlier decision before a fast forget command', async () => {
  const ordered = new OrderedGroupDispatch(), delivered = [];
  let decideFirst;
  const firstDecision = new Promise(resolve => { decideFirst = resolve; });
  const first = ordered.dispatch('group-a', firstDecision, decision => delivered.push(decision));
  const forget = ordered.dispatch('group-a', Promise.resolve('/forget'), decision => delivered.push(decision));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  decideFirst('我喜欢猫');
  await Promise.all([first, forget]);
  assert.deepEqual(delivered, ['我喜欢猫', '/forget']);
});

test('ordered dispatch keeps different groups independent while awaiting each group delivery', async () => {
  const ordered = new OrderedGroupDispatch(), delivered = [];
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const first = ordered.dispatch('group-a', Promise.resolve('a-first'), async decision => { started(); await gate; delivered.push(decision); });
  await began;
  const second = ordered.dispatch('group-a', Promise.resolve('a-second'), decision => delivered.push(decision));
  await ordered.dispatch('group-b', Promise.resolve('b-independent'), decision => delivered.push(decision));
  assert.deepEqual(delivered, ['b-independent']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(delivered, ['b-independent', 'a-first', 'a-second']);
});

test('rejected decisions and failed deliveries do not block later ordered dispatches', async () => {
  const ordered = new OrderedGroupDispatch(), delivered = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = ordered.dispatch('group-a', gate, decision => delivered.push(decision));
  const failedDecision = assert.rejects(ordered.dispatch('group-a', Promise.reject(new Error('classification-failed')),
    () => assert.fail('failed classification cannot be delivered')), /classification-failed/);
  const failedDelivery = assert.rejects(ordered.dispatch('group-a', Promise.resolve('failed'), async () => {
    throw new Error('delivery-failed');
  }), /delivery-failed/);
  const after = ordered.dispatch('group-a', Promise.resolve('after-errors'), decision => delivered.push(decision));
  await new Promise(resolve => setImmediate(resolve));
  release('first');
  await Promise.all([first, failedDecision, failedDelivery, after]);
  assert.deepEqual(delivered, ['first', 'after-errors']);
  assert.equal(ordered.tails.size, 0);
});
