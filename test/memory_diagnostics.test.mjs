import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { MemoryCapture } from '../src/memory_capture.mjs';
import { inspectRoomMemory, mergeRoomMemory } from '../src/room_memory.mjs';

const scope = `member_${'a'.repeat(64)}`, room = 'b'.repeat(64), speaker = `member_${'c'.repeat(16)}`;
const message = (messageId, content, extra = {}) => ({ scope, room, speaker, messageId, content, ...extra });
const proposal = (source, kind = 'request') => ({ kind, text: source.content, source: source.content,
  speaker: source.speaker, messageId: source.messageId, operation: 'remember', targetId: '' });
async function fixture(t, options = {}) {
  const base = resolve('temp'), dir = await mkdtemp(join(base, 'memory_diagnostics_'));
  const instances = [];
  const open = async extra => { const instance = await MemoryCapture.open({ dataDir: dir, ...options, ...extra }); instances.push(instance); return instance; };
  t.after(async () => { for (const instance of instances) await instance.close(); assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true }); });
  return { dir, open, capture: await open() };
}

test('failure diagnostics persist across restart; success resets consecutive failures but retains historical totals', async t => {
  let now = Date.parse('2026-10-24T10:00:00Z');
  const f = await fixture(t, { now: () => now, extract: async () => { throw Object.assign(Error('PRIVATE_ERROR_BODY'), { code: 'codex_timeout' }); } });
  await f.capture.observe(message('source', '下次接着讲极限。'));
  assert.equal(await f.capture.drain({ force: true }), false);
  assert.equal(f.capture.status().failures, 1);
  assert.equal(f.capture.status().consecutiveFailures, 1);
  assert.equal(f.capture.status().lastFailureCode, 'codex_timeout');
  assert.equal(f.capture.status().lastFailureAt, new Date(now).toISOString());
  assert.equal(f.capture.status().lastSuccessAt, null);
  await f.capture.close();
  const restored = await f.open({ extract: async () => ({ personal: [], room: [] }) });
  assert.equal(restored.status().lastError, 'codex_timeout');
  assert.equal(restored.status().consecutiveFailures, 1);
  const oldFailureAt = restored.status().lastFailureAt;
  now += 300000;
  assert.equal(await restored.drain({ force: true }), true);
  assert.equal(restored.status().consecutiveFailures, 0);
  assert.equal(restored.status().failures, 1);
  assert.equal(restored.status().lastError, null);
  assert.equal(restored.status().lastFailureAt, oldFailureAt);
  assert.equal(restored.status().lastFailureCode, 'codex_timeout');
  assert.equal(restored.status().lastSuccessAt, new Date(now).toISOString());
  await restored.close();
  const again = await f.open({ extract: undefined });
  assert.equal(again.status().lastSuccessAt, new Date(now).toISOString());
  assert.equal(again.status().consecutiveFailures, 0);
  assert.doesNotMatch(JSON.stringify(again.status()), /PRIVATE_ERROR_BODY|source|member_[a-f0-9]/);
  const disk = JSON.parse(await readFile(join(f.dir, 'memory_capture.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(disk.diagnostics), /PRIVATE_ERROR_BODY|member_/);
});

test('old cumulative failures do not invent a failure date or current failure streak', async t => {
  const f = await fixture(t);
  const legacy = structuredClone(f.capture.state);
  delete legacy.diagnostics; delete legacy.roomDiagnostics; legacy.counters.failures = 438;
  await writeFile(join(f.dir, 'memory_capture.json'), JSON.stringify(legacy));
  const restored = await f.open();
  assert.equal(restored.status().failures, 438);
  assert.equal(restored.status().consecutiveFailures, 0);
  assert.equal(restored.status().lastFailureAt, null);
  assert.equal(restored.status().lastFailureCode, null);
  assert.equal(restored.status().roomDiagnostics.startedAt, null);
});

test('unknown error messages and codes never enter persisted diagnostic fields', async t => {
  const f = await fixture(t, { extract: async () => { throw Object.assign(Error('PRIVATE_ERROR_BODY'), { code: 'PRIVATE_ACCOUNT_ID' }); } });
  await f.capture.observe(message('source', '下次接着讲极限。'));
  await f.capture.drain({ force: true });
  assert.equal(f.capture.status().lastFailureCode, 'memory_capture_extract_failed');
  assert.doesNotMatch(JSON.stringify(f.capture.status()), /PRIVATE_ERROR_BODY|PRIVATE_ACCOUNT_ID/);
  const disk = JSON.parse(await readFile(join(f.dir, 'memory_capture.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(disk.diagnostics), /PRIVATE_ERROR_BODY|PRIVATE_ACCOUNT_ID/);
});

test('a failed successful-result commit records a commit failure without publishing memory or successful diagnostics', async t => {
  let now = Date.parse('2026-10-24T10:00:00Z');
  const f = await fixture(t, { now: () => now, extract: async input => ({ personal: [], room: input.messages.map(source => proposal(source)) }) });
  await f.capture.observe(message('source', '下次接着讲极限。'));
  const save = f.capture.save;
  let failOnce = true;
  f.capture.save = async state => { if (failOnce) { failOnce = false; throw Error('PRIVATE_DISK_PATH_SENTINEL'); } return save(state); };
  assert.equal(await f.capture.drain({ force: true }), false);
  assert.equal(f.capture.status().lastFailureCode, 'memory_capture_commit_failed');
  assert.equal(f.capture.status().lastSuccessAt, null);
  assert.equal(f.capture.status().roomDiagnostics.applied, 0);
  assert.deepEqual(f.capture.recallRoom(room), []);
  assert.equal(f.capture.status().pending, 1);
  assert.doesNotMatch(JSON.stringify(f.capture.status()), /PRIVATE_DISK_PATH_SENTINEL/);
  now += 300000;
  assert.equal(await f.capture.drain({ force: true }), true);
  assert.equal(f.capture.status().consecutiveFailures, 0);
  assert.equal(f.capture.status().failures, 1);
  assert.equal(f.capture.status().roomDiagnostics.applied, 1);
});

test('room inspection preserves merge output and reports only fixed aggregate reasons', () => {
  const now = Date.parse('2026-10-24T10:00:00Z');
  const valid = message('valid', '我们正在聊极限这个话题。');
  const mismatch = message('mismatch', '我今天发了一张图。');
  const candidates = [proposal(valid, 'topic'), proposal(mismatch, 'topic'), { ...proposal(valid, 'topic'), messageId: 'PRIVATE_ID_SENTINEL' }];
  const inspected = inspectRoomMemory([], candidates, [valid, mismatch], now);
  assert.deepEqual(inspected.entries, mergeRoomMemory([], candidates, [valid, mismatch], now));
  assert.deepEqual(inspected.diagnostics, { candidates: 3, applied: 1, rejected: 2, unchanged: 0, deferred: 0,
    rejectionReasons: { category_mismatch: 1, source_message_missing: 1 } });
  assert.doesNotMatch(JSON.stringify(inspected.diagnostics), /PRIVATE_ID_SENTINEL|member_|极限|话题|发了一张图/);
  const repeated = inspectRoomMemory(inspected.entries, [proposal(valid, 'topic')], [valid], now);
  assert.equal(repeated.diagnostics.unchanged, 1);
  assert.equal(repeated.diagnostics.applied, 0);
});

test('background room candidates are counted once per batch, with unmatched sources explicitly rejected', async t => {
  const f = await fixture(t, { extract: async input => ({ personal: [], room: [
    ...input.messages.map(source => proposal(source)),
    { ...proposal(input.messages[0]), messageId: 'PRIVATE_UNOBSERVED_SOURCE' }
  ] }) });
  await f.capture.observe(message('first', '下次接着讲极限。'));
  await f.capture.observe(message('second', '回头接着聊导数。'));
  assert.equal(await f.capture.drain({ force: true }), true);
  const status = f.capture.status();
  assert.equal(status.roomDiagnostics.candidates, 3);
  assert.equal(status.roomDiagnostics.applied, 2);
  assert.equal(status.roomDiagnostics.rejected, 1);
  assert.equal(status.roomDiagnostics.rejectionReasons.source_not_in_batch, 1);
  assert.equal(status.roomWrites, 2);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_UNOBSERVED_SOURCE|极限|导数|member_/);
});

test('memory status separates group and private facts from group topics and private continuity', async t => {
  const f = await fixture(t);
  await f.capture.observe(message('group-fact', '我喜欢红茶。'));
  await f.capture.observe(message('group-topic', '我们正在聊极限这个话题。'));
  const privateScope = { scope: 'private_owner', room: 'private_owner', speaker: 'owner' };
  await f.capture.observe(message('private-fact', '我喜欢咖啡。', privateScope));
  await f.capture.observe(message('private-request', '下次接着讲导数。', privateScope));
  assert.equal(f.capture.status().scope, 'background_capture_store');
  assert.deepEqual(f.capture.status().memoryCounts, {
    personalFacts: { total: 2, group: 1, private: 1 }, groupTopics: 1, groupConversation: 1, privateContinuity: 1,
    groupByKind: { topic: 1, agreement: 0, vocabulary: 0, request: 0 },
    privateByKind: { topic: 0, agreement: 0, vocabulary: 0, request: 1 }
  });
  const restored = await f.open();
  assert.deepEqual(restored.status().memoryCounts, f.capture.status().memoryCounts);
  assert.doesNotMatch(JSON.stringify(restored.status()), /红茶|咖啡|极限|导数|owner|member_/);
});
