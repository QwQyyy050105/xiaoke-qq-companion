import {spawn as realSpawn} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { generator,codexTimeoutMs } from '../src/model_client.mjs';
import { classifyStructuredModelError, classifyModelFailure, modelCallOutcome } from '../src/model_failure.mjs';

const PRIVATE = 'private_fixture_message_member_token_path';
const base = path.resolve('temp');
const usage = { input_tokens: 90, cached_input_tokens: 30, output_tokens: 12 };
const answer = { reply: '收到。', memories: [] };

async function fixture(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'model_failure_'));
  await mkdir(path.join(root, 'data')); await mkdir(path.join(root, 'temp'));
  await writeFile(path.join(root, 'character_card.json'), JSON.stringify({ name: 'fixture', full_name: 'fixture', core: [], voice: [] }));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)), await realpath(base));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function scriptedSpawn(script) {
  const stats = { calls: 0, kills: 0, args: [] };
  const spawnProcess = (_executable, args) => {
    stats.calls++; stats.args = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) { done(); queueMicrotask(() => script(child)); } });
    child.kill = () => { stats.kills++; }; child.unref = () => {};
    return child;
  };
  return { stats, spawnProcess };
}

function emit(child, events, exitCode = 0, { trailingNewline = true } = {}) {
  child.stderr.write(PRIVATE + ' 401 rate_limit ECONNRESET\n');
  child.stdout.write(events.map(event => JSON.stringify(event)).join('\n') + (trailingNewline ? '\n' : ''));
  child.emit('close', exitCode);
}
const completed = (text = JSON.stringify(answer)) => [
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage }
];
const readUsage = async root => JSON.parse(await readFile(path.join(root, 'data', 'model_usage.json'), 'utf8'));

test('structured failure classification accepts only known machine fields and categories', () => {
  const cases = [
    [{ code: 'invalid_api_key', message: PRIVATE }, 'auth'],
    [{ status_code: 429, message: PRIVATE }, 'rate_limit'],
    [{ code: 'ECONNRESET', message: PRIVATE }, 'network'],
    [{ http_status: 503, message: PRIVATE }, 'server'],
    [{ type: 'response_validation_error', message: PRIVATE }, 'invalid_output'],
    [{ code: 'request_cancelled', message: PRIVATE }, 'cancelled'],
    [{ code: 'ETIMEDOUT', message: PRIVATE }, 'timeout'],
    [{ code: PRIVATE, message: '401 unauthorized rate_limit ECONNRESET' }, 'unknown'],
    [{ status: '429', message: PRIVATE }, 'unknown'],
    [{ message: 'rate_limit_exceeded' }, 'unknown']
  ];
  for (const [error, expected] of cases) assert.equal(classifyStructuredModelError({ type: 'turn.failed', error }), expected);
  assert.equal(classifyStructuredModelError({ type: 'error', code: 'network_error', message: PRIVATE }), 'network');
  assert.equal(classifyStructuredModelError({ type: 'turn.failed', error: { error: { type: 'authentication_error' } } }), 'auth');
  assert.equal(classifyStructuredModelError({ type: 'item.completed', error: { code: 'rate_limit_exceeded' } }), 'unknown');
  assert.equal(classifyStructuredModelError({ type: 'turn.failed', error: PRIVATE }), 'unknown');
});

test('local errors and outcome projections never retain arbitrary messages or custom metadata', () => {
  assert.equal(classifyModelFailure(new Error('codex_invalid_chat_response')), 'invalid_output');
  assert.equal(classifyModelFailure(new Error('codex_timeout'), 'server'), 'timeout');
  assert.equal(classifyModelFailure(new Error(PRIVATE), 'rate_limit'), 'rate_limit');
  assert.equal(classifyModelFailure(new Error('prefix codex_timeout ' + PRIVATE)), 'unknown');
  assert.equal(classifyModelFailure(new Error(PRIVATE), PRIVATE), 'unknown');
  assert.deepEqual(modelCallOutcome({ code: PRIVATE, exitCode: PRIVATE, message: PRIVATE }), { status: 'failure', code: 'unknown', exit_code: null });
  assert.deepEqual(modelCallOutcome({ success: true, code: 'auth', exitCode: 0 }), { status: 'success', code: null, exit_code: 0 });
  assert.equal(modelCallOutcome({ exitCode: NaN }).exit_code, null);
});

test('a parsed success writes exactly one outcome and preserves legacy usage fields and prior rows', async t => {
  const root = await fixture(t), old = { at: '2026-01-01T00:00:00.000Z', mode: 'reply', elapsed_ms: 8, usage: null };
  await writeFile(path.join(root, 'data', 'model_usage.json'), JSON.stringify({ recent: [old] }));
  const fake = scriptedSpawn(child => emit(child, completed(), 0, { trailingNewline: false }));
  const result = await generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE, structured: true });
  assert.equal(result.reply, answer.reply); assert.equal(fake.stats.calls, 1);
  const state = await readUsage(root); assert.equal(state.recent.length, 2); assert.deepEqual(state.recent[0], old);
  const row = state.recent[1]; assert.deepEqual(row.usage, usage);
  assert.deepEqual(row.outcome, { status: 'success', code: null, exit_code: 0 });
  assert.ok(Number.isFinite(row.elapsed_ms) && row.elapsed_ms >= 0); assert.ok(row.prompt_chars > 0);
  assert.equal(row.mode, 'reply'); assert.equal(row.image_count, 0); assert.equal(row.web_searches, 0);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(PRIVATE));
  assert.ok(fake.stats.args.includes('model_reasoning_effort="low"'));
  assert.ok(!fake.stats.args.some(value => /service_tier|fast/i.test(value)));
});

test('an explicit structured failure is recorded once without retry or stderr/body leakage', async t => {
  const root = await fixture(t);
  const fake = scriptedSpawn(child => emit(child, [{ type: 'turn.failed', error: { code: 'rate_limit_exceeded', message: PRIVATE, token: PRIVATE } }], 1));
  await assert.rejects(generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE, structured: true }), /codex_failed_exit_1/);
  const state = await readUsage(root); assert.equal(fake.stats.calls, 1); assert.equal(state.recent.length, 1);
  assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'rate_limit', exit_code: 1 });
  assert.equal(state.recent[0].usage, null); assert.doesNotMatch(JSON.stringify(state), new RegExp(PRIVATE));
});

test('message-only failures stay unknown even when prose or stderr mentions a recognizable category', async t => {
  const root = await fixture(t);
  const fake = scriptedSpawn(child => emit(child, [{ type: 'turn.failed', error: { message: '401 unauthorized ECONNRESET ' + PRIVATE } }], 1));
  await assert.rejects(generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE }), /codex_failed_exit_1/);
  const state = await readUsage(root);
  assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'unknown', exit_code: 1 });
  assert.doesNotMatch(JSON.stringify(state), /unauthorized|ECONNRESET|private_fixture/);
});

test('successful process exit with invalid JSON or response structure is failure despite available usage', async t => {
  const cases = [
    { text: PRIVATE, input: { structured: true }, error: 'codex_invalid_chat_response' },
    { text: JSON.stringify({ reply: 7, memories: [] }), input: { structured: true }, error: 'codex_invalid_chat_response' },
    { text: JSON.stringify({ reply: '', social: { action: 'invalid' } }), input: { structured: true, mode: 'proactive' }, error: 'codex_invalid_social_response' },
    { text: JSON.stringify({ personal: [], room: PRIVATE }), input: { structured: true, mode: 'memory_capture' }, error: 'codex_invalid_memory_capture' },
    { text: JSON.stringify({ reply: 'x', action: 'finish' }), input: { structured: true, mode: 'channel' }, error: 'codex_invalid_channel_response' },
    { text: JSON.stringify({ summary: 'x', files: [] }), input: { structured: true, mode: 'owner_work' }, error: 'codex_invalid_work_response' },
    { text: JSON.stringify({ actions: PRIVATE }), input: { structured: true, mode: 'vocabulary_research' }, error: 'codex_invalid_research_response' }
  ];
  for (const [index, item] of cases.entries()) await t.test('invalid response ' + index, async t => {
    const root = await fixture(t), fake = scriptedSpawn(child => emit(child, completed(item.text)));
    await assert.rejects(generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE, ...item.input }), new RegExp(item.error));
    const state = await readUsage(root); assert.equal(state.recent.length, 1); assert.equal(fake.stats.calls, 1);
    assert.deepEqual(state.recent[0].usage, usage);
    assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'invalid_output', exit_code: 0 });
    assert.doesNotMatch(JSON.stringify(state), new RegExp(PRIVATE));
  });
});

test('zero exit with no answer is invalid output, not a successful invocation', async t => {
  const root = await fixture(t), fake = scriptedSpawn(child => emit(child, [{ type: 'turn.completed', usage }]));
  await assert.rejects(generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE }), /codex_failed_exit_0/);
  assert.deepEqual((await readUsage(root)).recent[0].outcome, { status: 'failure', code: 'invalid_output', exit_code: 0 });
});

test('an error event followed by a valid completed turn records success rather than a stale error category', async t => {
  const root = await fixture(t), fake = scriptedSpawn(child => emit(child, [{ type: 'error', code: 'server_error', message: PRIVATE }, ...completed()]));
  await generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE, structured: true });
  const state = await readUsage(root); assert.equal(state.recent.length, 1);
  assert.deepEqual(state.recent[0].outcome, { status: 'success', code: null, exit_code: 0 });
});

test('a final unclassified failure does not borrow a different earlier transient error category', async t => {
  const root = await fixture(t), fake = scriptedSpawn(child => emit(child, [
    { type: 'error', code: 'network_error', message: PRIVATE },
    { type: 'turn.failed', error: { message: PRIVATE } }
  ], 1));
  await assert.rejects(generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE }), /codex_failed_exit_1/);
  const state = await readUsage(root); assert.equal(state.recent.length, 1);
  assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'unknown', exit_code: 1 });
});

test('cancellation records one fixed category even if a late close event follows', async t => {
  const root = await fixture(t), controller = new AbortController();
  const fake = scriptedSpawn(child => { controller.abort(); child.emit('close', 1); });
  await assert.rejects(generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE, signal: controller.signal }), /codex_aborted/);
  const state = await readUsage(root); assert.equal(state.recent.length, 1); assert.equal(fake.stats.kills, 1);
  assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'cancelled', exit_code: null });
});

test('timeout records one failure and does not retry', async t => {
  const root = await fixture(t), fake = scriptedSpawn(() => {});
  const deps = { ...fake, setTimer: callback => { queueMicrotask(callback); return 1; }, clearTimer() {} };
  await assert.rejects(generator(root, { codexPath: process.execPath }, deps)({ text: PRIVATE }), /codex_timeout/);
  const state = await readUsage(root); assert.equal(state.recent.length, 1); assert.equal(fake.stats.calls, 1); assert.equal(fake.stats.kills, 1);
  assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'timeout', exit_code: null });
});

test('process launch errors retain only an allowlisted code, never their path or message', async t => {
  const root = await fixture(t), fake = scriptedSpawn(child => child.emit('error', Object.assign(new Error(PRIVATE), { code: 'ECONNREFUSED', path: PRIVATE })));
  await assert.rejects(generator(root, { codexPath: process.execPath }, fake)({ text: PRIVATE }), /codex_launch_failed/);
  const state = await readUsage(root); assert.equal(state.recent.length, 1);
  assert.deepEqual(state.recent[0].outcome, { status: 'failure', code: 'network', exit_code: null });
  assert.doesNotMatch(JSON.stringify(state), new RegExp(PRIVATE));
});

test('Codex timeout uses the configured panel value and preserves bounded legacy mode defaults',()=>{
 for(const mode of ['routing','reply','proactive','memory_capture'])assert.equal(codexTimeoutMs({modelProvider:{timeoutMs:4321}},{mode,imageCount:2}),4321);
 assert.equal(codexTimeoutMs({},{mode:'routing'}),20000);assert.equal(codexTimeoutMs({},{}),60000);assert.equal(codexTimeoutMs({},{mode:'reply',imageCount:1}),90000);assert.equal(codexTimeoutMs({},{mode:'proactive'}),150000);
 for(const value of [0,99,180001,NaN,'1000'])assert.throws(()=>codexTimeoutMs({modelProvider:{timeoutMs:value}}),/codex_invalid_timeout/);
});
test('actual generator applies configured Codex deadline to its timer and keeps selected model and read-only flags',async t=>{
 const root=await fixture(t),fake=scriptedSpawn(()=>{});let delay,cleared=false;
 const result=generator(root,{codexPath:process.execPath,modelProvider:{type:'codex',model:'synthetic-model',timeoutMs:4321}},{...fake,setTimer:(callback,ms)=>{delay=ms;queueMicrotask(callback);return 'timer';},clearTimer:token=>{assert.equal(token,'timer');cleared=true;}});
 await assert.rejects(result({text:'synthetic',mode:'routing'}),/codex_timeout/);assert.equal(delay,4321);assert.equal(fake.stats.kills,1);assert.equal(cleared,true);assert.equal(fake.stats.args[fake.stats.args.indexOf('--model')+1],'synthetic-model');assert.ok(fake.stats.args.includes('read-only'));
});
test('configured Codex deadline actually terminates an inert local child process without invoking a model',async t=>{
 const root=await fixture(t),controller=new AbortController();let child,closed;const safety=setTimeout(()=>controller.abort(),3000);t.after(()=>{clearTimeout(safety);child?.kill();});
 const generate=generator(root,{codexPath:process.execPath,modelProvider:{type:'codex',timeoutMs:150}},{spawnProcess:(_executable,args,options)=>{assert.ok(args.includes('read-only'));child=realSpawn(process.execPath,['-e','setInterval(()=>{},10000)'],options);closed=new Promise(resolve=>child.once('close',resolve));return child;}});
 const started=Date.now();await assert.rejects(generate({text:'synthetic',signal:controller.signal}),/codex_timeout/);await closed;clearTimeout(safety);assert.ok(Date.now()-started<3000);assert.ok(child.exitCode!==null||child.signalCode!==null);
});
