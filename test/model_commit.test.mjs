import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners, once } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { generator } from '../src/model_client.mjs';

const base = path.resolve('temp');
const usage = { input_tokens: 8, cached_input_tokens: 3, output_tokens: 2 };
const final = text => ({ type: 'item.completed', item: { type: 'agent_message', text } });
const committed = () => ({ type: 'turn.completed', usage });
const answer = JSON.stringify({ reply: 'OK', memories: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'model_commit_'));
  await mkdir(path.join(root, 'data')); await mkdir(path.join(root, 'temp'));
  await writeFile(path.join(root, 'character_card.json'), JSON.stringify({ name: 'fixture', full_name: 'fixture', core: [], voice: [] }));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)), await realpath(base));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function controlledSpawn() {
  const stats = { kills: 0, clears: 0, calls: 0 };
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const deps = {
    spawnProcess() {
      stats.calls++;
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) { done(); ready(child); } });
      child.kill = () => { stats.kills++; }; child.unref = () => {};
      return child;
    },
    setTimer(callback) { stats.timeout = callback; return 71; },
    clearTimer(handle) { assert.equal(handle, 71); stats.clears++; }
  };
  return { stats, deps, started };
}
const emit = (child, ...events) => child.stdout.write(events.map(event => JSON.stringify(event)).join('\n') + '\n');
const readUsage = async root => JSON.parse(await readFile(path.join(root, 'data/model_usage.json'), 'utf8'));

// The child deliberately never closes: a valid protocol commit must finish it.
test('a committed final answer returns without process close and ignores late close, error, timeout and abort', async t => {
  const root = await fixture(t), fake = controlledSpawn(), controller = new AbortController();
  const pending = generator(root, { codexPath: process.execPath }, fake.deps)({ text: 'check', structured: true, signal: controller.signal });
  const child = await fake.started;
  emit(child, final(answer), committed());
  assert.deepEqual(await pending, { reply: 'OK', memories: [] });
  assert.equal(fake.stats.kills, 1); assert.equal(fake.stats.clears, 1);
  assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  child.emit('close', 1); child.emit('error', Object.assign(new Error('synthetic'), { code: 'ECONNRESET' }));
  child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { code: 'network_error' } }) + '\n');
  fake.stats.timeout(); controller.abort(); await tick();
  const state = await readUsage(root);
  assert.equal(state.recent.length, 1); assert.deepEqual(state.recent[0].usage, usage);
  assert.deepEqual(state.recent[0].outcome, { status: 'success', code: null, exit_code: null });
  assert.equal(fake.stats.kills, 1); assert.equal(fake.stats.clears, 1);
});

test('partial output and a completed agent item alone never resolve before a complete turn', async t => {
  const root = await fixture(t), fake = controlledSpawn();
  let settled = false;
  const pending = generator(root, { codexPath: process.execPath }, fake.deps)({ text: 'check', structured: true });
  pending.then(() => { settled = true; }, () => { settled = true; });
  const child = await fake.started;
  emit(child, { type: 'item.delta', item: { type: 'agent_message', text: '{"reply":' } }, committed());
  await tick(); assert.equal(settled, false); assert.equal(fake.stats.kills, 0);
  emit(child, final(answer));
  await tick(); assert.equal(settled, false); assert.equal(fake.stats.kills, 0);
  emit(child, committed());
  assert.equal((await pending).reply, 'OK'); assert.equal(fake.stats.kills, 1);
});

test('older CLI compatibility still accepts zero exit with one complete answer and no turn event', async t => {
  const root = await fixture(t), fake = controlledSpawn();
  const pending = generator(root, { codexPath: process.execPath }, fake.deps)({ text: 'check', structured: true });
  const child = await fake.started;
  emit(child, final(answer)); child.emit('close', 0);
  assert.equal((await pending).reply, 'OK');
  const state = await readUsage(root);
  assert.equal(state.recent.length, 1); assert.equal(state.recent[0].usage, null);
  assert.deepEqual(state.recent[0].outcome, { status: 'success', code: null, exit_code: 0 });
});

test('cancellation after a complete agent item but before the turn commit cannot return late output', async t => {
  const root = await fixture(t), fake = controlledSpawn(), controller = new AbortController();
  const pending = generator(root, { codexPath: process.execPath }, fake.deps)({ text: 'check', structured: true, signal: controller.signal });
  const rejected = assert.rejects(pending, /codex_aborted/);
  const child = await fake.started;
  emit(child, final(answer)); controller.abort();
  child.stdout.emit('data', JSON.stringify(committed()) + '\n'); child.emit('close', 0);
  await rejected;
  const state = await readUsage(root);
  assert.equal(state.recent.length, 1); assert.equal(state.recent[0].usage, null);
  assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'cancelled', exit_code: null });
  assert.equal(fake.stats.kills, 1);
});

test('a completed turn with invalid structured output rejects once without waiting for close', async t => {
  for (const text of ['not JSON', JSON.stringify({ reply: 19, memories: [] })]) await t.test(text === 'not JSON' ? 'invalid JSON' : 'invalid shape', async t => {
    const root = await fixture(t), fake = controlledSpawn();
    const pending = generator(root, { codexPath: process.execPath }, fake.deps)({ text: 'check', structured: true });
    const rejected = assert.rejects(pending, /codex_invalid_chat_response/);
    const child = await fake.started;
    emit(child, final(text), committed()); await rejected;
    child.emit('close', 0); await tick();
    const state = await readUsage(root);
    assert.equal(state.recent.length, 1); assert.deepEqual(state.recent[0].usage, usage);
    assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'invalid_output', exit_code: null });
    assert.equal(fake.stats.kills, 1);
  });
});

test('a prior failed turn cannot be turned into success by later answer and completion events', async t => {
  const root = await fixture(t), fake = controlledSpawn();
  const pending = generator(root, { codexPath: process.execPath }, fake.deps)({ text: 'check' });
  const rejected = assert.rejects(pending, /codex_failed_exit_1/);
  const child = await fake.started;
  emit(child, { type: 'turn.failed', error: { code: 'rate_limit_exceeded' } }, final('OK'), committed());
  assert.equal(fake.stats.kills, 0); child.emit('close', 1); await rejected;
  assert.deepEqual((await readUsage(root)).recent[0].outcome, { status: 'failure', code: 'rate_limit', exit_code: 1 });
});

test('malformed event packets and incomplete agent items do not count as final answers', async t => {
  const root = await fixture(t), fake = controlledSpawn();
  let settled = false;
  const pending = generator(root, { codexPath: process.execPath }, fake.deps)({ text: 'check', structured: true });
  pending.then(() => { settled = true; }, () => { settled = true; });
  const child = await fake.started;
  child.stdout.write('{bad JSON}\nnull\n');
  emit(child, { type: 'item.completed', item: { type: 'agent_message', text: 19 } }, committed());
  await tick(); assert.equal(settled, false); assert.equal(fake.stats.kills, 0);
  emit(child, final(answer), committed()); assert.equal((await pending).reply, 'OK');
});

test('a trailing completion parsed at a known nonzero exit cannot commit success', async t => {
  const root = await fixture(t), fake = controlledSpawn();
  const pending = generator(root, { codexPath: process.execPath }, fake.deps)({ text: 'check' });
  const rejected = assert.rejects(pending, /codex_failed_exit_1/);
  const child = await fake.started;
  emit(child, final('OK')); child.stdout.write(JSON.stringify(committed())); child.emit('close', 1);
  await rejected;
  const state = await readUsage(root);
  assert.equal(state.recent.length, 1); assert.equal(state.recent[0].outcome.status, 'failure');
  assert.equal(state.recent[0].outcome.exit_code, 1);
});

test('a real inert child that stays alive after turn completion is reaped promptly', { timeout: 10000 }, async t => {
  const root = await fixture(t);
  const script = `process.stdin.resume();process.stdin.on('end',()=>{console.log(${JSON.stringify(JSON.stringify(final(answer)))});console.log(${JSON.stringify(JSON.stringify(committed()))});setInterval(()=>{},1000);});`;
  let child, closed;
  t.after(() => child?.kill());
  const started = Date.now();
  const pending = generator(root, { codexPath: process.execPath }, { spawnProcess() {
    child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp') } });
    closed = once(child, 'close');
    return child;
  } })({ text: 'check', structured: true });
  assert.equal((await pending).reply, 'OK');
  assert.ok(Date.now() - started < 5000, 'must return without waiting for the child interval');
  // The production cleanup deliberately unrefs the child and destroys its pipes.
  // Keep this observer alive until close arrives, with a real failure deadline.
  let reapTimer;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      reapTimer = setTimeout(() => reject(new Error('child_reaping_timeout')), 5000);
    })]);
  } finally {
    clearTimeout(reapTimer);
  }
  assert.equal((await readUsage(root)).recent.length, 1);
});
