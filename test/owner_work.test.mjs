import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnerWorkQueue } from '../src/owner_work.mjs';

const TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const OWNER = 'owner-fixture';
const proposal = (files = [{ path: 'notes/result.md', content: '# Result\nActual proposal content.\n' }]) => ({ question: '', summary: '准备一个说明文件。', files });
const event = (id = 'message-1', owner = OWNER) => ({ id, chat_type: 'private', author: { user_openid: owner } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  await fs.mkdir(TEMP, { recursive: true }); const root = await fs.mkdtemp(path.join(TEMP, 'owner_work_test_'));
  assert.ok(root.startsWith(TEMP + path.sep));
  let owner = OWNER, time = Date.parse('2026-10-22T12:00:00Z'); const calls = [], queues = [];
  const args = { root, getOwner: () => owner, now: () => time, generateProposal: async input => { calls.push(input); return proposal(); }, ...options };
  const queue = await OwnerWorkQueue.open(args); queues.push(queue);
  t.after(async () => { await Promise.all(queues.map(q => q.stop())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, queue, calls, args, owner: value => { owner = value; }, advance: ms => { time += ms; },
    open: async () => { const q = await OwnerWorkQueue.open(args); queues.push(q); return q; },
    jobPath: (id, file = '') => path.join(root, 'data', 'owner_work', 'jobs', id, file) };
}
async function settle(queue, id, status) {
  for (let i = 0; i < 300; i++) { const result = queue.snapshot().find(job => job.id === id); if (result?.status === status) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Expected ${status}: ${JSON.stringify(queue.snapshot())}`);
}
async function start(f, id = 'message-1', task = '制作一份说明文件') {
  const result = await f.queue.handle(event(id), '/work ' + task);
  const jobId = result.reply.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/)?.[0];
  assert.ok(jobId, result.reply); return jobId;
}

test('unbound/wrong owners, group and bot events cannot create jobs; this API never binds an owner', async t => {
  const f = await fixture(t);
  for (const e of [event('wrong', 'not-owner'), { ...event('group'), group_openid: 'group-fixture' },
    { ...event('malformed'), chat_type: 'group' }, { ...event('bot'), author: { user_openid: OWNER, bot: true } }]) {
    assert.match((await f.queue.handle(e, '/work create')).reply, /只接受/);
  }
  f.owner(''); assert.match((await f.queue.handle(event(), '/work create')).reply, /只接受/);
  assert.equal(f.queue.snapshot().length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.queue.handle(event(), 'ordinary text')).handled, false);
});

test('proposal is inspectable but workspace changes only after one explicit owner approval', async t => {
  const f = await fixture(t); const id = await start(f);
  await settle(f.queue, id, 'awaiting_approval');
  assert.deepEqual(await fs.readdir(f.jobPath(id, 'workspace')), []);
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['answer', 'files', 'signal', 'task']); assert.deepEqual(f.calls[0].files, []);
  const status = await f.queue.handle(event('status'), '/workstatus ' + id);
  assert.match(status.reply, /notes\/result.md/); assert.match(status.reply, /Actual proposal content/);
  assert.ok(status.reply.includes('/approve ' + id)); assert.ok(status.reply.includes('/' + id + '/proposal.json'));
  assert.match((await f.queue.handle(event('approve'), '/approve ' + id)).reply, /已应用/);
  assert.equal(await fs.readFile(f.jobPath(id, 'workspace/notes/result.md'), 'utf8'), proposal().files[0].content);
  await fs.writeFile(f.jobPath(id, 'workspace/notes/result.md'), 'Local subsequent edit.');
  assert.match((await f.queue.handle(event('reuse'), '/approve ' + id)).reply, /不能重复/);
  assert.equal(await fs.readFile(f.jobPath(id, 'workspace/notes/result.md'), 'utf8'), 'Local subsequent edit.');
  assert.deepEqual((await fs.readdir(f.jobPath(id))).sort(), ['job.json', 'proposal.json', 'workspace']);
  assert.doesNotMatch(JSON.stringify(f.queue.snapshot()), /owner-fixture|制作一份说明文件|Actual proposal/);
});

test('the same QQ event remains deduplicated after restart and old proposals remain actionable', async t => {
  const f = await fixture(t); const id = await start(f); await settle(f.queue, id, 'awaiting_approval'); await f.queue.stop();
  const reopened = await f.open();
  assert.match((await reopened.handle(event(), '/work a different wording')).reply, new RegExp(id));
  assert.equal(reopened.snapshot().length, 1); assert.equal(f.calls.length, 1);
  assert.match((await reopened.handle(event('approve'), '/approve ' + id)).reply, /已应用/);
  const metadata = await fs.readFile(f.jobPath(id, 'job.json'), 'utf8');
  assert.doesNotMatch(metadata, /message-1|owner-fixture/);
});

test('awaiting questions recover and /answer continues without applying or accepting stale answers', async t => {
  let count = 0; const seen = [];
  const f = await fixture(t, { generateProposal: async input => { seen.push(input); return ++count === 1 ? { question: '需要哪种格式？', summary: '等待格式。', files: [] } : proposal(); } });
  const id = await start(f); await settle(f.queue, id, 'awaiting_answer'); await f.queue.stop(); const reopened = await f.open();
  assert.match((await reopened.handle(event('status'), '/workstatus ' + id)).reply, /需要哪种格式/);
  assert.match((await reopened.handle(event('answer'), '/answer ' + id + ' Markdown 格式')).reply, /不代表批准/);
  await settle(reopened, id, 'awaiting_approval'); assert.match(seen[1].answer, /Markdown 格式/);
  assert.deepEqual(await fs.readdir(f.jobPath(id, 'workspace')), []);
  assert.match((await reopened.handle(event('answer-again'), '/answer ' + id + ' again')).reply, /没有等待/);
});

test('proposal or baseline tampering invalidates approval without touching workspace', async t => {
  for (const change of ['proposal', 'baseline', 'metadata']) {
    const f = await fixture(t); const id = await start(f); await settle(f.queue, id, 'awaiting_approval');
    // Snapshot is intentionally cheap; the command queue is the persistence barrier.
    await f.queue.handle(event('persisted-status'), '/workstatus ' + id);
    if (change === 'proposal') { const file = f.jobPath(id, 'proposal.json'); const data = JSON.parse(await fs.readFile(file)); data.files[0].content = 'replaced'; await fs.writeFile(file, JSON.stringify(data)); }
    if (change === 'baseline') await fs.writeFile(f.jobPath(id, 'workspace/local.txt'), 'unapproved local change');
    if (change === 'metadata') { const file = f.jobPath(id, 'job.json'); const data = JSON.parse(await fs.readFile(file)); data.summary = 'replaced metadata'; await fs.writeFile(file, JSON.stringify(data)); }
    assert.match((await f.queue.handle(event('approve'), '/approve ' + id)).reply, /失效/);
    assert.equal(f.queue.snapshot()[0].status, 'failed');
    await assert.rejects(fs.access(f.jobPath(id, 'workspace/notes/result.md')), { code: 'ENOENT' });
  }
});

test('fixed expiry cannot be extended with status, and a replacement owner cannot inspect or approve old jobs', async t => {
  const f = await fixture(t, { ttlMs: 1000 }); const id = await start(f); await settle(f.queue, id, 'awaiting_approval');
  f.owner('replacement-owner');
  assert.match((await f.queue.handle(event('new-owner', 'replacement-owner'), '/workstatus ' + id)).reply, /没有找到/);
  f.owner(OWNER); f.advance(999); await f.queue.handle(event('status'), '/workstatus ' + id); f.advance(1);
  assert.match((await f.queue.handle(event('late'), '/approve ' + id)).reply, /expired/);
  assert.equal(f.queue.snapshot()[0].status, 'expired');
  assert.deepEqual(await fs.readdir(f.jobPath(id, 'workspace')), []);
});

test('cancel and reject invalidate running work and reject late model results', async t => {
  for (const command of ['cancel', 'reject']) {
    const gate = deferred(); let signal;
    const f = await fixture(t, { generateProposal: async input => { signal = input.signal; return gate.promise; } });
    const id = await start(f); await settle(f.queue, id, 'running');
    while (!signal) await new Promise(resolve => setTimeout(resolve, 1));
    await f.queue.handle(event('cancel'), `/${command} ${id}`); assert.equal(signal.aborted, true);
    gate.resolve(proposal()); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.queue.snapshot()[0].status, command === 'cancel' ? 'canceled' : 'rejected');
    assert.deepEqual(await fs.readdir(f.jobPath(id, 'workspace')), []);
    await assert.rejects(fs.access(f.jobPath(id, 'proposal.json')), { code: 'ENOENT' });
  }
});

test('timeout propagates abort and recovery never reruns interrupted generation', async t => {
  let signal; const f = await fixture(t, { modelTimeoutMs: 15, generateProposal: async input => { signal = input.signal; return new Promise(() => {}); } });
  const id = await start(f); await settle(f.queue, id, 'failed'); assert.equal(signal.aborted, true); await f.queue.stop();
  const file = f.jobPath(id, 'job.json'), data = JSON.parse(await fs.readFile(file)); data.status = 'running'; await fs.writeFile(file, JSON.stringify(data));
  const reopened = await f.open(); assert.equal(reopened.snapshot()[0].status, 'failed');
  assert.match((await reopened.handle(event('status'), '/workstatus ' + id)).reply, /没有自动重复/);
});

test('absolute, traversal, Windows special, credential and binary proposals never become approvable', async t => {
  const invalidFiles = ['../escape.txt', '/absolute.txt', 'D:/escape.txt', '\\\\server\\share\\escape.txt',
    'safe\\escape.txt', 'safe/../escape.txt', '.env', 'auth.json', 'credentials.json', 'config.local.json',
    'CON.txt', 'safe/file.txt:stream', 'bad./file.txt', 'binary.exe'];
  for (const relative of invalidFiles) {
    const f = await fixture(t, { generateProposal: async () => proposal([{ path: relative, content: 'safe text' }]) });
    const id = await start(f); await settle(f.queue, id, 'failed');
    assert.deepEqual(await fs.readdir(f.jobPath(id, 'workspace')), [], relative);
  }
  for (const content of ['binary\u0000content', 'password="abc"', '-----BEGIN '+'PRIVATE KEY-----', 'sk-proj-abcdefghijklmnopqrstuv']) {
    const f = await fixture(t, { generateProposal: async () => proposal([{ path: 'result.txt', content }]) });
    const id = await start(f); await settle(f.queue, id, 'failed');
  }
});

test('workspace junctions and hardlinked files cannot redirect model reads or approvals', async t => {
  const f = await fixture(t); const id = await start(f); await settle(f.queue, id, 'awaiting_approval');
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'original.txt'), 'untouched');
  await fs.symlink(outside, f.jobPath(id, 'workspace/redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await f.queue.handle(event('approve'), '/approve ' + id)).reply, /失效/);
  assert.equal(await fs.readFile(path.join(outside, 'original.txt'), 'utf8'), 'untouched');
  const f2 = await fixture(t); const id2 = await start(f2); await settle(f2.queue, id2, 'awaiting_approval');
  const target = path.join(f2.root, 'linked_source.txt'); await fs.writeFile(target, 'untouched');
  await fs.link(target, f2.jobPath(id2, 'workspace/link.txt'));
  assert.match((await f2.queue.handle(event('approve'), '/approve ' + id2)).reply, /失效/);
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
});

test('concurrent duplicate work and approval commands are serialized', async t => {
  const f = await fixture(t);
  const replies = await Promise.all(Array.from({ length: 5 }, () => f.queue.handle(event(), '/work 制作说明')));
  const id = f.queue.snapshot()[0].id; assert.equal(f.queue.snapshot().length, 1); assert.ok(replies.every(reply => reply.reply.includes(id)));
  await settle(f.queue, id, 'awaiting_approval');
  const approved = await Promise.all(Array.from({ length: 3 }, (_, i) => f.queue.handle(event('approve-' + i), '/approve ' + id)));
  assert.equal(approved.filter(reply => /已应用，审批已使用/.test(reply.reply)).length, 1);
  assert.equal(f.calls.length, 1);
});

test('maximum escaped text remains inspectable and approvable after serialization', async t => {
  const files = Array.from({ length: 4 }, (_, index) => ({ path: `part_${index}.txt`, content: '\n'.repeat(65536) }));
  const f = await fixture(t, { generateProposal: async () => proposal(files) }); const id = await start(f);
  await settle(f.queue, id, 'awaiting_approval');
  assert.match((await f.queue.handle(event('status'), '/workstatus ' + id)).reply, /part_3.txt/);
  assert.match((await f.queue.handle(event('approve'), '/approve ' + id)).reply, /已应用/);
});

test('maximum multi-file review keeps every target, hash and approval command within the QQ reply budget', async t => {
  const files = Array.from({ length: 12 }, (_, index) => ({
    path: `${'a'.repeat(60)}/${'b'.repeat(60)}/${index}_${'c'.repeat(56)}.md`, content: '测试内容'.repeat(200)
  }));
  const f = await fixture(t, { generateProposal: async () => ({ question: '', summary: '摘要'.repeat(1000), files }) });
  const id = await start(f); await settle(f.queue, id, 'awaiting_approval');
  const { reply } = await f.queue.handle(event('status'), '/workstatus ' + id);
  assert.ok([...reply].length <= 6500, String([...reply].length));
  assert.ok(files.every(file => reply.includes(file.path))); assert.equal((reply.match(/SHA-256/g) || []).length, 12);
  assert.ok(reply.includes('/approve ' + id)); assert.ok(reply.includes('/' + id + '/proposal.json'));
});

test('a replayed answer cannot answer a later question, including after restart', async t => {
  let calls = 0;
  const f = await fixture(t, { generateProposal: async () => ({ question: `补充问题 ${++calls}`, summary: '等待补充。', files: [] }) });
  const id = await start(f); await settle(f.queue, id, 'awaiting_answer');
  await f.queue.handle(event('answer-one'), '/answer ' + id + ' first answer');
  await settle(f.queue, id, 'awaiting_answer'); await f.queue.handle(event('status'), '/workstatus ' + id); await f.queue.stop();
  const reopened = await f.open();
  assert.match((await reopened.handle(event('answer-one'), '/answer ' + id + ' first answer')).reply, /已经处理过/);
  assert.equal(calls, 2); assert.equal(reopened.snapshot()[0].status, 'awaiting_answer');
});
