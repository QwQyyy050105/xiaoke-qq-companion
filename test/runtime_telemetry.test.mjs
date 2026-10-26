import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeTelemetry } from '../src/runtime_telemetry.mjs';

const TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const TIME = Date.parse('2026-10-22T03:04:05.000Z');
async function fixture(t) {
  await fs.mkdir(TEMP, { recursive: true });
  const root = await fs.mkdtemp(path.join(TEMP, 'runtime_telemetry_test_'));
  assert.ok(root.startsWith(TEMP + path.sep));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const telemetry = createRuntimeTelemetry({ root, version: '1.0.0', now: () => TIME });
  const read = async name => JSON.parse(await fs.readFile(path.join(root, 'data', name), 'utf8'));
  return { root, telemetry, read };
}

test('status writes only its strict whitelist and performs no factory I/O', async t => {
  const f = await fixture(t);
  assert.deepEqual(await fs.readdir(f.root), []);
  const result = await f.telemetry.writeStatus({ connected: true, pid: 42, roomId: 'private-room', secret: 'private-secret', text: 'private-chat' });
  assert.deepEqual(result, { connected: true, updatedAt: '2026-10-22T03:04:05.000Z', pid: 42, version: '1.0.0' });
  assert.deepEqual(await f.read('runtime_status.json'), result);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), ['runtime_status.json']);
});

test('feedback masks locations, identifiers and tokens and strips controls and caller metadata', async t => {
  const f = await fixture(t);
  const record = await f.telemetry.feedback({ level: 'warning', roomId: 'private-room', secret: 'private-secret',
    message: '连接失败\u0000\u202e https://example.com/a?x=4 test@example.com D:\\Private\\file.txt /var/private/file.log ../relative/file.js local/path.txt 123456789 0123456789abcdef0123456789abcdef member_abcdef <@12345> qq.example.cn' });
  assert.deepEqual(Object.keys(record).sort(), ['at', 'level', 'message']);
  for (const token of ['[url]', '[email]', '[path]', '[number]', '[token]', '[id]']) assert.ok(record.message.includes(token));
  assert.doesNotMatch(record.message, /example|Private|private|relative|123456789|abcdef|\u0000|\u202e/);
  assert.deepEqual(await f.read('feedback.json'), [record]);
});

test('credentials, chat payloads, QQ identity fields and ordinary chat are discarded without writing', async t => {
  const f = await fixture(t);
  for (const message of ['连接错误 AppSecret=demo-secret', 'error password: demo', 'error 密码是demo',
    'error Authorization: Bearer demo', 'error Bearer demo', 'error sk-proj-abcdefghijklmnopqrstuv',
    'error -----BEGIN '+'RSA PRIVATE KEY-----', 'error 用户消息：这是聊天正文',
    'error chat_content: private conversation', 'error {"role":"user","content":"private"}',
    'error group_openid: private-group', 'error roomId=private-room', 'error QQ号：12345',
    'error {"password":"private"}', 'error {"group_openid":"private-room"}',
    'error {"user_message":"private-chat"}', 'error pass\u0000word: private', 'error 密码\u202e:private',
    '你好，今天我们一起吃饭吧', '', ' '.repeat(10)]) {
    assert.equal(await f.telemetry.feedback({ level: 'error', message }), null, message);
  }
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('messages preserve Unicode boundaries and remain at most 500 characters', async t => {
  const f = await fixture(t);
  const record = await f.telemetry.feedback({ level: 'info', message: '服务状态 ' + '🐉'.repeat(800) });
  assert.equal([...record.message].length, 500);
  assert.equal(record.message.at(-1).charCodeAt(0) >= 0xdc00, true);
  assert.equal(Buffer.from(record.message).toString(), record.message);
});

test('concurrent writes stay ordered, retain the last 100 feedback items, and leave no temporary files', async t => {
  const f = await fixture(t); const tasks = [];
  for (let i = 0; i < 120; i++) {
    tasks.push(f.telemetry.feedback({ level: i % 2 ? 'info' : 'error', message: `服务状态 ${i}` }));
    tasks.push(f.telemetry.writeStatus({ connected: i % 2 === 1, pid: 100 + i }));
  }
  await Promise.all(tasks);
  const records = await f.read('feedback.json');
  assert.equal(records.length, 100);
  assert.deepEqual(records.map(item => item.message), Array.from({ length: 100 }, (_, i) => `服务状态 ${i + 20}`));
  assert.deepEqual(await f.read('runtime_status.json'), { connected: true, updatedAt: '2026-10-22T03:04:05.000Z', pid: 219, version: '1.0.0' });
  assert.deepEqual((await fs.readdir(path.join(f.root, 'data'))).sort(), ['feedback.json', 'runtime_status.json']);
});

test('reopening preserves safe feedback, removes unapproved fields and re-sanitizes loaded records', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'data'));
  await fs.writeFile(path.join(f.root, 'data', 'feedback.json'), JSON.stringify([
    { at: '2026-10-22T01:00:00.000Z', level: 'warning', message: '连接失败 test@example.com', roomId: 'private-room' },
    { at: '2026-10-22T01:00:00.000Z', level: 'error', message: 'error password=private' },
    { at: 'not-an-iso-date', level: 'error', message: 'error private date value' }
  ]));
  await f.telemetry.feedback({ level: 'info', message: '服务启动' });
  const records = await f.read('feedback.json');
  assert.equal(records.length, 2); assert.equal(records[0].message, '连接失败 [email]');
  assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'level', 'message']);
});

test('invalid input and failed persistence never poison the serialized queue', async t => {
  const f = await fixture(t);
  for (const status of [{ connected: 'true', pid: 1 }, { connected: true, pid: 0 }, { connected: true, pid: 1.5 }]) {
    await assert.rejects(f.telemetry.writeStatus(status), /invalid_status/);
  }
  await assert.rejects(f.telemetry.feedback({ level: 'debug', message: 'service failed' }), /invalid_level/);
  await fs.mkdir(path.join(f.root, 'data'));
  await fs.writeFile(path.join(f.root, 'data', 'feedback.json'), '{}');
  await assert.rejects(f.telemetry.feedback({ level: 'error', message: 'service failed' }), /feedback_invalid/);
  const status = await f.telemetry.writeStatus({ connected: false, pid: 1 });
  assert.equal(status.connected, false);
  assert.deepEqual(await f.read('feedback.json'), {});
});
