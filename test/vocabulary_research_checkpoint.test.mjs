import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { VocabularyLearning } from '../src/vocabulary_learning.mjs';
import { VocabularyResearch } from '../src/vocabulary_research.mjs';

const DAY = 24 * 60 * 60_000;
const event = (id, content = '猫饼是什么意思？', group = 'checkpoint-room') => ({ id, content, group_openid: group, author: { member_openid: 'alice' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(t) {
  const root = resolve(process.cwd(), 'temp'); await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(join(root, 'vocabulary_checkpoint_'));
  let now = Date.parse('2026-10-24T00:00:00Z'); const opened = [], workers = [];
  const open = async () => { const value = await new VocabularyLearning({ dataDir, now: () => now }).init(); opened.push(value); return value; };
  const learning = await open();
  const worker = (store = learning, generate = async () => ({ actions: [] }), options = {}) => {
    const research = new VocabularyResearch({ learning: store, now: () => now, generate, ...options }); workers.push(research); return research;
  };
  t.after(async () => {
    workers.forEach(item => item.stop()); await Promise.all(opened.map(item => item.queue.catch(() => {})));
    assert.ok(resolve(dataDir).startsWith(root + sep)); await rm(dataDir, { recursive: true, force: true }); await assert.rejects(access(dataDir), { code: 'ENOENT' });
  });
  return { learning, open, worker, dataDir, advance: ms => { now += ms; }, now: () => now };
}

test('successful empty research is checkpointed per revision, keeps pending meaning and survives restart', async t => {
  const f = await fixture(t); await f.learning.observe(event('term'));
  let calls = 0; const logs = [], run = async () => { calls++; return { actions: [] }; };
  const worker = f.worker(f.learning, run, { log: text => logs.push(text) });
  worker.observe(event('term')); f.advance(31000); assert.equal(await worker.tick(), true); assert.equal(calls, 1);
  const visible = f.learning.context('checkpoint-room')[0];
  assert.equal(visible.status, 'pending'); assert.equal(visible.meaning, ''); assert.equal(visible.research_checkpoint, undefined);
  assert.doesNotMatch(logs.at(-1), /已保存/);
  f.advance(600001); worker.observe(event('unrelated', '大家晚上好')); f.advance(31000);
  assert.equal(await worker.tick(), false); assert.equal(calls, 1);
  const restarted = await f.open(), newWorker = f.worker(restarted, run);
  newWorker.observe(event('after-restart', '接着聊天')); f.advance(31000);
  assert.equal(await newWorker.tick(), false); assert.equal(calls, 1);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'vocabulary_state.json'), 'utf8'));
  const entry = Object.values(saved.rooms)[0].entries[0];
  assert.equal(entry.research_checkpoint.revision, entry.revision);
  assert.ok(Number.isSafeInteger(entry.research_checkpoint.completedAt));
});

test('a fresh observation revision and expiry independently permit research again', async t => {
  const f = await fixture(t); await f.learning.observe(event('first'));
  let calls = 0; const worker = f.worker(f.learning, async () => { calls++; return { actions: [] }; });
  worker.observe(event('first')); f.advance(31000); await worker.tick();
  await f.learning.observe(event('fresh-evidence', '“猫饼”又出现了'));
  worker.observe(event('fresh-evidence')); f.advance(31000); assert.equal(await worker.tick(), true);
  assert.equal(calls, 2, 'new evidence must not inherit the older revision cooldown');
  f.advance(DAY - 31001); worker.observe(event('before-expiry', '今天聊什么')); f.advance(31000);
  assert.equal(await worker.tick(), false); assert.equal(calls, 2);
  f.advance(1); worker.observe(event('expired', '继续吧')); f.advance(31000);
  assert.equal(await worker.tick(), true); assert.equal(calls, 3);
});

test('mixed research checkpoints only unchanged candidates with no adopted result', async t => {
  const f = await fixture(t); await f.learning.observe(event('two', '“猫饼”和“龙团”来了'));
  const ticket = f.learning.prepareResearch('checkpoint-room'), [first] = ticket.context.candidates;
  const result = await f.learning.applyModelActions({ group_openid: 'checkpoint-room' }, [{ operation: 'research', candidate_id: first.id,
    meaning: '一种猫的姿态', sources: [{ url: 'https://example.org/cat', title: '公开说明' }] }], { researchToken: ticket.token, researchCompleted: true });
  assert.equal(result.applied, 1); assert.equal(result.checkpointed, 1);
  assert.equal(f.learning.prepareResearch('checkpoint-room'), null);
  assert.ok(f.learning.context('checkpoint-room').every(entry => entry.status === 'pending'));
});

test('an unchanged failed batch keeps its retry cooldown without blocking another ready group', async t => {
  const f = await fixture(t); await f.learning.observe(event('first'));
  await f.learning.observe(event('other', '龙团是什么意思？', 'other-room'));
  let calls = 0; const worker = f.worker(f.learning, async () => {
    if (++calls === 1) throw Error('synthetic_model_failure'); return { actions: [] };
  });
  worker.observe(event('first')); f.advance(31000); assert.equal(await worker.tick(), false);
  worker.observe(event('retry', '继续吧')); worker.observe(event('other', '继续吧', 'other-room')); f.advance(31000);
  assert.equal(await worker.tick(), true); assert.equal(calls, 2);
  assert.equal(f.learning.prepareResearch('other-room'), null);
  assert.ok(f.learning.prepareResearch('checkpoint-room'));
  assert.equal(await worker.tick(), false); assert.equal(calls, 2);
  f.advance(600001); assert.equal(await worker.tick(), true); assert.equal(calls, 3);
});

for (const outcome of ['failed', 'malformed', 'aborted']) test(`${outcome} extraction cannot record a completed checkpoint`, async t => {
  const f = await fixture(t); await f.learning.observe(event('first'));
  const pending = deferred(); let calls = 0;
  const worker = f.worker(f.learning, async () => { calls++; if (calls > 1) return { actions: [] };
    if (outcome === 'failed') throw Error('synthetic_model_failure');
    if (outcome === 'malformed') return {};
    return pending.promise;
  });
  worker.observe(event('first')); f.advance(31000); const job = worker.tick();
  if (outcome === 'aborted') { worker.stop(); pending.resolve({ actions: [] }); }
  assert.equal(await job, false); assert.ok(f.learning.prepareResearch('checkpoint-room'));
  const saved = JSON.parse(await readFile(join(f.dataDir, 'vocabulary_state.json'), 'utf8'));
  assert.equal(Object.values(saved.rooms)[0].entries[0].research_checkpoint, undefined);
});

test('invalid, foreign and expired tickets cannot suppress a valid pending candidate', async t => {
  const f = await fixture(t); await f.learning.observe(event('a')); await f.learning.observe(event('b', '猫饼是什么意思？', 'other-room'));
  const ticket = f.learning.prepareResearch('checkpoint-room');
  for (const [group, token] of [['checkpoint-room', 'forged'], ['other-room', ticket.token]]) {
    const result = await f.learning.applyModelActions({ group_openid: group }, [], { researchToken: token, researchCompleted: true });
    assert.equal(result.checkpointed, 0); assert.ok(f.learning.prepareResearch(group));
  }
  f.advance(30 * 60_000 + 1);
  const result = await f.learning.applyModelActions({ group_openid: 'checkpoint-room' }, [], { researchToken: ticket.token, researchCompleted: true });
  assert.equal(result.checkpointed, 0); assert.ok(f.learning.prepareResearch('checkpoint-room'));
});

for (const change of ['forget', 'review']) test(`${change} during generation cannot checkpoint a recreated same-name candidate`, async t => {
  const f = await fixture(t); await f.learning.observe(event('first'));
  const response = deferred(), worker = f.worker(f.learning, () => response.promise);
  worker.observe(event('first')); f.advance(31000); const job = worker.tick();
  if (change === 'forget') await f.learning.forget('checkpoint-room');
  else { const { scope, candidates } = f.learning.snapshot()[0]; await f.learning.review(scope, candidates[0].id, { operation: 'delete' }); }
  await f.learning.observe(event('recreated'));
  response.resolve({ actions: [] }); assert.equal(await job, false);
  assert.ok((await f.open()).prepareResearch('checkpoint-room'));
});

test('checkpoint publication and ticket consumption require durable success', async t => {
  const f = await fixture(t); await f.learning.observe(event('first'));
  const ticket = f.learning.prepareResearch('checkpoint-room'), original = await readFile(join(f.dataDir, 'vocabulary_state.json'), 'utf8');
  const started = deferred(), release = deferred(), save = f.learning.save;
  f.learning.save = async () => { started.resolve(); await release.promise; throw Error('synthetic_write_failure'); };
  const work = f.learning.applyModelActions({ group_openid: 'checkpoint-room' }, [], { researchToken: ticket.token, researchCompleted: true });
  await started.promise;
  assert.ok(f.learning.prepareResearch('checkpoint-room'), 'a not-yet-persisted checkpoint is not visible');
  release.resolve(); await assert.rejects(work, /synthetic_write_failure/);
  assert.equal(await readFile(join(f.dataDir, 'vocabulary_state.json'), 'utf8'), original);
  f.learning.save = save;
  const retry = await f.learning.applyModelActions({ group_openid: 'checkpoint-room' }, [], { researchToken: ticket.token, researchCompleted: true });
  assert.equal(retry.checkpointed, 1, 'the failed save did not consume the valid ticket');
});

test('an aborted scheduler result waiting for an earlier write is rechecked inside the commit queue', async t => {
  const f = await fixture(t); await f.learning.observe(event('first'));
  const save = f.learning.save, started = deferred(), release = deferred(); let block = true;
  f.learning.save = async (...args) => { if (block) { block = false; started.resolve(); await release.promise; } return save(...args); };
  const earlier = f.learning.observe(event('unrelated', '今天好呀')); await started.promise;
  const worker = f.worker(); worker.observe(event('first')); f.advance(31000); const result = worker.tick();
  await Promise.resolve(); worker.stop(); release.resolve(); await earlier;
  assert.equal(await result, false); assert.ok(f.learning.prepareResearch('checkpoint-room'));
});
