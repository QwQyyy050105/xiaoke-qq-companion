import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OwnerBrowserJobs } from '../src/owner_browser_jobs.mjs';
import { durableWriteFile } from '../src/durable_write.mjs';

const TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const OWNER = 'owner-browser-fixture';
const TIME = Date.parse('2026-10-24T12:00:00Z');
const sha = value => createHash('sha256').update(value).digest('hex');
const event = (id = 'message-1', owner = OWNER) => ({ id, chat_type: 'private', author: { user_openid: owner }, _receivedAt: TIME });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const evidence = (id = 'receipt-1', overrides = {}) => ({ tool: 'owner_browser_snapshot', callId: 'call-' + id, receiptId: id, ok: true, observed: true, url: 'https://www.douyin.com/video/123?tracking=private', title: 'A cat video', observedAt: TIME, pageVersion: 1, textSha256: sha('actual visible page'), threadId: 'thread-fixture', turnId: 'turn-fixture', ...overrides });
const completed = (overrides = {}) => ({ status: 'completed', summary: '看到了视频里的猫在玩纸箱。', toolReceipts: [evidence()], ...overrides });
async function fixture(t, options = {}) {
  await fs.mkdir(TEMP, { recursive: true }); const root = await fs.mkdtemp(path.join(TEMP, 'owner_browser_jobs_test_'));
  let owner = OWNER, time = TIME; const calls = [], sent = [], instances = [];
  const args = { root, getOwner: () => owner, now: () => time, runJob: async input => { calls.push(input); return completed(); }, notify: async (e, result, controls) => { sent.push({ event: e, result, controls }); return { id: 'actual-receipt' }; }, ...options };
  const jobs = await OwnerBrowserJobs.open(args); instances.push(jobs);
  t.after(async () => {
    for (const instance of instances) await instance.stop();
    const actual = await fs.realpath(root), actualTemp = await fs.realpath(TEMP);
    assert.ok(actual.toLowerCase().startsWith(actualTemp.toLowerCase() + path.sep));
    await fs.rm(actual, { recursive: true, force: true });
  });
  return { root, jobs, calls, sent, args, owner: value => { owner = value; }, advance: ms => { time += ms; },
    open: async () => { const next = await OwnerBrowserJobs.open(args); instances.push(next); return next; },
    file: (id, name = 'job.json') => path.join(root, 'data/owner_browser/jobs', id, name) };
}
async function waitFor(callback, message = 'condition') { for (let i = 0; i < 400; i++) { const result = await callback(); if (result) return result; await pause(); } assert.fail('Timed out: ' + message); }
const settle = (jobs, id, status) => waitFor(() => jobs.snapshot().find(record => record.id === id && record.status === status), status);
async function start(f, id = 'message-1', task = '去抖音看看猫咪视频', options) { const result = await f.jobs.handle(event(id), '/browse ' + task, options); assert.ok(result.jobId, result.reply); assert.equal(result.created, true); return result.jobId; }
const flush = jobs => jobs.handle(event('status-barrier'), '/browsestatus');

test('only bound owner private instructions create jobs, ordinary group and personal conversation remain chat', async t => {
  const f = await fixture(t);
  for (const e of [event('wrong', 'other'), { ...event('group'), group_openid: 'group' }, { ...event('group-kind'), chat_type: 'group' }, { ...event('bot'), author: { user_openid: OWNER, bot: true } }, { ...event('self'), is_self: true }]) {
    assert.match((await f.jobs.handle(e, '/browse go')).reply, /只接受/);
    assert.equal((await f.jobs.handle(e, '小柯，去抖音看看猫咪')).handled, false);
  }
  for (const text of ['小柯我今天看了抖音', '你能浏览网页吗', '帮我看看这题', '小柯，看看我', '我想去抖音看看']) assert.equal((await f.jobs.handle(event(), text)).handled, false);
  f.owner(''); assert.match((await f.jobs.handle(event(), '/browse go')).reply, /只接受/);
  assert.equal(f.calls.length, 0); assert.equal(f.jobs.snapshot().length, 0);
});

test('narrow natural browse requests become real asynchronous jobs and preserve private verified context', async t => {
  const f = await fixture(t); const result = await f.jobs.handle(event(), '小柯，去抖音看看猫咪视频');
  assert.ok(result.jobId); await settle(f.jobs, result.jobId, 'completed'); await waitFor(() => f.sent.length === 1);
  assert.equal(f.calls[0].task, '小柯，去抖音看看猫咪视频'); assert.match(f.calls[0].outputDir, /artifacts$/);
  assert.ok(f.calls[0].outputDir.startsWith(f.root + path.sep));
  const record = JSON.parse(await fs.readFile(f.file(result.jobId), 'utf8'));
  assert.equal(record.receipts[0].url, 'https://www.douyin.com/video/123');
  assert.match(await f.jobs.context(event()), /猫在玩纸箱/);
  assert.equal(await f.jobs.context({ ...event(), group_openid: 'group' }), '');
  assert.equal(await f.jobs.context(event('not-owner', 'other')), '');
  const stored = JSON.stringify(record); assert.doesNotMatch(stored, /owner-browser-fixture|message-1|tracking|actual visible page|thread-fixture/);
  assert.doesNotMatch(JSON.stringify(f.jobs.snapshot()), /猫在玩纸箱|猫咪视频|douyin/);
  await waitFor(() => !f.jobs.draining); assert.equal(await f.sent[0].controls.isCurrent(), false, 'completed worker no longer owns a later send');
});

test('handle completes while worker is blocked, browser execution is exclusive and pending capacity bounded', async t => {
  const first = gate(), calls = [];
  const f = await fixture(t, { maxPending: 2, runJob: async input => { calls.push(input); if (calls.length === 1) await first.promise; return completed({ toolReceipts: [evidence('receipt-' + calls.length)] }); } });
  const one = await start(f); await settle(f.jobs, one, 'running'); const two = await start(f, 'message-2', '浏览这个网页 https://example.com');
  assert.equal(f.jobs.snapshot().find(record => record.id === two).status, 'queued'); assert.equal(calls.length, 1);
  assert.match((await f.jobs.handle(event('message-3'), '/browse 去抖音看看第三个话题')).reply, /队列暂时满/);
  first.resolve(); await settle(f.jobs, two, 'completed'); assert.equal(calls.length, 2);
});

test('message and recent task dedupe survive restart without replay or refreshed delivery window', async t => {
  const f = await fixture(t); const id = await start(f); await settle(f.jobs, id, 'completed'); await flush(f.jobs);
  const duplicate = await f.jobs.handle(event('message-2'), '/browse 去抖音看看猫咪视频'); assert.equal(duplicate.existingJobId, id); assert.equal(duplicate.jobId, undefined);
  await f.jobs.stop(); f.advance(100000); const reopened = await f.open();
  const replay = await reopened.handle(event('message-2'), '/browse 不同措辞'); assert.equal(replay.existingJobId, id); assert.equal(f.calls.length, 1);
  const record = JSON.parse(await fs.readFile(f.file(id))); assert.equal(record.deliveryDeadline, TIME + 3540000);
});

test('restart marks queued and running jobs interrupted and never replays a browser or notification', async t => {
  const f = await fixture(t); const id = await start(f, 'message-1', '去抖音看看视频', { deferStart: true });
  await f.jobs.stop(); const record = JSON.parse(await fs.readFile(f.file(id))); record.status = 'running'; await fs.writeFile(f.file(id), JSON.stringify(record));
  const reopened = await f.open(); assert.equal(reopened.snapshot()[0].status, 'interrupted'); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  assert.match((await reopened.handle(event(), '/browsestatus')).reply, /未自动重放/);
});

test('deferred jobs await explicit acknowledgement activation; dedupe/status never activate or replace notification', async t => {
  const f = await fixture(t); let personalNotifications = 0;
  const id = await start(f, 'message-1', '去抖音看看视频', { deferStart: true, notify: async () => { personalNotifications++; return { id: 'reply' }; } });
  await pause(); assert.equal(f.calls.length, 0); await f.jobs.handle(event('status'), '/browsestatus ' + id);
  assert.equal((await f.jobs.handle(event(), '/browse 去抖音看看视频', { notify: async () => assert.fail('duplicate callback') })).jobId, undefined);
  assert.equal(f.calls.length, 0); assert.equal(await f.jobs.activate(id), true); await settle(f.jobs, id, 'completed');
  await waitFor(() => personalNotifications === 1); assert.equal(f.sent.length, 0);
});

test('ack failure can cancel deferred job without launching it', async t => {
  const f = await fixture(t); const id = await start(f, 'message-1', '去抖音看看视频', { deferStart: true });
  assert.equal(await f.jobs.cancel(id), true); assert.equal(await f.jobs.activate(id), false); assert.equal(f.calls.length, 0);
});

test('cancel aborts immediately, late receipts/results cannot revive work, and next job waits for real worker exit', async t => {
  const blocked = gate(), calls = [];
  const f = await fixture(t, { runJob: async input => { calls.push(input); if (calls.length === 1) await blocked.promise; return completed(); } });
  const first = await start(f); await waitFor(() => calls.length === 1);
  const second = await start(f, 'message-2', '去抖音看看另一段视频');
  const canceled = await f.jobs.handle(event('cancel'), '/browsecancel ' + first); assert.match(canceled.reply, /已取消/); assert.equal(calls[0].signal.aborted, true);
  assert.equal(await calls[0].onObservation({ receipt: evidence(), summary: '不该保存的观察' }), false);
  await pause(); assert.equal(calls.length, 1); assert.equal(f.jobs.snapshot().find(record => record.id === first).workerSettling, true);
  blocked.resolve(); await settle(f.jobs, second, 'completed'); assert.equal(f.jobs.snapshot()[0].status, 'canceled');
  assert.equal(f.sent.some(item => item.result.id === first), false);
});

test('timeout aborts a nonsettling worker without overlapping a second browser, stop never waits forever', async t => {
  const blocked = gate(); let input;
  const f = await fixture(t, { timeoutMs: 20, runJob: async value => { input = value; return blocked.promise; } });
  const id = await start(f); await settle(f.jobs, id, 'expired'); assert.equal(input.signal.aborted, true);
  await f.jobs.stop(); blocked.resolve(completed()); await pause(); assert.equal(f.sent.length, 0);
});

test('owner changes abort old work; neither replacement owner nor returning owner can adopt an old result', async t => {
  const blocked = gate(); let input;
  const f = await fixture(t, { runJob: async value => { input = value; return blocked.promise; } });
  const id = await start(f); await waitFor(() => input); f.owner('new-owner'); await f.jobs.ownerChanged();
  assert.equal(input.signal.aborted, true); assert.equal(await input.isCurrent(), false);
  assert.match((await f.jobs.handle(event('status', 'new-owner'), '/browsestatus ' + id)).reply, /没有找到/);
  f.owner(OWNER); await f.jobs.ownerChanged(); blocked.resolve(completed()); await pause(); assert.equal(f.jobs.snapshot()[0].status, 'canceled'); assert.equal(f.sent.length, 0);
});

test('forget immediately invalidates worker and removes private observations and artifacts while retaining replay tombstone', async t => {
  const blocked = gate(); let input;
  const f = await fixture(t, { runJob: async value => { input = value; await value.onObservation({ receipt: evidence(), summary: '猫咪观察' }); return blocked.promise; } });
  const id = await start(f); await waitFor(() => f.jobs.snapshot()[0]?.observationCount === 1);
  await fs.writeFile(f.file(id, 'artifacts/temporary.png'), Buffer.from('fixture-image'));
  assert.equal(await f.jobs.forget(event('forget')), true); assert.equal(input.signal.aborted, true);
  assert.equal(await input.onObservation({ receipt: evidence('late'), summary: '迟到的观察' }), false);
  blocked.resolve(completed()); await pause(); await flush(f.jobs);
  const record = JSON.parse(await fs.readFile(f.file(id))); assert.equal(record.status, 'forgotten'); assert.equal(record.task, ''); assert.deepEqual(record.receipts, []);
  assert.deepEqual(await fs.readdir(f.file(id, 'artifacts')), []); assert.equal(await f.jobs.context(event()), ''); assert.equal(f.sent.length, 0);
  assert.equal((await f.jobs.handle(event(), '/browse 去抖音看看猫咪视频')).existingJobId, id);
});

test('completed prose or accepted text without actual observed hashes cannot become browsing evidence', async t => {
  for (const receipts of [[], [evidence('accepted', { observed: false })], [evidence('nohash', { textSha256: '' })], [evidence('unrelated', { tool: 'say_accepted' })], [evidence('nopage', { pageVersion: '' })]]) {
    const f = await fixture(t, { runJob: async () => completed({ toolReceipts: receipts }) }); const id = await start(f); await settle(f.jobs, id, 'unavailable');
    assert.equal(await f.jobs.context(event()), ''); assert.match((await f.jobs.handle(event('status'), '/browsestatus ' + id)).reply, /不能算浏览完成/);
  }
});

test('awaiting login and unavailable remain truthful statuses and do not seed private browsing context', async t => {
  for (const status of ['awaiting_login', 'unavailable']) {
    const f = await fixture(t, { runJob: async () => ({ status, text: '需要你在独立浏览器完成登录。', receipts: [] }) });
    const id = await start(f); await settle(f.jobs, id, status); assert.equal(await f.jobs.context(event()), '');
  }
});

test('secret requests are rejected without execution, and DOM/credential dumps cannot enter persisted observations', async t => {
  const f = await fixture(t);
  for (const request of ['帮我读取登录密码', '导出 cookie', 'api_key=abcdef', '填入验证码123456', '读取 localStorage', '浏览这个网页 https://person:secret@example.com', '浏览这个网页 https://example.com/?token=private', 'x'.repeat(4001)]) assert.match((await f.jobs.handle(event(), '/browse ' + request)).reply, /凭据|长度/);
  assert.equal(f.calls.length, 0);
  f.args.runJob = async () => completed();
  const another = await fixture(t, { runJob: async input => {
    await input.onObservation({ receipt: evidence(), summary: '<div>raw DOM</div>' });
    await input.onObservation({ receipt: evidence('secret'), summary: 'password=do-not-store' });
    return completed({ summary: 'api_key=do-not-store' });
  } });
  const id = await start(another); await settle(another.jobs, id, 'completed'); await flush(another.jobs);
  assert.doesNotMatch(await fs.readFile(another.file(id), 'utf8'), /do-not-store|raw DOM/); assert.equal(another.jobs.snapshot()[0].observationCount, 0);
});

test('QQ reply deadline is fixed at original message time; late completion stays inspectable with no proactive send', async t => {
  const blocked = gate(); const f = await fixture(t, { queueTtlMs: 1800000, runJob: async () => blocked.promise });
  const e = { ...event(), timestamp: new Date(TIME - 3539000).toISOString() }; const result = await f.jobs.handle(e, '/browse 去抖音看看视频');
  await settle(f.jobs, result.jobId, 'running'); f.advance(2000); blocked.resolve(completed()); await settle(f.jobs, result.jobId, 'completed');
  await waitFor(() => f.jobs.snapshot()[0].notification === 'expired'); assert.equal(f.sent.length, 0);
  assert.match((await f.jobs.handle(event('status'), '/browsestatus')).reply, /回复窗口已过期/);
});

test('missing trusted arrival time never invents a notification authorization window', async t => {
  const f = await fixture(t); const e = event(); delete e._receivedAt;
  const result = await f.jobs.handle(e, '/browse 去抖音看看视频'); await settle(f.jobs, result.jobId, 'completed'); await waitFor(() => f.jobs.snapshot()[0].notification === 'expired'); assert.equal(f.sent.length, 0);
});

test('notification is attempted once, ambiguous transport result is durable and never retried on restart', async t => {
  let sends = 0; const f = await fixture(t, { notify: async () => { sends++; throw new Error('transport-response-lost'); } });
  const id = await start(f); await waitFor(() => f.jobs.snapshot()[0]?.notification === 'uncertain'); await f.jobs.stop(); const reopened = await f.open();
  assert.equal(reopened.snapshot()[0].notification, 'uncertain'); assert.equal(sends, 1); assert.equal((await reopened.handle(event(), '/browse go')).existingJobId, id);
});

test('sync delivery guard flips on forget while final notify is waiting and suppresses late callback writes', async t => {
  const blocked = gate(); let controls;
  const f = await fixture(t, { notify: async (event, result, value) => { controls = value; await blocked.promise; return { id: 'late' }; } });
  const id = await start(f); await waitFor(() => controls); assert.equal(controls.guard(), true);
  await f.jobs.forget(event('forget')); assert.equal(controls.guard(), false); blocked.resolve(); await pause();
  assert.equal(f.jobs.snapshot()[0].status, 'forgotten'); assert.equal(f.jobs.snapshot()[0].notification, 'suppressed');
  assert.doesNotMatch(await fs.readFile(f.file(id), 'utf8'), /猫在玩纸箱/);
});

test('artifact receipts require actual matching hash within the verified job D directory', async t => {
  const f = await fixture(t, { runJob: async input => {
    const bytes = Buffer.from('fixture screenshot'), file = path.join(input.outputDir, 'shot.png'); await fs.writeFile(file, bytes);
    await input.onObservation({ receipt: evidence('artifact', { textSha256: '', screenshotSha256: sha(bytes), artifact: { path: file, mimeType: 'image/png', sha256: sha(bytes), size: bytes.length } }), summary: '看到猫咪截图' });
    return { status: 'completed', summary: '有实际截图回执。', receipts: [] };
  } });
  const id = await start(f); await settle(f.jobs, id, 'completed'); await flush(f.jobs);
  const stored = JSON.parse(await fs.readFile(f.file(id))); assert.equal(stored.receipts[0].artifact.path, 'artifacts/shot.png'); assert.equal(stored.receipts[0].artifact.size, 18);
});

test('outside artifact or mismatched artifact hashes never count as screenshot proof', async t => {
  const f = await fixture(t, { runJob: async input => {
    const file = path.join(f.root, 'outside.png'), bytes = Buffer.from('outside'); await fs.writeFile(file, bytes);
    await input.onObservation({ receipt: evidence('outside', { textSha256: '', screenshotSha256: sha(bytes), artifact: { path: file, mimeType: 'image/png', sha256: sha(bytes), size: bytes.length } }) });
    return { status: 'completed', summary: '不应完成', receipts: [] };
  } });
  const id = await start(f); await settle(f.jobs, id, 'unavailable'); assert.equal(f.jobs.snapshot()[0].receiptCount, 0);
});

test('persistence failures prevent browser execution, absolute storage and strict record validation fail closed', async t => {
  const f = await fixture(t, { save: async () => { throw new Error('disk unavailable'); } });
  assert.match((await f.jobs.handle(event(), '/browse 去抖音看看视频')).reply, /没有安全保存/); assert.equal(f.calls.length, 0);
  await assert.rejects(OwnerBrowserJobs.open({ ...f.args, root: 'relative/temporary' }), /options_invalid/);
  const other = await fixture(t); const id = await start(other, 'message-1', '去抖音看看视频', { deferStart: true }); await other.jobs.stop();
  const record = JSON.parse(await fs.readFile(other.file(id))); record.password = 'unexpected'; await fs.writeFile(other.file(id), JSON.stringify(record));
  await assert.rejects(other.open(), /record_invalid/);
});

test('cancel invalidation does not wait behind a stalled disk write', async t => {
  const diskGate = gate(), workerGate = gate(); let input, stall = false;
  const f = await fixture(t, { runJob: async value => { input = value; return workerGate.promise; }, save: async (file, bytes) => { if (stall) await diskGate.promise; await durableWriteFile(file, bytes); } });
  const id = await start(f); await waitFor(() => input); stall = true;
  const observation = input.onObservation({ receipt: evidence(), summary: '观察' }); await pause();
  const cancellation = f.jobs.handle(event('cancel'), '/browsecancel ' + id);
  await waitFor(() => input.signal.aborted); assert.equal(await input.isCurrent(), false);
  diskGate.resolve(); await observation; await cancellation; workerGate.resolve(completed()); await pause(); assert.equal(f.sent.length, 0);
});

test('unactivated acknowledgements expire without starting the browser', async t => {
  const f = await fixture(t, { queueTtlMs: 100 }); const id = await start(f, 'message-1', '去抖音看看视频', { deferStart: true });
  f.advance(101); await f.jobs.ownerChanged(); assert.equal(f.jobs.snapshot()[0].status, 'expired'); assert.equal(await f.jobs.activate(id), false); assert.equal(f.calls.length, 0);
});

test('no-proof worker prose does not pretend to be a factual browsing result', async t => {
  const f = await fixture(t, { runJob: async () => ({ status: 'unavailable', summary: '我已经浏览了你的所有私人视频', receipts: [] }) });
  const id = await start(f); await settle(f.jobs, id, 'unavailable'); assert.doesNotMatch((await f.jobs.handle(event('status'), '/browsestatus')).reply, /所有私人视频/);
});

test('sanitized worker shutdown evidence survives restart without paths, identities or raw errors', async t => {
  const cleanup = { appServer: { status: 'forced', stdinEnded: true, exitObserved: true, closeObserved: true, exitCode: 0, signal: 'SIGTERM', forceAttempted: true,
    errors: ['stdin_eof_failed', 'password=do-not-save', 'D:\\private\\account'], pid: 1234 }, browser: { status: 'closed', ownerId: OWNER },
    tempDirectory: { status: 'retained', path: 'D:\\private\\worker', reason: 'temp_cleanup_failed' } };
  const f = await fixture(t, { runJob: async () => completed({ cleanup }) }); const id = await start(f); await waitFor(() => f.jobs.snapshot()[0]?.notification === 'sent');
  const expected = { appServer: { status: 'forced', stdinEnded: true, exitObserved: true, closeObserved: true, forceAttempted: true, exitCode: 0, signal: 'SIGTERM', errors: ['stdin_eof_failed'] }, browser: { status: 'closed' }, tempDirectory: { status: 'retained', reason: 'temp_cleanup_failed' } };
  assert.deepEqual(f.jobs.snapshot()[0].cleanup, expected); await f.jobs.stop(); const reopened = await f.open();
  assert.deepEqual(reopened.snapshot()[0].cleanup, expected); assert.doesNotMatch(await fs.readFile(f.file(id), 'utf8'), /do-not-save|private|owner-browser-fixture|"pid"|"path"/);
});

test('failed or canceled workers retain safe cleanup evidence without changing terminal state or retrying', async t => {
  for (const canceled of [false, true]) {
    const blocked = gate(); let input;
    const cleanup = { appServer: { status: 'unconfirmed', exitObserved: false, closeObserved: false, errors: ['process_exit_unconfirmed'] }, browser: { status: 'cancellation_pending' }, tempDirectory: { status: 'retained', path: 'D:\\hidden', reason: 'process_cleanup_unconfirmed' } };
    const f = await fixture(t, { runJob: async value => { input = value; await blocked.promise; throw Object.assign(new Error('raw provider error must not persist'), { cleanup }); } });
    const id = await start(f); await waitFor(() => input);
    if (canceled) await f.jobs.cancel(id); blocked.resolve();
    await waitFor(() => f.jobs.snapshot()[0]?.cleanup); await settle(f.jobs, id, canceled ? 'canceled' : 'failed'); await f.jobs.stop();
    const reopened = await f.open(); assert.equal(reopened.snapshot()[0].status, canceled ? 'canceled' : 'failed'); assert.equal(reopened.snapshot()[0].cleanup.appServer.status, 'unconfirmed');
    assert.equal(f.sent.length, canceled ? 0 : f.sent.length); assert.doesNotMatch(await fs.readFile(f.file(id), 'utf8'), /raw provider|hidden/);
  }
});
