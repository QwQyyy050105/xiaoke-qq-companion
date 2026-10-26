import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { MemoryCapture } from '../src/memory_capture.mjs';
import { hash } from '../src/core.mjs';

const scope = `member_${hash('correction-member')}`, room = hash('correction-room');
const speaker = `member_${hash('correction-member').slice(0,16)}`;
async function fixture(t) {
  const root = resolve(process.cwd(), 'temp'), dir = await mkdtemp(join(root, 'memory_corrections_'));
  const opened = []; let now = 1000;
  const open = async () => { const capture = await MemoryCapture.open({ dataDir: dir, now: () => now }); opened.push(capture); return capture; };
  const capture = await open();
  t.after(async () => {
    await Promise.all(opened.map(item => item.close())); assert.ok(resolve(dir).startsWith(root + sep));
    await rm(dir, { recursive: true, force: true }); await assert.rejects(access(dir), { code: 'ENOENT' });
  });
  return { capture, open, dir, observe: async (id, content, extra = {}) => {
    now += 1000; return capture.observe({ scope, room, speaker, messageId:id, content, at:new Date(now).toISOString(), ...extra });
  } };
}

test('an explicit old-name rejection plus new-name request replaces the nickname with verbatim evidence', async t => {
  const f = await fixture(t);
  await f.observe('old-name', '以后叫我阿白。');
  await f.observe('new-name', '别叫我阿白了，叫我小白。');
  const restored = await f.open(), facts = restored.recall(scope, { query:'我现在叫什么？' });
  assert.equal(facts.length, 1); assert.equal(facts[0].kind, 'nickname');
  assert.equal(facts[0].text, '别叫我阿白了，叫我小白。');
  assert.equal(facts[0].source, facts[0].text); assert.equal(facts[0].messageId, 'new-name'); assert.equal(facts[0].speaker, speaker);
  assert.equal(facts[0].replaces, undefined, 'retired facts are audit evidence, not active prompt memory');
  const saved = JSON.parse(await readFile(join(f.dir, 'memory_capture.json'), 'utf8')).facts[scope][0];
  assert.deepEqual(saved.replaces.map(({source,messageId}) => ({source,messageId})), [{source:'以后叫我阿白。',messageId:'old-name'}]);
});

test('limited food and drink action normalization permits explicit preference reversals', async t => {
  const f = await fixture(t);
  await f.observe('coffee-old', '我更喜欢喝咖啡。'); await f.observe('coffee-new', '我现在不喜欢咖啡了。');
  await f.observe('noodles-old', '我喜欢吃面条。'); await f.observe('noodles-new', '我现在讨厌面条。');
  const facts = (await f.open()).recall(scope);
  assert.deepEqual(facts.map(item => item.source).sort(), ['我现在不喜欢咖啡了。','我现在讨厌面条。'].sort());
  assert.deepEqual(new Set(facts.map(item => item.key)), new Set(['preference:咖啡','preference:面条']));
});

test('reversing the same comparative pair retires its old ranking without touching another pair', async t => {
  const f = await fixture(t);
  await f.observe('tea-first', '比起咖啡，我更爱红茶。');
  await f.observe('other-pair', '比起绿茶，我更爱红茶。');
  await f.observe('coffee-now', '比起红茶，我更爱咖啡。');
  const facts = (await f.open()).recall(scope, { query:'咖啡和红茶我现在更喜欢哪个？' });
  assert.equal(facts.length, 2);
  assert.ok(facts.some(item => item.source === '比起红茶，我更爱咖啡。'));
  assert.ok(facts.some(item => item.source === '比起绿茶，我更爱红茶。'));
  assert.ok(!facts.some(item => item.source === '比起咖啡，我更爱红茶。'));
});

test('new corrections can replace legacy keys already saved before canonicalization existed', async t => {
  const f = await fixture(t);
  await f.observe('old-coffee', '我更喜欢喝咖啡。'); await f.observe('old-ranking', '比起咖啡，我更爱红茶。');
  await f.capture.transaction(state => {
    state.facts[scope][0].key = 'preference:喝咖啡';
    state.facts[scope][1].key = 'preference:比起咖啡我更爱红茶';
  });
  await f.observe('new-coffee', '我现在不喜欢咖啡了。'); await f.observe('new-ranking', '比起红茶，我更爱咖啡。');
  assert.deepEqual(f.capture.recall(scope).map(item => item.source).sort(), ['我现在不喜欢咖啡了。','比起红茶，我更爱咖啡。'].sort());
});

test('action normalization never merges preparation, qualified drinks, ambiguous brands or distinct symbols', async t => {
  const f = await fixture(t);
  const messages = ['我喜欢做咖啡。','我不喜欢咖啡。','我喜欢热咖啡。','我喜欢冰咖啡。',
    '我喜欢苹果。','我不喜欢吃苹果。','比起C，我更喜欢C++。','比起C，我更喜欢C#。'];
  for (let index=0;index<messages.length;index++) await f.observe(String(index),messages[index]);
  assert.deepEqual(f.capture.recall(scope).map(item => item.source).sort(), messages.sort());
});

test('literal preference symbols stay distinct even when an old key stripped those symbols', async t => {
  const f = await fixture(t);
  await f.observe('cpp', '我喜欢C++。');
  await f.capture.transaction(state => { state.facts[scope][0].key = 'preference:c'; });
  await f.observe('csharp', '我不喜欢C#。');
  const facts = (await f.open()).recall(scope);
  assert.deepEqual(facts.map(item => item.source).sort(), ['我喜欢C++。', '我不喜欢C#。'].sort());
  assert.equal(facts.find(item => item.source === '我不喜欢C#。').key, 'preference:c#');
});

test('third-party, quoted, hypothetical and opt-out name corrections cannot overwrite the owner statement', async t => {
  const f = await fixture(t); await f.observe('actual-name','以后叫我阿白。');
  for (const [index, text] of ['他说：“别叫我阿白了，叫我小白。”','如果别叫我阿白了，叫我小白。',
    '“别叫我阿白了，叫我小白。”','别记这句。别叫我阿白了，叫我小白。','别叫他阿白了，叫他小白。'].entries()) await f.observe('not-own-'+index,text);
  assert.deepEqual(f.capture.recall(scope).map(item => item.source), ['以后叫我阿白。']);
});

test('corrections and trace remain scoped, forget erases them across restart, and trace chains do not grow recursively', async t => {
  const f = await fixture(t), otherScope = `member_${hash('other-member')}`;
  await f.observe('first','以后叫我阿白。'); await f.observe('second','别叫我阿白了，叫我小白。');
  await f.observe('third','不要再叫我小白了，改叫我白白。');
  await f.observe('other','以后叫我阿白。',{scope:otherScope,speaker:`member_${hash('other-member').slice(0,16)}`});
  const saved = JSON.parse(await readFile(join(f.dir,'memory_capture.json'),'utf8'));
  assert.equal(saved.facts[scope][0].replaces.length,1); assert.equal(saved.facts[scope][0].replaces[0].replaces,undefined);
  assert.equal(f.capture.recall(otherScope)[0].text,'以后叫我阿白。'); assert.deepEqual(f.capture.recall('private_owner'),[]);
  await f.capture.forget(scope,room);
  const restored = await f.open(); assert.deepEqual(restored.recall(scope),[]); assert.equal(restored.recall(otherScope).length,1);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(f.dir,'memory_capture.json'),'utf8')).facts,scope),false);
});
