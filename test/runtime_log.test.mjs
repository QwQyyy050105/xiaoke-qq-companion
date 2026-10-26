import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeLog, sanitizeRuntimeEntry } from '../src/runtime_log.mjs';

const TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const TIME = Date.parse('2026-10-22T03:04:05.000Z');
async function fixture(t, options = {}) {
  await fs.mkdir(TEMP, { recursive: true });
  const root = await fs.mkdtemp(path.join(TEMP, 'runtime_log_test_'));
  assert.ok(root.startsWith(TEMP + path.sep));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, logger: await RuntimeLog.open({ root, now: () => TIME, ...options }) };
}

test('only exact diagnostics survive; secrets, credentials, chat and arbitrary error text never persist', async t => {
  const { root, logger } = await fixture(t);
  const inputs = ['AppSecret=private-value', 'access_token: sk-secret-value', 'Bearer qwertysecret',
    '你好小柯，我们明天去看电影', 'QQ 已连接，等待单聊和群聊消息。 secret=hidden',
    { role: 'user', content: 'private-chat', token: 'secret' }, 'CODEX_OK: private-answer',
    '小柯 > private-reply', '群聊触发：private-secret', 'unlabelledlongtokenabcdefghijklmno',
    '连接失败：Authorization: Bearer PRIVATE', 'QQ 凭据校验失败：今天的群聊正文'];
  for (const value of inputs) await logger.log(value, { fields: { prompt: 'private-prompt', history: ['private-history'], group_openid: 'private-group' } });
  await logger.error('处理失败：codex_invalid_chat_response', { status: 503, token: 'private-token', reason: 'private-reason' });
  const disk = await fs.readFile(path.join(root, 'data/runtime_logs/runtime.jsonl'), 'utf8');
  assert.doesNotMatch(disk, /private|PRIVATE|secret|AppSecret|Authorization|Bearer|prompt|history|group_openid|电影|正文|abcdefghijklmno/);
  const summary = await logger.summary();
  assert.equal(summary.counts.suppressed, 10);
  assert.equal(summary.counts.connection_failed, 1);
  assert.equal(summary.counts.auth_failed, 1);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.recent.at(-1).fields, { status: 503, error_code: 'codex_invalid_chat_response' });
});

test('known event/timing templates retain useful bounded technical counters', () => {
  const fixtures = [
    ['群聊共同回合：2 位成员，3 条消息。', 'group_turn', { members: 2, messages: 3 }],
    ['群聊耗时：进入处理前 400ms，处理 2345ms，首条送达 2500ms。', 'group_timing', { queue_ms: 400, processing_ms: 2345, sent: true, first_delivery_ms: 2500 }],
    ['群聊耗时：进入处理前 0ms，处理 5ms，未发送。', 'group_timing', { queue_ms: 0, processing_ms: 5, sent: false }],
    ['图片准备：加载 3 张，其中聊天图片 2 张，尺寸 12x12,8x8，引用 1 条，未加载 0 张，用时 48ms。', 'image_prepare', { images: 3, received_images: 2, quotes: 1, unloaded_images: 0, elapsed_ms: 48 }],
    ['QQ 连接断开（1006），准备重连。', 'disconnected', { code: 1006 }],
    ['主动消息未确认送达：qq_api_error_40034105。', 'proactive_uncertain', { code: 40034105 }],
    ['群聊触发：classified_continuation', 'route_accept', { reason: 'classified_continuation' }],
    ['群聊暂不接话：bot_or_self', 'route_ignore', { reason: 'bot_or_self' }],
    ['生图后实际视觉尺寸判断：unverified。', 'visual_postflight', { size_check: 'unverified' }]
  ];
  for (const [input, event, fields] of fixtures) {
    const actual = sanitizeRuntimeEntry(input);
    assert.equal(actual.event, event, input); assert.deepEqual(actual.fields, fields, input);
  }
  assert.deepEqual(sanitizeRuntimeEntry('QQ 图片回复已发送。', { fields: { count: -1, elapsed_ms: Infinity, members: 2, code: 'secret', status: 200, content: 'hidden' } }).fields, { members: 2, status: 200 });
});

test('concurrent logs rotate in order under exact byte and retain caps; legacy evidence is untouched', async t => {
  const { root, logger } = await fixture(t, { maxBytes: 1024, retain: 2 });
  const original = 'original diagnostic and chat evidence';
  for (const filename of ['bridge.out.log', 'bridge.err.log', 'state.json', 'model_usage.json']) {
    await fs.writeFile(path.join(root, 'data', filename), original);
  }
  await Promise.all(Array.from({ length: 90 }, (_, n) => logger.info(`群聊耗时：进入处理前 ${n}ms，处理 25ms，未发送。`)));
  await logger.flush();
  const summary = await logger.summary({ limit: 50 });
  assert.equal(summary.files, 3); assert.ok(summary.bytes <= 3072); assert.equal(summary.capacityBytes, 3072);
  const queues = summary.recent.map(item => item.fields.queue_ms);
  assert.deepEqual(queues, Array.from({ length: queues.length }, (_, index) => 90 - queues.length + index));
  assert.equal(queues.at(-1), 89);
  assert.deepEqual((await fs.readdir(logger.directory)).sort(), ['owner.json', 'runtime.1.jsonl', 'runtime.2.jsonl', 'runtime.jsonl']);
  for (const filename of ['bridge.out.log', 'bridge.err.log', 'state.json', 'model_usage.json']) {
    assert.equal(await fs.readFile(path.join(root, 'data', filename), 'utf8'), original);
  }
  for (const filename of ['runtime.jsonl', 'runtime.1.jsonl', 'runtime.2.jsonl']) assert.ok((await fs.stat(path.join(logger.directory, filename))).size <= 1024);
});

test('zero archive policy remains bounded and reopening preserves recent diagnostics', async t => {
  const { root, logger } = await fixture(t, { maxBytes: 1024, retain: 0 });
  for (let n = 0; n < 25; n++) await logger.info('收到 QQ 群聊普通消息。');
  const before = await logger.summary();
  const reopened = await RuntimeLog.open({ root, maxBytes: 1024, retain: 0, now: () => TIME });
  assert.deepEqual(await reopened.summary(), before);
  assert.equal(before.files, 1); assert.ok(before.bytes <= 1024);
  await assert.rejects(RuntimeLog.open({ root, maxBytes: 2048, retain: 0 }), /owner_mismatch/);
});

test('summary rebuilds only schema fields and never reflects altered content or injected metadata', async t => {
  const { logger } = await fixture(t);
  await logger.info('QQ 语音回复已发送。');
  const record = { at: new Date(TIME).toISOString(), event: 'reply_image', level: 'info', message: 'private-chat', fields: { secret: 'private-token', status: 200 }, user: 'private-member' };
  await fs.appendFile(logger.file(), JSON.stringify(record) + '\n' + JSON.stringify({ ...record, event: 'private-secret' }) + '\ninvalid json\n');
  const result = await logger.summary({ limit: 100 });
  assert.equal(result.records, 2); assert.equal(result.invalidRecords, 2);
  assert.equal(result.counts.reply_image, 1); assert.equal(result.counts.reply_voice, 1);
  assert.deepEqual(result.recent.at(-1).fields, { status: 200 });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|user/);
  assert.equal((await logger.summary({ limit: 0 })).recent.length, 0);
  assert.match(result.text, /仅统计保留窗口/);
});

test('unmarked preexisting logs, owner replacement, oversize files and path escapes are not adopted or deleted', async t => {
  const { root, logger } = await fixture(t, { maxBytes: 1024, retain: 1 });
  await fs.writeFile(logger.file(), 'x'.repeat(1025));
  await assert.rejects(logger.info('QQ 凭据校验通过。'), /over_limit/);
  assert.equal((await fs.stat(logger.file())).size, 1025);
  await fs.writeFile(logger.file(), '');
  await logger.info('QQ 凭据校验通过。'); // failed write did not poison the queue
  await fs.writeFile(path.join(logger.directory, 'owner.json'), '{"owner":"another_application"}');
  await assert.rejects(logger.info('QQ 凭据校验通过。'), /owner_mismatch/);
  await assert.rejects(logger.summary(), /owner_mismatch/);
  assert.equal((await fs.readFile(logger.file(), 'utf8')).split('\n').filter(Boolean).length, 1);
  const unmarkedRoot = path.join(root, 'unmarked');
  await fs.mkdir(path.join(unmarkedRoot, 'data/runtime_logs'), { recursive: true });
  await fs.writeFile(path.join(unmarkedRoot, 'data/runtime_logs/runtime.jsonl'), 'original');
  await assert.rejects(RuntimeLog.open({ root: unmarkedRoot }), /unmanaged_directory/);
  assert.equal(await fs.readFile(path.join(unmarkedRoot, 'data/runtime_logs/runtime.jsonl'), 'utf8'), 'original');
  const linkedRoot = path.join(root, 'linked'); const target = path.join(root, 'outside');
  await fs.mkdir(linkedRoot); await fs.mkdir(target);
  await fs.symlink(target, path.join(linkedRoot, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(RuntimeLog.open({ root: linkedRoot }), /directory_boundary/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('a substituted log symlink cannot be read, rotated, or appended', async t => {
  const { root, logger } = await fixture(t, { maxBytes: 1024, retain: 1 });
  const outside = path.join(root, 'evidence.txt'); await fs.writeFile(outside, 'untouched original');
  try { await fs.symlink(outside, logger.file(), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('File symlinks unavailable to this Windows account'); return; } throw error; }
  await assert.rejects(logger.info('群聊回复已发送。'), /file_boundary/);
  await assert.rejects(logger.summary(), /file_boundary/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'untouched original');
});
