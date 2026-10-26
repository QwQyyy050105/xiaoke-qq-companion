import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupRouter } from '../src/routing.mjs';
import { GroupInbox, OrderedGroupDispatch } from '../src/inbox.mjs';
import { Companion } from '../src/core.mjs';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (id, extra = {}) => ({ id, content: '今天终于把这道题做出来了', group_openid: 'room-a',
  author: { member_openid: 'alice' }, explicit_mention: false, _receivedAt: 1000, ...extra });
const mention = input => ({ ...input, explicit_mention: true, event_type: 'GROUP_AT_MESSAGE_CREATE' });
const optional = new Set(['ambient_candidate', 'contextual_candidate', 'classified_continuation', 'clear_continuation']);

function fixture(handle, { sleep = async () => new Promise(resolve => setImmediate(resolve)) } = {}) {
  const router = new GroupRouter({ now: () => 1000, decideWithReply: true, ambientParticipation: true });
  const ordered = new OrderedGroupDispatch();
  const inbox = new GroupInbox({ handle, delayMs: 0, gapMs: 0, now: () => 1000, sleep, batchParticipants: true });
  return { inbox, async dispatch(input) {
    let reply;
    const decision = await ordered.dispatch(input.group_openid,
      router.decide(input, [], inbox.pendingForGroup(input.group_openid)), decision => {
        if (decision.addressed) reply = inbox.enqueue({ ...input, allow_silence: optional.has(decision.reason) });
        return decision;
      });
    return { decision, reply };
  } };
}

test('gateway candidate then explicit mention upgrades the queued turn through the real router and inbox', async () => {
  const ready = gate(), calls = [];
  const f = fixture(async input => { calls.push(structuredClone(input)); return { status: 'replied' }; }, { sleep: () => ready.promise });
  const ordinary = event('queued');
  const first = await f.dispatch(ordinary);
  const upgrade = await f.dispatch(mention(ordinary));
  ready.resolve();
  await Promise.all([first.reply, upgrade.reply]);
  assert.equal(upgrade.decision.addressed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].explicit_mention, true);
  assert.equal(calls[0].allow_silence, false);
  assert.deepEqual(calls[0].source_ids, ['queued']);
});

test('a late explicit mention retries an already running candidate only after a definitive silent result', async () => {
  const begun = gate(), finish = gate(), calls = [], outputs = [];
  const f = fixture(async input => {
    calls.push(structuredClone(input));
    if (calls.length === 1) { begun.resolve(); await finish.promise; return { status: 'silent' }; }
    outputs.push(input.id); return { status: 'replied' };
  });
  const ordinary = event('active-silent');
  const first = await f.dispatch(ordinary); await begun.promise;
  const upgrade = await f.dispatch(mention(ordinary));
  const duplicate = await f.dispatch(mention(ordinary));
  finish.resolve();
  await Promise.all([first.reply, upgrade.reply, duplicate.reply]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].allow_silence, true, 'the in-flight model snapshot is not mutated');
  assert.equal(calls[1].allow_silence, false);
  assert.equal(calls[1].explicit_mention, true);
  assert.deepEqual(outputs, ['active-silent']);
  assert.equal(duplicate.decision.addressed, false);
});

test('a running candidate that actually replies never repeats after the mention upgrade', async () => {
  const begun = gate(), finish = gate(); let calls = 0;
  const f = fixture(async () => { calls++; begun.resolve(); await finish.promise; return { status: 'replied' }; });
  const ordinary = event('active-replied');
  const first = await f.dispatch(ordinary); await begun.promise;
  const upgrade = await f.dispatch(mention(ordinary));
  finish.resolve();
  assert.deepEqual(await Promise.all([first.reply, upgrade.reply]), [{ status: 'replied' }, { status: 'replied' }]);
  assert.equal(calls, 1);
});

test('a completed silent candidate can be upgraded once without refreshing its original reply deadline', async () => {
  const calls = [];
  const f = fixture(async input => { calls.push(structuredClone(input)); return { status: input.allow_silence ? 'silent' : 'replied' }; });
  const ordinary = event('completed-silent');
  const first = await f.dispatch(ordinary); assert.equal((await first.reply).status, 'silent');
  const upgrade = await f.dispatch({ ...mention(ordinary), _receivedAt: 9000 });
  assert.equal((await upgrade.reply).status, 'replied');
  const duplicate = await f.dispatch(mention(ordinary));
  assert.equal(duplicate.decision.addressed, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]._receivedAt, 1000);
});

test('completed replies and uncertain delivery outcomes are never retried by an explicit variant', async () => {
  for (const result of [{ status: 'replied' }, { status: 'expired' }, undefined]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return result; });
    const ordinary = event('completed');
    const first = await f.dispatch(ordinary); await first.reply;
    const upgrade = await f.dispatch(mention(ordinary)); await upgrade.reply;
    assert.equal(calls, 1);
  }
});

test('concurrent candidate and at variants preserve both members and emit a single group turn', async () => {
  const ready = gate(), calls = [];
  const f = fixture(async input => { calls.push(structuredClone(input)); return { status: 'replied' }; }, { sleep: () => ready.promise });
  const ordinary = event('alice');
  const jobs = await Promise.all([f.dispatch(ordinary), f.dispatch(mention(ordinary)),
    f.dispatch(event('bob', { author: { member_openid: 'bob' }, content: '我也终于做出来了' })), f.dispatch(mention(ordinary))]);
  ready.resolve(); await Promise.all(jobs.map(job => job.reply));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].allow_silence, false);
  assert.deepEqual(calls[0].turn_messages.map(input => [input.id, input.author.member_openid]), [['alice', 'alice'], ['bob', 'bob']]);
  assert.equal(jobs.filter(job => job.decision.addressed).length, 3);
});

test('the explicit event type alone upgrades queued candidates, with separate groups independent', async () => {
  const ready = gate(), calls = [];
  const f = fixture(async input => { calls.push(structuredClone(input)); return { status: 'replied' }; }, { sleep: () => ready.promise });
  const ordinary = event('same-id');
  const first = await f.dispatch(ordinary);
  const second = await f.dispatch({ ...ordinary, event_type: 'GROUP_AT_MESSAGE_CREATE' });
  const other = await f.dispatch({ ...ordinary, group_openid: 'room-b' });
  ready.resolve(); await Promise.all([first.reply, second.reply, other.reply]);
  assert.equal(calls.length, 2);
  const updated = calls.find(input => input.group_openid === 'room-a');
  assert.equal(updated.explicit_mention, true);
  assert.equal(updated.allow_silence, false);
  assert.equal(calls.find(input => input.group_openid === 'room-b').allow_silence, true);
});

async function companionFixture(t, generate) {
  const tempRoot = resolve(process.cwd(), 'temp');
  const dir = await mkdtemp(join(tempRoot, 'mention_upgrade_'));
  const instances = [];
  const open = async () => {
    const bot = await new Companion({ dataDir: dir, generate, now: () => 1000 }).init();
    instances.push(bot); return bot;
  };
  t.after(async () => {
    await Promise.all(instances.map(bot => bot.persistence));
    assert.ok(resolve(dir).startsWith(tempRoot + sep));
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(access(dir), error => error.code === 'ENOENT');
  });
  return { bot: await open(), open };
}

test('a real companion honors an in-flight mention upgrade after the first model pass stays silent', async t => {
  const begun = gate(), finish = gate(), sent = []; let modelCalls = 0;
  const { bot } = await companionFixture(t, async () => {
    if (++modelCalls === 1) { begun.resolve(); await finish.promise; return { reply: '', social: { action: 'silent' } }; }
    return '接住啦，这题做出来了！';
  });
  const f = fixture(input => bot.handle(input, async text => { sent.push(text); return { id: `reply-${sent.length}` }; }));
  const ordinary = event('core-running');
  const first = await f.dispatch(ordinary); await begun.promise;
  const upgrade = await f.dispatch(mention(ordinary));
  finish.resolve();
  assert.equal((await first.reply).status, 'replied');
  assert.equal((await upgrade.reply).status, 'replied');
  assert.equal(modelCalls, 2);
  assert.deepEqual(sent, ['接住啦，这题做出来了！']);
});

test('persisted silent outcomes filter ordinary replay after restart but allow one explicit upgrade', async t => {
  let modelCalls = 0; const sent = [];
  const { bot, open } = await companionFixture(t, async () => ++modelCalls === 1
    ? { reply: '', social: { action: 'silent' } } : '我接着看。');
  const ordinary = event('core-restart', { allow_silence: true });
  const send = async text => { sent.push(text); return { id: 'one-reply' }; };
  assert.equal((await bot.handle(ordinary, send)).status, 'silent');
  const reopened = await open();
  assert.equal(await reopened.handle(ordinary, send), undefined);
  assert.equal(modelCalls, 1);
  assert.equal((await reopened.handle({ ...mention(ordinary), allow_silence: false }, send)).status, 'replied');
  const again = await open();
  assert.equal(await again.handle({ ...mention(ordinary), allow_silence: false }, send), undefined);
  assert.equal(modelCalls, 2);
  assert.deepEqual(sent, ['我接着看。']);
});

test('a failed explicit upgrade is consumed and an uncertain delivery is not replayed', async t => {
  let modelCalls = 0;
  const { bot, open } = await companionFixture(t, async () => ++modelCalls === 1
    ? { reply: '', social: { action: 'silent' } } : '这条可能已送达。');
  const ordinary = event('core-uncertain', { allow_silence: true });
  await bot.handle(ordinary, async () => assert.fail('silent does not send'));
  const upgrade = { ...mention(ordinary), allow_silence: false };
  await assert.rejects(bot.handle(upgrade, async () => { throw new Error('unknown_delivery'); }), /unknown_delivery/);
  const reopened = await open();
  assert.equal(await reopened.handle(upgrade, async () => assert.fail('unknown delivery must not replay')), undefined);
  assert.equal(modelCalls, 2);
});

test('a late mentioned source can join a new member batch without losing either source to core deduplication', async t => {
  let modelCalls = 0; const inputs = [], sent = [];
  const { bot } = await companionFixture(t, async input => {
    inputs.push(input);
    return ++modelCalls === 1 ? { reply: '', social: { action: 'silent' } } : '两位都接住啦。';
  });
  const send = async text => { sent.push(text); return { id: 'combined-reply' }; };
  const ordinary = event('first-member', { allow_silence: true });
  assert.equal((await bot.handle(ordinary, send)).status, 'silent');
  const ready = gate();
  const f = fixture(input => bot.handle(input, send), { sleep: () => ready.promise });
  const second = await f.dispatch(event('second-member', { author: { member_openid: 'bob' }, content: '也看看我的题。' }));
  const first = await f.dispatch(mention(ordinary));
  ready.resolve();
  assert.equal((await first.reply).status, 'replied');
  assert.equal((await second.reply).status, 'replied');
  assert.deepEqual(inputs[1].turnMessages.map(input => input.messageId), ['second-member', 'first-member']);
  assert.deepEqual(sent, ['两位都接住啦。']);
  assert.equal(modelCalls, 2);
});

test('forget removes silent upgrade eligibility so an old mention cannot revive forgotten context', async t => {
  let modelCalls = 0;
  const { bot, open } = await companionFixture(t, async () => {
    modelCalls++; return { reply: '', social: { action: 'silent' } };
  });
  const ordinary = event('before-forget', { allow_silence: true });
  await bot.handle(ordinary, async () => assert.fail('silent cannot send'));
  await bot.handle(mention(event('forget', { content: '/forget' })), async () => ({ id: 'forgotten' }));
  const reopened = await open();
  assert.equal(await reopened.handle({ ...mention(ordinary), allow_silence: false }, async () => assert.fail('old context cannot revive')), undefined);
  assert.equal(modelCalls, 1);
  assert.equal(Object.keys(reopened.state.silentGroupMessages).length, 0);
});
