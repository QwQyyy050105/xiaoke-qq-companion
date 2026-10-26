import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { Companion, hash } from '../src/core.mjs';
import { MemoryCapture } from '../src/memory_capture.mjs';

const event = (id, content, member = 'owner', group) => ({ id, content,
  ...(group ? { group_openid: group, author: { member_openid: member } } : { author: { user_openid: member } }),
  timestamp: new Date().toISOString() });
async function fixture(t, seed = {}, extra = {}) {
  const root = resolve('temp'), dir = await mkdtemp(join(root, 'personal_memory_bridge_'));
  const instances = [], generated = [], replies = [];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ owner: 'owner', history: [], memory: [], seen: [], ...seed }));
  const open = async (options = {}) => {
    const capture = options.unavailable ? undefined : await MemoryCapture.open({ dataDir: dir, idleMs: 3600000, ...extra });
    if (capture) instances.push(capture);
    const bot = await new Companion({ dataDir: dir, memoryCapture: capture, memoryCaptureRequired: true,
      generate: async input => { generated.push(input); return { reply: '听见了', memories: [{ text: '我喜欢猫。', source: '我喜欢猫。' }] }; }, ...options }).init();
    return { bot, capture, send: input => bot.handle(input, async text => { replies.push(text); return { id: 'sent_' + replies.length }; }) };
  };
  const current = await open();
  t.after(async () => { await Promise.all(instances.map(item => item.close())); assert.ok(resolve(dir).startsWith(root + sep)); await rm(dir, { recursive: true, force: true }); await assert.rejects(access(dir), { code: 'ENOENT' }); });
  return { ...current, open, dir, generated, replies };
}

test('manual facts use the canonical store and naturally corrected facts survive restart without old strings', async t => {
  const f = await fixture(t, {}, { extract: async input => {
    const target = input.existingPersonalTargets.find(item => item.source === '我喜欢泰拉瑞亚。');
    const message = input.messages.find(item => item.content === '我已经退坑泰拉瑞亚了。');
    return { personal: [], room: [], personal_updates: target && message ? [{ operation: 'update', kind: target.kind, targetId: target.id,
      targetSource: target.source, text: message.content, source: message.content, speaker: message.speaker, messageId: message.messageId }] : [] };
  } });
  await f.send(event('save', '/remember 我喜欢泰拉瑞亚。'));
  assert.deepEqual(f.bot.state.memory, []);
  await f.send(event('change', '我已经退坑泰拉瑞亚了。'));
  await f.capture.drain({ force: true });
  const recalled = f.bot.personalMemory(null, 'owner', ['我喜欢泰拉瑞亚。']);
  assert.ok(recalled.some(item => item.text === '我已经退坑泰拉瑞亚了。'));
  assert.ok(!recalled.some(item => item.text === '我喜欢泰拉瑞亚。'));
  const restored = await f.open();
  await restored.send(event('list', '/memory'));
  assert.match(f.replies.at(-1), /我已经退坑泰拉瑞亚了/); assert.doesNotMatch(f.replies.at(-1), /我喜欢泰拉瑞亚。/);
});

test('legacy unknown notes remain useful, honest and isolated after idempotent import', async t => {
  const memberKey = hash(JSON.stringify(['group', 'friend']));
  const f = await fixture(t, { memory: ['比赛截止日期：周五'], groups: { [memberKey]: { history: [], memory: ['群笔记：周末集合'] } } });
  const own = f.bot.personalMemory(null, 'owner');
  assert.equal(own[0].text, '比赛截止日期：周五'); assert.equal(own[0].origin, 'legacy_unverified');
  assert.equal(own[0].speaker, null); assert.equal(own[0].messageId, null); assert.equal(own[0].at, null);
  assert.deepEqual(f.bot.state.memory, []); assert.deepEqual(f.bot.state.groups[memberKey].memory, []);
  assert.equal(f.bot.personalMemory('group', 'friend')[0].text, '群笔记：周末集合');
  const restored = await f.open(); assert.equal(restored.bot.personalMemory(null, 'owner').length, 1);
});

test('generic manual notes can be edited and deleted using exact natural requests and IDs', async t => {
  const f = await fixture(t);
  await f.send(event('save', '/remember 比赛截止日期：周五'));
  await f.send(event('edit', '把保存的「比赛截止日期：周五」改成「比赛截止日期：周六」'));
  const note = f.bot.personalMemory(null, 'owner')[0]; assert.equal(note.text, '比赛截止日期：周六');
  await f.send(event('delete', '/memory-delete ' + note.id));
  assert.deepEqual(f.bot.personalMemory(null, 'owner'), []);
  assert.equal(f.generated.length, 0, 'explicit note management needs no chat model');
});

test('reset preserves manual notes while forget removes canonical notes and old import inputs', async t => {
  const f = await fixture(t, { memory: ['旧笔记'] });
  await f.send(event('save', '/remember 新笔记'));
  await f.send(event('reset', '/reset')); assert.equal(f.bot.personalMemory(null, 'owner').length, 2);
  await f.send(event('forget', '/forget'));
  assert.deepEqual(f.bot.personalMemory(null, 'owner'), []);
  const old = JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8')); old.memory = ['旧笔记'];
  await writeFile(join(f.dir, 'state.json'), JSON.stringify(old));
  const restored = await f.open(); assert.deepEqual(restored.bot.personalMemory(null, 'owner'), []);
  assert.deepEqual(restored.bot.state.memory, []);
});

test('production memory-load failure never revives legacy strings or accepts new raw-string memories', async t => {
  const f = await fixture(t);
  const raw = JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8')); raw.memory = ['不应回退的旧笔记'];
  await writeFile(join(f.dir, 'state.json'), JSON.stringify(raw));
  const broken = await f.open({ unavailable: true });
  await broken.send(event('chat', '我喜欢猫。'));
  assert.deepEqual(f.generated.at(-1).memory, []);
  await broken.send(event('save', '/remember 新内容'));
  assert.doesNotMatch(f.replies.at(-1), /^记住了/);
  assert.deepEqual(broken.bot.state.memory, ['不应回退的旧笔记']);
});

test('failed manual write sends no success and publishes no note', async t => {
  const f = await fixture(t); const original = f.capture.save;
  f.capture.save = async () => { throw Error('simulated_io_failure'); };
  await f.send(event('save', '/remember 不应出现'));
  assert.doesNotMatch(f.replies.at(-1), /^记住了/); assert.deepEqual(f.bot.personalMemory(null, 'owner'), []);
  f.capture.save = original;
});

test('failed second-store forget is durably resumed before old histories or imported notes are recalled', async t => {
  const f = await fixture(t, { memory: ['旧笔记'], history: [{ role: 'user', content: '旧历史' }] });
  const persist = f.bot.persist.bind(f.bot); let writes = 0;
  f.bot.persist = async () => { if (++writes === 2) throw Error('simulated_second_store_failure'); return persist(); };
  await assert.rejects(f.bot.personalMemoryBridge.forget(event('forget', '/forget')), /simulated_second_store_failure/);
  assert.ok(f.bot.state.pendingPersonalForgets.private_owner);
  assert.deepEqual(f.bot.personalMemory(null, 'owner'), []);
  const restored = await f.open(); assert.deepEqual(restored.bot.state.history, []);
  assert.deepEqual(restored.bot.personalMemory(null, 'owner'), []);
  assert.deepEqual(restored.bot.state.pendingPersonalForgets, {});
});

test('group forget recovery excludes old shared context and preserves other members personal notes', async t => {
  const a = hash(JSON.stringify(['group', 'a'])), b = hash(JSON.stringify(['group', 'b'])), room = hash('group');
  const f = await fixture(t, { groups: { [a]: { history: [], memory: ['甲的笔记'] }, [b]: { history: [], memory: ['乙的笔记'] } },
    rooms: { [room]: { recent: [{ role: 'user', content: '旧群历史', speaker: 'member_' + a.slice(0,16) }], memory: [], observed: [], assistantSeen: [] } } });
  const save = f.capture.save; f.capture.save = async () => { throw Error('simulated_capture_failure'); };
  await assert.rejects(f.bot.personalMemoryBridge.forget(event('forget', '/forget', 'a', 'group')));
  assert.deepEqual(f.bot.groupContext('group'), []); assert.deepEqual(f.bot.groupMemory('group'), []);
  f.capture.save = save;
  assert.equal(await f.bot.personalMemoryBridge.ensure(event('next', '接着说', 'b', 'group')), true);
  assert.deepEqual(f.bot.personalMemory('group', 'a'), []);
  assert.equal(f.bot.personalMemory('group', 'b')[0].text, '乙的笔记');
});

test('manual memory listing pages expose old notes without sending an oversized message', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 4; index++) await f.send(event('n' + index, '/remember ' + index + '字'.repeat(800)));
  await f.send(event('page1', '/memory')); assert.ok(f.replies.at(-1).length < 1800); assert.match(f.replies.at(-1), /下一页/);
  await f.send(event('page4', '/memory 4')); assert.ok(f.replies.at(-1).length < 1800); assert.match(f.replies.at(-1), /4\/4/);
});

test('failed acknowledgement never claims a committed note edit left the old record unchanged', async t => {
  const f = await fixture(t); await f.send(event('save', '/remember 旧版内容'));
  const note = f.bot.personalMemory(null, 'owner')[0]; let attempts = 0;
  await assert.rejects(f.bot.personalMemoryBridge.amend(event('edit', '/memory-edit ' + note.id + ' 新版内容'), async () => {
    attempts++; throw Error('simulated_delivery_failure');
  }), /simulated_delivery_failure/);
  assert.equal(attempts, 1); assert.equal(f.bot.personalMemory(null, 'owner')[0].text, '新版内容');
});

test('a delayed duplicate save after forgetting does not claim the erased note was newly remembered', async t => {
  const f = await fixture(t); const save = event('save', '/remember 旧版内容');
  await f.bot.personalMemoryBridge.remember(save, async () => {});
  await f.bot.personalMemoryBridge.forget(event('forget', '/forget'));
  await f.bot.personalMemoryBridge.remember(save, async text => f.replies.push(text));
  assert.doesNotMatch(f.replies.at(-1), /^记住了/); assert.deepEqual(f.bot.personalMemory(null, 'owner'), []);
});

test('failed initial forget journal never promises automatic recovery or claims an erased record', async t => {
  const f = await fixture(t); await f.send(event('save', '/remember 保留的笔记'));
  const persist = f.bot.persist.bind(f.bot); let calls = 0;
  f.bot.persist = async () => { if (++calls === 2) throw Error('simulated_journal_failure'); return persist(); };
  await f.send(event('forget', '/forget'));
  assert.match(f.replies.at(-1), /请求还没保存成功/); assert.doesNotMatch(f.replies.at(-1), /已保留清理记录|恢复后会/);
  assert.deepEqual(f.bot.state.pendingPersonalForgets, {});
  assert.equal(f.bot.personalMemory(null, 'owner')[0].text, '保留的笔记');
});

test('committed legacy import stays authoritative when redundant old-array cleanup cannot persist', async t => {
  const f = await fixture(t); f.bot.state.memory = ['旧版通用笔记']; await f.bot.persist();
  const persist = f.bot.persist.bind(f.bot); f.bot.persist = async () => { throw Error('simulated_cleanup_write_failure'); };
  await f.bot.personalMemoryBridge.importScope('private_owner');
  assert.equal(f.bot.personalMemory(null, 'owner').length, 1);
  assert.equal(f.bot.personalMemory(null, 'owner')[0].origin, 'legacy_unverified');
  assert.deepEqual(f.bot.state.memory, ['旧版通用笔记']);
  f.bot.persist = persist;
  const restored = await f.open(); assert.equal(restored.bot.personalMemory(null, 'owner').length, 1);
  assert.deepEqual(restored.bot.state.memory, []);
});
