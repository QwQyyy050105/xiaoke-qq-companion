import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { OwnerBrowserService } from '../src/owner_browser_service.mjs';
import { ownerBrowserNotifier } from '../src/owner_browser_delivery.mjs';
import { conversationPrompt } from '../src/model_client.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(resolve('temp'), 'browser_service_'));
  await mkdir(join(root, 'data', 'owner_browser'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = { snapshot: () => [], context: () => [], stop: async () => {}, ownerChanged: async () => {} };
  return OwnerBrowserService.open({ root, config: {}, getOwner: () => 'owner-fixture',
    loginBinding: { ownerHash: createHash('sha256').update(overrides.getOwner?.() || 'owner-fixture').digest('hex') },
    browser: { open: async () => ({ navigate: async () => {}, close: async () => {} }) },
    runWorker: async () => ({ status: 'completed', text: '实际观察', receipts: [] }),
    jobsFactory: async () => jobs, ...overrides });
}
const job = () => ({ id: 'job-fixture', task: '浏览页面', signal: new AbortController().signal,
  isCurrent: async () => true, onObservation: async () => {} });

test('login and browser work cannot overlap, and closing login does not assert authentication', async t => {
  let opened, closed = 0, workerCalls = 0;
  const service = await fixture(t, { browser: { open: async options => { opened = options;
    return { navigate: async () => {}, close: async () => closed++ }; } },
    runWorker: async () => { workerCalls++; return { status: 'completed', text: '观察', receipts: [] }; } });
  const login = await service.openLogin();
  assert.equal(login.authentication, 'unverified'); assert.equal(opened.loginMode, true); assert.equal(opened.headless, false);
  assert.equal((await service.run(job())).status, 'awaiting_login'); assert.equal(workerCalls, 0);
  await service.closeLogin(); assert.equal(closed, 1); assert.equal(service.status().authentication, 'owner_confirmed_not_verified');
  await service.run(job()); assert.equal(workerCalls, 1);
});

test('fresh account profile requires explicit host login completion and still does not claim verified auth', async t => {
  let calls = 0;
  const service = await fixture(t, { loginBinding: null, runWorker: async () => { calls++; return { status: 'unavailable', receipts: [] }; } });
  assert.equal((await service.run(job())).status, 'awaiting_login'); assert.equal(calls, 0);
  await service.openLogin(); await service.closeLogin();
  assert.equal((await service.run(job())).status, 'awaiting_login');
  await service.openLogin(); await service.closeLogin({ confirmed: true });
  assert.equal(service.status().authentication, 'owner_confirmed_not_verified');
  await service.run(job()); assert.equal(calls, 1);
});

test('worker internal abort signal survives service bridge and owner change invalidates login', async t => {
  let owner = 'first', runtimeOptions, loginOptions;
  const internal = new AbortController(); let phase = 'worker';
  const service = await fixture(t, { getOwner: () => owner,
    browser: { open: async options => { if (phase === 'worker') runtimeOptions = options; else loginOptions = options;
      return { close: async () => {}, navigate: async () => {} }; } },
    runWorker: async ({ openBrowser }) => { await openBrowser({ signal: internal.signal, isCurrent: () => true });
      return { status: 'unavailable', text: '', receipts: [] }; } });
  await service.run(job()); assert.equal(runtimeOptions.signal, internal.signal); assert.equal(runtimeOptions.ownerId, 'first');
  phase = 'login'; await service.openLogin(); owner = 'second'; assert.equal(loginOptions.isCurrent(), false);
  await service.ownerChanged(); assert.equal(loginOptions.signal.aborted, true); assert.equal(service.status().loginWindowOpen, false);
});

test('a login attempt cannot race an already running browser worker', async t => {
  let finish;
  const service = await fixture(t, { runWorker: async () => new Promise(resolve => { finish = resolve; }) });
  const run = service.run(job());
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.openLogin(), /owner_browser_busy/);
  finish({ status: 'unavailable', text: '', receipts: [] }); await run;
});

test('deferred browser delivery rechecks cancellation after queue wait and never sends stale text', async () => {
  let valid = true, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const notify = ownerBrowserNotifier({ serialize: async fn => { await gate; return fn(); }, current: () => true,
    remaining: () => 3, nextSequence: () => 2, rollbackSequence() {}, sendText: async () => { calls++; }, record() {} });
  const sent = notify({}, { summary: '页面见闻' }, { isCurrent: async () => valid, guard: () => valid });
  valid = false; release(); await assert.rejects(sent, /notice_stale/); assert.equal(calls, 0);
});

test('transport receives live guard, ambiguous send is not retried or written to history', async () => {
  let valid = true, calls = 0, records = 0, sequence = 1;
  const notify = ownerBrowserNotifier({ serialize: fn => fn(), current: () => true, remaining: () => 4 - sequence,
    nextSequence: () => ++sequence, rollbackSequence: () => --sequence,
    sendText: async (_text, seq, guard) => { calls++; assert.equal(seq, 2); valid = false; assert.equal(guard(), false); throw Error('uncertain'); },
    record: () => records++ });
  await assert.rejects(notify({}, { summary: '见闻' }, { isCurrent: async () => true, guard: () => valid }), /uncertain/);
  assert.equal(calls, 1); assert.equal(records, 0); assert.equal(sequence, 2);
});

test('only an actual send receipt enters history; an explicitly unsent attempt releases sequence', async () => {
  let sequence = 1, mode = 'unsent', records = 0;
  const notify = ownerBrowserNotifier({ serialize: fn => fn(), current: () => true, remaining: () => 4 - sequence,
    nextSequence: () => ++sequence, rollbackSequence: () => --sequence,
    sendText: async () => { if (mode === 'unsent') throw Object.assign(Error('stale'), { messageNotSent: true });
      return mode === 'confirmed' ? { id: 'actual-fixture-receipt' } : {}; },
    record: async () => records++ });
  const options = { isCurrent: async () => true, guard: () => true };
  await assert.rejects(notify({}, { reply: '见闻' }, options)); assert.equal(sequence, 1);
  mode = 'unknown'; await assert.rejects(notify({}, { reply: '见闻' }, options), /unconfirmed/); assert.equal(records, 0);
  mode = 'confirmed'; await notify({}, { reply: '见闻' }, options); assert.equal(records, 1);
});

test('owner browser observations reach private chat but cannot enter group or proactive prompts', () => {
  const input = { text: '聊聊', structured: true, ownerBrowserStatus: { configured: true },
    ownerBrowserContext: 'PRIVATE_BROWSER_OBSERVATION_FIXTURE' };
  assert.match(conversationPrompt('小柯', input), /PRIVATE_BROWSER_OBSERVATION_FIXTURE/);
  assert.doesNotMatch(conversationPrompt('小柯', { ...input, speaker: 'member-fixture' }), /PRIVATE_BROWSER_OBSERVATION_FIXTURE/);
  assert.doesNotMatch(conversationPrompt('小柯', { ...input, mode: 'proactive' }), /PRIVATE_BROWSER_OBSERVATION_FIXTURE/);
});
