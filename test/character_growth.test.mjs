import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CharacterGrowth } from '../src/character_growth.mjs';
import { durableWriteFile } from '../src/durable_write.mjs';

const base = path.resolve('temp');
const group = { group_openid: 'synthetic-group', author: { member_openid: 'synthetic-alice' } };
const privateEvent = { author: { user_openid: 'synthetic-owner' } };
const source = (id = 'message-one', content = '我们聊天时可以轻松些，也一起聊星星。') => ({ id, content });
const change = (message = source(), extra = {}) => ({ operation: 'upsert', id: '', kind: 'style',
  text: '闲聊时放松一点，少用正式的结尾。', source_message_id: message.id, source_excerpt: '聊天时可以轻松些', ...extra });
const options = (revision = 0, messages = [source()], extra = {}) => ({ expectedRevision: revision, messages, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, custom = {}) {
  await mkdir(base, { recursive: true });
  const dataDir = await mkdtemp(path.join(base, 'character_growth_'));
  const growth = await CharacterGrowth.open({ dataDir, now: () => 1792800000000, ...custom });
  t.after(async () => {
    await growth.queue;
    const relative = path.relative(base, dataDir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { growth, dataDir, file: path.join(dataDir, 'character_growth.json') };
}

test('growth persists independent style/interest/rapport entries without altering the base persona', async t => {
  const { growth, dataDir, file } = await fixture(t);
  const result = await growth.apply(group, [change(), change(source(), { kind: 'interest', text: '想一起看看夜空里的星座。' })], options());
  assert.equal(result.changed, true); assert.equal(result.revision, 1); assert.equal(result.entries.length, 2);
  assert.match(result.entries[0].id, /^growth_[a-f0-9]{32}$/);
  assert.match(growth.summary(group), /表达：/); assert.match(growth.summary(group), /兴趣：/);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.version, 1); assert.equal(Object.keys(disk.scopes).length, 1);
  assert.doesNotMatch(JSON.stringify(disk), /我们聊天时可以轻松些，也一起聊星星。/);
  const reopened = await CharacterGrowth.open({ dataDir });
  assert.deepEqual(reopened.snapshot(group), growth.snapshot(group));
  const copy = growth.snapshot(group); copy.entries[0].text = 'outside mutation';
  assert.notEqual(growth.snapshot(group).entries[0].text, copy.entries[0].text);
});

test('group participants share room growth while other groups and private owners remain isolated', async t => {
  const { growth } = await fixture(t);
  await growth.apply(group, [change()], options());
  assert.equal(growth.snapshot({ ...group, author: { member_openid: 'synthetic-bob' } }).entries.length, 1);
  assert.equal(growth.snapshot({ ...group, group_openid: 'other-group' }).entries.length, 0);
  assert.equal(growth.snapshot(privateEvent).entries.length, 0);
  await growth.apply(privateEvent, [change(source(), { kind: 'rapport', text: '私下相处时慢慢把话说完。' })], options());
  assert.equal(growth.snapshot({ author: { user_openid: 'another-owner' } }).entries.length, 0);
  assert.equal(growth.snapshot(group).entries[0].kind, 'style');
  assert.throws(() => growth.snapshot({ chat_type: 'group' }), /scope_invalid/);
});

test('empty updates are a true no-op and duplicate source/operation/text survives restart', async t => {
  let writes = 0;
  const { growth, dataDir } = await fixture(t, { save: async (...args) => { writes++; await durableWriteFile(...args); } });
  assert.equal((await growth.apply(group, [])).changed, false); assert.equal(writes, 0);
  const first = await growth.apply(group, [change()], options());
  const retry = await growth.apply(group, [change(source(), { source_excerpt: '可以轻松些' })], options(0));
  assert.equal(retry.changed, false); assert.equal(retry.revision, 1); assert.equal(writes, 1);
  const reopened = await CharacterGrowth.open({ dataDir });
  assert.equal((await reopened.apply(group, [change()], options(0))).changed, false);
  assert.deepEqual(reopened.snapshot(group).entries, first.entries);
});

test('existing entries can be revised or deleted and target IDs cannot be fabricated', async t => {
  const { growth } = await fixture(t);
  const first = await growth.apply(group, [change()], options());
  const id = first.entries[0].id;
  const later = source('message-two', '今天想把这个习惯改得更简洁。');
  const update = change(later, { id, text: '更喜欢短而完整的表达。', source_excerpt: '改得更简洁' });
  const revised = await growth.apply(group, [update], options(1, [later]));
  assert.equal(revised.entries.length, 1); assert.equal(revised.entries[0].id, id); assert.equal(revised.revision, 2);
  const removing = source('message-three', '这个习惯现在可以删掉了。');
  const deletion = change(removing, { operation: 'delete', id, text: '', source_excerpt: '这个习惯现在可以删掉了' });
  await assert.rejects(growth.apply(group, [{ ...deletion, kind: 'interest' }], options(2, [removing])), /target_mismatch/);
  const removed = await growth.apply(group, [deletion], options(2, [removing]));
  assert.equal(removed.entries.length, 0); assert.equal(removed.revision, 3);
  assert.equal((await growth.apply(group, [deletion], options(2, [removing]))).changed, false);
  await assert.rejects(growth.apply(group, [change(source(), { id: `growth_${'a'.repeat(32)}`, text: 'new unseen text' })], options(3)), /target_unknown/);
});

test('every update requires an exact excerpt from its actual current message ID', async t => {
  const { growth } = await fixture(t);
  for (const bad of [change(source(), { source_excerpt: '她一定想更热情' }), change(source(), { source_message_id: 'invented' }),
    change(source(), { source_excerpt: '' })]) {
    assert.throws(() => growth.apply(group, [bad], options()), /evidence_invalid|update_invalid/);
  }
  assert.throws(() => growth.apply(group, [change()], options(0, [], { reply: source().content })), /evidence_invalid/);
  assert.throws(() => growth.apply(group, [change()], options(0, [{ ...source(), group_openid: 'elsewhere' }])), /evidence_invalid/);
  assert.throws(() => growth.apply(privateEvent, [change()], options(0, [{ ...source(), author: { user_openid: 'another-owner' } }])), /evidence_invalid/);
  assert.throws(() => growth.apply(group, [change()], options(0, [source(), source('message-one', 'different body')])), /evidence_ambiguous/);
  assert.equal(growth.snapshot(group).revision, 0);
});

test('already-delivered assistant messages may be supplied explicitly as evidence', async t => {
  const { growth } = await fixture(t);
  const actual = { messageId: 'actual-delivery-id', role: 'assistant', content: '我发现自己喜欢安静地聊夜空。' };
  const update = { operation: 'upsert', id: '', kind: 'interest', text: '对夜空的话题更感兴趣。',
    source_message_id: actual.messageId, source_excerpt: '喜欢安静地聊夜空' };
  assert.equal((await growth.apply(group, [update], options(0, [actual]))).changed, true);
});

test('unknown fields, kinds, IDs, overlong text and oversized batches never become persona or filesystem settings', async t => {
  const { growth } = await fixture(t);
  for (const bad of [{ ...change(), path: 'D:/elsewhere' }, { ...change(), scope: 'another-room' },
    { ...change(), permissions: ['shell'] }, { ...change(), kind: 'identity' }, { ...change(), kind: 'tools' },
    { ...change(), id: '../card' }, { ...change(), text: '字'.repeat(161) }, { ...change(), source_excerpt: '字'.repeat(161) },
    { ...change(), text: 'a\0b' }, { ...change(), source_message_id: 'has space' }]) {
    assert.throws(() => growth.apply(group, [bad], options()), /update_invalid/);
  }
  assert.throws(() => growth.apply(group, [change(), change(), change()], options()), /updates_invalid/);
  assert.throws(() => growth.apply(group, { operation: 'upsert' }, options()), /updates_invalid/);
  assert.equal(growth.snapshot(group).revision, 0);
});

test('failed saves reject, preserve both old disk and recall state, and do not poison later writes', async t => {
  let broken = false;
  const { growth, file } = await fixture(t, { save: async (...args) => {
    if (broken) throw Error('synthetic_disk_failure'); await durableWriteFile(...args);
  } });
  await growth.apply(group, [change()], options());
  const before = await readFile(file);
  broken = true;
  const next = source('message-next', '聊一点新的兴趣吧。');
  const update = change(next, { kind: 'interest', text: '开始关注新的兴趣。', source_excerpt: '新的兴趣' });
  await assert.rejects(growth.apply(group, [update], options(1, [next])), /synthetic_disk_failure/);
  assert.deepEqual(await readFile(file), before); assert.equal(growth.snapshot(group).revision, 1);
  broken = false;
  assert.equal((await growth.apply(group, [update], options(1, [next]))).revision, 2);
});

test('parallel mutations of one scope reject stale revision while separate scopes merge durably', async t => {
  const { growth, dataDir } = await fixture(t);
  const result = await Promise.allSettled([
    growth.apply(group, [change()], options()),
    growth.apply(group, [change(source(), { text: 'another change' })], options()),
    growth.apply(privateEvent, [change(source(), { kind: 'rapport', text: '私聊的习惯。' })], options())
  ]);
  assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].status, 'rejected');
  assert.match(result[1].reason.message, /revision_conflict/); assert.equal(result[2].status, 'fulfilled');
  const reopened = await CharacterGrowth.open({ dataDir });
  assert.equal(reopened.snapshot(group).revision, 1); assert.equal(reopened.snapshot(privateEvent).revision, 1);
});

test('guard cancellation before persistence makes no change', async t => {
  let writes = 0;
  const { growth } = await fixture(t, { save: async () => { writes++; } });
  await assert.rejects(growth.apply(group, [change()], options(0, [source()], { guard: () => false })), /cancelled/);
  await assert.rejects(growth.apply(group, [change()], options(0, [source()], { guard: () => { throw Error('cancelled'); } })), /cancelled/);
  assert.equal(writes, 0); assert.equal(growth.snapshot(group).revision, 0);
});

test('guard cancellation during a staged save leaves canonical unchanged and never publishes the draft', async t => {
  const entered = deferred(), release = deferred(); let blocked = false, current = true;
  const { growth, dataDir } = await fixture(t, { save: async (...args) => {
    if (blocked) { blocked = false; entered.resolve(); await release.promise; } await durableWriteFile(...args);
  } });
  await growth.apply(group, [change()], options()); blocked = true;
  const pending = growth.apply(group, [change(source(), { text: 'draft must disappear' })], options(1, [source()], { guard: () => current }));
  const rejected = assert.rejects(pending, /cancelled/);
  await entered.promise; assert.equal(growth.snapshot(group).entries[0].text, change().text);
  current = false; release.resolve(); await rejected;
  const reopened = await CharacterGrowth.open({ dataDir });
  assert.deepEqual(reopened.snapshot(group), growth.snapshot(group)); assert.equal(reopened.snapshot(group).revision, 1);
});

test('cancel after successful staging requires no rollback write and restart cannot recover that draft as committed', async t => {
  let current = true, writes = 0, cancelNext = false;
  const { growth, dataDir, file } = await fixture(t, { save: async (target, bytes) => {
    writes++;
    if (writes > 2) throw Error('synthetic_rollback_failed');
    assert.match(target, /character_growth\.json\.[a-f0-9-]+\.draft$/);
    await durableWriteFile(target, bytes);
    if (cancelNext) current = false;
  } });
  await growth.apply(group, [change()], options());
  const before = await readFile(file);
  cancelNext = true;
  await assert.rejects(growth.apply(group, [change(source(), { text: 'cancelled staged draft' })],
    options(1, [source()], { guard: () => current })), /cancelled/);
  assert.equal(writes, 2, 'no rollback save is needed');
  assert.deepEqual(await readFile(file), before);
  const reopened = await CharacterGrowth.open({ dataDir });
  assert.equal(reopened.snapshot(group).revision, 1);
  assert.doesNotMatch(JSON.stringify(reopened.snapshot(group)), /cancelled staged draft/);
  assert.deepEqual((await readdir(dataDir)).filter(name => name.endsWith('.draft')), []);
});

test('orphan staged state after process interruption is ignored on restart and is not deleted by a different operation', async t => {
  const { growth, dataDir, file } = await fixture(t);
  await growth.apply(group, [change()], options());
  const committed = await readFile(file);
  const uncommitted = JSON.parse(committed);
  const scope = Object.values(uncommitted.scopes)[0];
  scope.revision++; scope.entries[0].text = 'orphan draft must never revive';
  const orphan = `${file}.synthetic-interrupted-write.draft`;
  await writeFile(orphan, JSON.stringify(uncommitted));
  const orphanBefore = await readFile(orphan);
  const reopened = await CharacterGrowth.open({ dataDir });
  assert.deepEqual(reopened.snapshot(group), growth.snapshot(group));
  await reopened.apply(group, [change(source(), { text: 'a later valid change' })], options(1));
  assert.deepEqual(await readFile(orphan), orphanBefore, 'only the current operation owns its draft cleanup');
  assert.doesNotMatch(JSON.stringify(reopened.snapshot(group)), /orphan draft/);
});

test('failed final rename preserves canonical state and permits a later successful retry', async t => {
  let removeStaged = false;
  const { growth, dataDir, file } = await fixture(t, { save: async (target, bytes) => {
    await durableWriteFile(target, bytes);
    if (removeStaged) await unlink(target);
  } });
  await growth.apply(group, [change()], options()); const before = await readFile(file);
  removeStaged = true;
  const update = change(source(), { text: 'pending publication' });
  await assert.rejects(growth.apply(group, [update], options(1)), error => error.code === 'ENOENT');
  assert.deepEqual(await readFile(file), before); assert.equal(growth.snapshot(group).revision, 1);
  const reopened = await CharacterGrowth.open({ dataDir });
  assert.deepEqual(reopened.snapshot(group), growth.snapshot(group));
  removeStaged = false;
  assert.equal((await growth.apply(group, [update], options(1))).revision, 2);
});

test('same source and text remain independent across kinds and explicit target IDs while exact retries stay idempotent', async t => {
  const { growth } = await fixture(t);
  const sameText = '习惯自然地接住这段话。';
  const batch = [change(source(), { kind: 'style', text: sameText }), change(source(), { kind: 'rapport', text: sameText })];
  const first = await growth.apply(group, batch, options());
  assert.equal(first.entries.length, 2); assert.equal(first.changes.length, 2);
  assert.deepEqual(first.entries.map(entry => entry.kind), ['style', 'rapport']);
  assert.equal((await growth.apply(group, batch, options(0))).changed, false);
  const second = [change(source(), { id: first.entries[0].id, kind: 'style', text: '两条不同目标可保留相同文字。' }),
    change(source(), { id: first.entries[1].id, kind: 'style', text: '两条不同目标可保留相同文字。' })];
  const modified = await growth.apply(group, second, options(1));
  assert.equal(modified.changes.length, 2); assert.equal(modified.entries.length, 2);
  assert.equal(modified.entries[0].text, modified.entries[1].text);
  assert.notEqual(modified.entries[0].id, modified.entries[1].id);
  assert.equal((await growth.apply(group, second, options(1))).changed, false);
});

test('forget increments epoch immediately and blocks in-flight and queued resurrection', async t => {
  const entered = deferred(), release = deferred(); let blocked = false;
  const { growth, dataDir } = await fixture(t, { save: async (...args) => {
    if (blocked) { blocked = false; entered.resolve(); await release.promise; } await durableWriteFile(...args);
  } });
  await growth.apply(group, [change()], options()); blocked = true;
  const inFlight = growth.apply(group, [change(source(), { text: 'in flight draft' })], options(1));
  const queued = growth.apply(group, [change(source(), { text: 'queued draft' })], options(1));
  const rejects = Promise.all([assert.rejects(inFlight, /cancelled/), assert.rejects(queued, /cancelled/)]);
  await entered.promise;
  const forgetting = growth.forget(group); release.resolve();
  await rejects; const cleared = await forgetting;
  assert.equal(cleared.revision, 2); assert.deepEqual(cleared.entries, []);
  const reopened = await CharacterGrowth.open({ dataDir });
  assert.deepEqual(reopened.snapshot(group), cleared); assert.doesNotMatch(reopened.summary(group), /draft|闲聊时放松/);
  const persisted = JSON.stringify(reopened.state);
  assert.doesNotMatch(persisted, /draft|聊天时可以轻松些/);
});

test('a failed forget is reported without claiming committed entries were cleared', async t => {
  let broken = false;
  const { growth, file } = await fixture(t, { save: async (...args) => {
    if (broken) throw Error('forget_disk_failed'); await durableWriteFile(...args);
  } });
  await growth.apply(group, [change()], options()); const before = await readFile(file);
  broken = true; await assert.rejects(growth.forget(group), /forget_disk_failed/);
  assert.equal(growth.snapshot(group).entries.length, 1); assert.deepEqual(await readFile(file), before);
  broken = false; await growth.forget(group); assert.equal(growth.snapshot(group).entries.length, 0);
});

test('entry and change limits reject excess entries and retain only 32 recent change summaries', async t => {
  const { growth } = await fixture(t);
  for (let i = 0; i < 16; i++) await growth.apply(group, [change(source(), { text: `习惯 ${i}` })], options(i));
  await assert.rejects(growth.apply(group, [change(source(), { text: '第十七个习惯' })], options(16)), /capacity/);
  assert.equal(growth.snapshot(group).revision, 16);
  const id = growth.snapshot(group).entries[0].id;
  for (let i = 0; i < 20; i++) await growth.apply(group, [change(source(), { id, text: `新的习惯 ${i}` })], options(16 + i));
  const state = Object.values(growth.state.scopes)[0];
  assert.equal(state.entries.length, 16); assert.equal(state.changes.length, 32); assert.equal(state.revision, 36);
});

test('damaged, malformed or unsupported stores are rejected without replacing original bytes', async t => {
  const { dataDir, file } = await fixture(t);
  for (const bytes of [Buffer.alloc(30), Buffer.from('{bad'), Buffer.from(JSON.stringify({ version: 2, scopes: {} })),
    Buffer.from(JSON.stringify({ version: 1, scopes: {}, extra: true }))]) {
    await writeFile(file, bytes);
    await assert.rejects(CharacterGrowth.open({ dataDir }), /store_invalid/);
    assert.deepEqual(await readFile(file), bytes);
  }
});

test('relative and malformed storage paths are rejected without fallback', async () => {
  for (const dataDir of ['.', 'relative/character_growth', 'invalid\0root']) {
    await assert.rejects(CharacterGrowth.open({ dataDir }), /requires_d_path/);
  }
});
