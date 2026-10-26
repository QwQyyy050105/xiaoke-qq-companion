import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { MemoryCapture } from '../src/memory_capture.mjs';
import { personalUpdateIntent, personalUpdateTargets, inspectPersonalUpdates } from '../src/personal_memory_updates.mjs';
import { hash } from '../src/core.mjs';

const scope = `member_${hash('semantic-memory-member')}`, room = hash('semantic-memory-room');
const speaker = `member_${hash('semantic-memory-member').slice(0,16)}`;
const otherScope = `member_${hash('semantic-other-member')}`, otherSpeaker = `member_${hash('semantic-other-member').slice(0,16)}`;
const response = updates => ({ personal: [], personal_updates: updates, room: [] });
const amendment = (target, message, operation = 'update') => ({ operation, kind: target.kind, targetId: target.id,
  targetSource: target.source, source: message.content, text: message.content, speaker: message.speaker, messageId: message.messageId });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { extract, save } = {}) {
  const root = resolve(process.cwd(), 'temp'), dir = await mkdtemp(join(root, 'personal_memory_updates_'));
  const instances = []; let time = 1000, input, handler = extract || (async () => response([]));
  const open = async () => { const capture = await MemoryCapture.open({ dataDir: dir, now: () => time, save,
    extract: async args => { input = args; return handler(args); } }); instances.push(capture); return capture; };
  const capture = await open();
  t.after(async () => {
    await Promise.all(instances.map(item => item.close())); assert.ok(resolve(dir).startsWith(root + sep));
    await rm(dir, { recursive: true, force: true }); await assert.rejects(access(dir), { code:'ENOENT' });
  });
  return { capture, open, dir, setExtract: fn => { handler = fn; }, input: () => input,
    advance: (amount = 1000) => { time += amount; },
    observe: async (id, content, extra = {}) => {
      time += 1000; return capture.observe({ scope, room, speaker, messageId:id, content, at:new Date(time).toISOString(), ...extra });
    } };
}

for (const [label, before, after] of [
  ['different literal preference key', '我喜欢打羽毛球。', '我不喜欢打羽毛球了，最近改玩网球。'],
  ['ended project', '我在准备考研。', '我已经不准备考研了，改准备考公。'],
  ['retired hobby', '我喜欢泰拉瑞亚。', '我已经退坑泰拉瑞亚了。'],
]) test(`background correction reconciles ${label} with exact evidence`, async t => {
  const f = await fixture(t); await f.observe('old', before); const oldId = f.capture.recall(scope)[0].id;
  await f.observe('new', after); assert.equal(f.capture.status().pending, 1, 'review queues even when the immediate path accepted the new wording');
  f.setExtract(async args => response([amendment(args.existingPersonalTargets.find(fact => fact.source === before), args.messages[0])]));
  assert.equal(await f.capture.drain({force:true}), true);
  const facts = f.capture.recall(scope); assert.equal(facts.length, 1);
  assert.equal(facts[0].text, after); assert.equal(facts[0].source, after); assert.equal(facts[0].messageId, 'new');
  assert.equal(facts[0].speaker, speaker); assert.equal(facts[0].replaces, undefined);
  const stored = JSON.parse(await readFile(join(f.dir, 'memory_capture.json'), 'utf8')).facts[scope];
  assert.equal(stored.length, 1); assert.equal(stored[0].replaces[0].source, before); assert.equal(stored[0].replaces[0].id,oldId);
  assert.equal(stored[0].replaces[0].replaces, undefined); assert.equal((await f.open()).recall(scope)[0].source, after);
});

test('a rekeyed semantic replacement keeps unique active IDs when an old interest returns',async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢打羽毛球。'); const oldId=f.capture.recall(scope)[0].id;
  await f.observe('change','我不喜欢打羽毛球了，最近改玩网球。');
  f.setExtract(async args=>response([amendment(args.existingPersonalTargets.find(row=>row.id===oldId),args.messages[0])]));
  await f.capture.drain({force:true}); const replacement=f.capture.recall(scope)[0]; assert.notEqual(replacement.id,oldId);
  await f.observe('returned','我喜欢打羽毛球。'); const facts=f.capture.recall(scope);
  assert.equal(facts.length,2); assert.equal(new Set(facts.map(row=>row.id)).size,2);
  assert.equal(facts.find(row=>row.messageId==='returned').id,oldId);
  assert.equal(f.capture.state.facts[scope].find(row=>row.id===replacement.id).replaces[0].id,oldId);
});

test('future source canonicalization cannot make a retained legacy ID collide with a newly added fact',async t=>{
  const f=await fixture(t); await f.observe('old','我在准备考研。'); const oldId=f.capture.recall(scope)[0].id;
  await f.observe('change','我已经不准备考研了，改准备考公。');
  f.setExtract(async args=>response([amendment(args.existingPersonalTargets[0],args.messages[0])]));
  await f.capture.drain({force:true}); assert.equal(f.capture.recall(scope)[0].id,oldId);
  // Simulate a persisted legacy row whose evidence now canonicalizes under a
  // new key after an upgrade, while its original ID and key still exist.
  await f.capture.transaction(state=>{const row=state.facts[scope][0];row.source=row.text='我在准备考公。';});
  await f.observe('return','我在准备考研。'); const facts=f.capture.recall(scope);
  assert.equal(facts.length,2); assert.equal(new Set(facts.map(row=>row.id)).size,2);
  assert.equal(facts.find(row=>row.messageId==='change').id,oldId);
  assert.notEqual(facts.find(row=>row.messageId==='return').id,oldId);
});

test('ordinary additional preference does not schedule correction or retire another interest', async t => {
  const f = await fixture(t); await f.observe('first', '我喜欢打羽毛球。'); await f.observe('second', '我喜欢打网球。');
  assert.equal(f.capture.status().pending, 0);
  const facts = f.capture.state.facts[scope], message = { speaker, messageId:'second',content:'我喜欢打网球。',observedOrder:2 };
  const inspected = inspectPersonalUpdates(facts, [amendment(facts[0],message)],message,{targets:personalUpdateTargets(facts)});
  assert.equal(inspected.applied, 0); assert.deepEqual(inspected.facts,facts);
  assert.deepEqual(f.capture.recall(scope).map(f=>f.source).sort(),['我喜欢打羽毛球。','我喜欢打网球。'].sort());
});

test('correction catalog includes targets older than the normal sixteen recalled facts', async t => {
  const f = await fixture(t); const old = '我喜欢打羽毛球。'; await f.observe('old',old);
  for (let i=0;i<24;i++) await f.observe(`interest-${i}`,`我喜欢作品第${i}部。`);
  await f.observe('correction','我已经不打羽毛球了，改玩网球。');
  f.setExtract(async args => {
    assert.ok(!args.existingMemory.some(row => row.source === old)); assert.ok(args.existingPersonalTargets.some(row => row.source === old));
    assert.ok(args.existingPersonalTargets.length <= 64);
    return response([amendment(args.existingPersonalTargets.find(row => row.source===old),args.messages[0])]);
  });
  await f.capture.drain({force:true}); assert.ok(!f.capture.recall(scope,{limit:64,maxChars:20000}).some(row=>row.source===old));
});

for (const content of ['他说我已经退坑泰拉瑞亚了。','如果我已经退坑泰拉瑞亚了。','“我已经退坑泰拉瑞亚了。”',
  '不要保存这句。我已经退坑泰拉瑞亚了。','我已经不喜欢泰拉瑞亚了，密码换成了测试内容。',
  '更正一下，我朋友已经退坑泰拉瑞亚了。','更正一下，我听说小明已经退坑泰拉瑞亚了。']) {
  test(`quoted, reported, hypothetical, sensitive or opted-out correction cannot mutate: ${content}`, async t => {
    const f = await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); const facts=structuredClone(f.capture.state.facts[scope]);
    const message={speaker,messageId:'invalid',content,observedOrder:2};
    const proposal=amendment(facts[0],message); proposal.source=proposal.text=content.includes('我已经退坑泰拉瑞亚了。') ? '我已经退坑泰拉瑞亚了。' : content;
    const inspected=inspectPersonalUpdates(facts,[proposal],message,{targets:personalUpdateTargets(facts)});
    assert.equal(inspected.applied,0); assert.deepEqual(inspected.facts,facts);
  });
}

test('model cannot invent evidence, select a different owner, or change source identity', async t => {
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。');
  await f.observe('foreign','我喜欢打羽毛球。',{scope:otherScope,speaker:otherSpeaker});
  const facts=f.capture.state.facts[scope], target=facts[0], foreign=f.capture.state.facts[otherScope][0];
  const message={speaker,messageId:'new',content:'我已经退坑泰拉瑞亚了。',observedOrder:3};
  for (const proposal of [
    {...amendment(target,message),text:'我不喜欢泰拉瑞亚。',source:'我不喜欢泰拉瑞亚。'},
    {...amendment(target,message),targetSource:'我曾经喜欢游戏。'},
    {...amendment(target,message),speaker:otherSpeaker}, {...amendment(target,message),messageId:'foreign'},
    amendment(foreign,message), {...amendment(target,message),kind:'nickname'},
  ]) {
    const inspected=inspectPersonalUpdates(facts,[proposal],message,{targets:personalUpdateTargets([...facts,foreign])});
    assert.equal(inspected.applied,0); assert.deepEqual(inspected.facts,facts);
  }
});

for (const content of ['小明不喜欢我推荐的泰拉瑞亚了。','小明已经退坑我喜欢的泰拉瑞亚了。',
  '更正一下，小明已经退坑我喜欢的泰拉瑞亚了。','我在玩泰拉瑞亚，小明已经退坑我推荐的游戏了。',
  '我在听小明讲他已经退坑泰拉瑞亚了。','我正在看小明写他不喜欢泰拉瑞亚了。',
  '我听小明说他已经退坑泰拉瑞亚了。','我在看别人说已经退坑泰拉瑞亚了。',
  '我喜欢看小明改玩泰拉瑞亚。','更正一下，我正在读小明写他已经退坑泰拉瑞亚了。']) {
  test(`embedded first-person reference is not an owner proposition: ${content}`,async t=>{
    const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); const facts=structuredClone(f.capture.state.facts[scope]);
    assert.equal(personalUpdateIntent(content).review,false);
    const message={speaker,messageId:'invalid-owner',content,observedOrder:2};
    const inspected=inspectPersonalUpdates(facts,[amendment(facts[0],message)],message,{targets:personalUpdateTargets(facts)});
    assert.equal(inspected.applied,0); assert.deepEqual(inspected.facts,facts);
  });
}

for (const content of ['小柯，我已经退坑泰拉瑞亚了。','小柯 晚上好，我已经退坑泰拉瑞亚了。',
  '你好，小柯，我已经退坑泰拉瑞亚了。','小柯 我已经退坑泰拉瑞亚了。','更正一下，我现在改玩网球了。',
  '我不准备考研了。','我最近在改做个人项目。','我已经不看泰拉瑞亚实况了。','以后回复别长篇，我改主意了。',
  '更正一下，我喜欢打网球。']) {
  test(`greeting or correction prelude preserves a genuine owner proposition: ${content}`,async t=>{
    const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); const facts=structuredClone(f.capture.state.facts[scope]);
    assert.equal(personalUpdateIntent(content).review,true);
    const message={speaker,messageId:'own-update',content,observedOrder:2};
    const inspected=inspectPersonalUpdates(facts,[amendment(facts[0],message)],message,{targets:personalUpdateTargets(facts),now:3000});
    assert.equal(inspected.applied,1); assert.equal(inspected.facts[0].source,content);
  });
}

test('a delete request about another person cannot bind an embedded owner reference',async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); const facts=structuredClone(f.capture.state.facts[scope]);
  for(const content of ['忘掉小明喜欢我推荐的泰拉瑞亚那条。','忘掉我在听小明讲他退坑泰拉瑞亚那条。','忘掉我正在看小明写他不喜欢泰拉瑞亚那条。']) {
    const message={speaker,messageId:'invalid-delete',content,observedOrder:2};
    assert.equal(personalUpdateIntent(content).deletion,false);
    assert.equal(inspectPersonalUpdates(facts,[amendment(facts[0],message,'delete')],message,{targets:personalUpdateTargets(facts)}).applied,0);
  }
});

for (const command of ['忘掉我喜欢泰拉瑞亚那条。','别再记我喜欢泰拉瑞亚。']) test(`targeted forgetting bypasses blanket opt-out safely: ${command}`,async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); await f.observe('unrelated','我喜欢打羽毛球。');
  const target=f.capture.state.facts[scope][0];
  await f.capture.transaction(state=>{state.facts[scope][1].replaces=[{id:target.id,source:target.source}];});
  await f.observe('delete',command); assert.equal(f.capture.status().pending,1);
  f.setExtract(async args=>response([amendment(args.existingPersonalTargets.find(row=>row.id===target.id),args.messages[0],'delete')]));
  await f.capture.drain({force:true}); const restored=await f.open();
  assert.deepEqual(restored.recall(scope).map(row=>row.source),['我喜欢打羽毛球。']);
  const raw=await readFile(join(f.dir,'memory_capture.json'),'utf8'); assert.ok(!raw.includes(target.source)); assert.ok(!raw.includes(command));
  assert.equal(restored.state.facts[scope][0].replaces,undefined);
});

test('blanket opt-out and negated deletion never queue targeted forgetting',async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。');
  for(const [i,source] of ['不要保存这句，忘掉我喜欢泰拉瑞亚那条。','不要忘掉我喜欢泰拉瑞亚那条。','能不能忘掉我喜欢泰拉瑞亚那条？'].entries()) {
    assert.equal(personalUpdateIntent(source).review,false); await f.observe(`invalid-${i}`,source);
  }
  // The legacy broad review queue may inspect a non-opt-out question, but no
  // target catalog or semantic mutation is enabled by that question.
  f.setExtract(async args=>{assert.deepEqual(args.existingPersonalTargets,[]);return response([]);});
  await f.capture.drain({force:true}); assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['我喜欢泰拉瑞亚。']);
});

test('describing personal forgetfulness is not an instruction to delete stored facts',async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); const target=f.capture.state.facts[scope][0];
  for(const content of ['我忘记泰拉瑞亚怎么玩了。','我已经忘掉泰拉瑞亚的操作了。']) {
    const message={speaker,messageId:'forgetful',content,observedOrder:2};
    assert.equal(personalUpdateIntent(content).deletion,false);
    assert.equal(inspectPersonalUpdates([target],[amendment(target,message,'delete')],message,{targets:[target]}).applied,0);
  }
});

test('newer immediate fact present before extraction rejects an older queued correction',async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); await f.observe('pending','我已经退坑泰拉瑞亚了。');
  await f.observe('latest','我现在喜欢泰拉瑞亚。');
  f.setExtract(async args=>response([amendment(args.existingPersonalTargets.find(row=>row.messageId==='latest'),args.messages[0])]));
  await f.capture.drain({force:true}); assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['我现在喜欢泰拉瑞亚。']);
  assert.equal(f.capture.status().rejectionReasons.personal_update_source_older_than_target,1);
});

test('delayed ordinary extraction also cannot replace a newer same-key immediate fact',async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。');
  await f.observe('pending','小柯，我不喜欢泰拉瑞亚了。'); await f.observe('latest','我现在喜欢泰拉瑞亚。');
  f.setExtract(async args=>({personal:[{text:'我不喜欢泰拉瑞亚了。',source:'我不喜欢泰拉瑞亚了。',speaker,messageId:'pending'}],personal_updates:[],room:[]}));
  await f.capture.drain({force:true}); assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['我现在喜欢泰拉瑞亚。']);
  assert.ok(f.capture.status().rejectionReasons.stale_source>=1);
});

test('snapshot conflicts reject an update when a newer fact arrives during extraction',async t=>{
  const entered=deferred(), release=deferred(); const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。');
  await f.observe('pending','我已经退坑泰拉瑞亚了。');
  f.setExtract(async args=>{entered.resolve();await release.promise;return response([amendment(args.existingPersonalTargets[0],args.messages[0])]);});
  const draining=f.capture.drain({force:true}); await entered.promise; await f.observe('latest','我现在喜欢泰拉瑞亚。'); release.resolve(); await draining;
  assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['我现在喜欢泰拉瑞亚。']);
  assert.equal(f.capture.status().rejectionReasons.personal_update_target_changed,1);
});

test('forget while extraction is in flight prevents a late update from restoring any fact',async t=>{
  const entered=deferred(), release=deferred(); const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。');
  await f.observe('pending','我已经退坑泰拉瑞亚了。');
  f.setExtract(async args=>{entered.resolve();await release.promise;return response([amendment(args.existingPersonalTargets[0],args.messages[0])]);});
  const draining=f.capture.drain({force:true}); await entered.promise; await f.capture.forget(scope,room); release.resolve(); await draining;
  assert.deepEqual(f.capture.recall(scope),[]); assert.deepEqual((await f.open()).recall(scope),[]);
});

test('only the latest correction for one target within the pending batch applies',async t=>{
  const f=await fixture(t); await f.observe('old','我在准备考研。');
  await f.observe('first','我已经不准备考研了，改准备考公。'); await f.observe('latest','更正一下，我现在不准备考研了，改准备雅思。');
  f.setExtract(async args=>response(args.messages.map(message=>amendment(args.existingPersonalTargets[0],message))));
  await f.capture.drain({force:true}); assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['更正一下，我现在不准备考研了，改准备雅思。']);
  assert.equal(f.capture.status().personalUpdates,1);
});

for(const invalid of ['wrong kind','quoted source','missing source']) test(`later ${invalid} proposal cannot suppress an earlier valid correction`,async t=>{
  const f=await fixture(t); await f.observe('old','我在准备考研。');
  const first='我已经不准备考研了，改准备考公。';
  await f.observe('valid',first); await f.observe('invalid',invalid==='quoted source' ? '“我已经不准备考研了，改准备雅思。”' : '我已经不准备考研了，改准备雅思。');
  f.setExtract(async args=>{
    const target=args.existingPersonalTargets[0],later=amendment(target,args.messages[1]);
    if(invalid==='wrong kind') later.kind='nickname';
    if(invalid==='quoted source') later.text=later.source='我已经不准备考研了，改准备雅思。';
    if(invalid==='missing source') later.text=later.source='我已经不准备考研了，改准备托福。';
    return response([amendment(target,args.messages[0]),later]);
  });
  await f.capture.drain({force:true}); assert.deepEqual(f.capture.recall(scope).map(row=>row.source),[first]);
  assert.equal(f.capture.status().personalUpdates,1); assert.equal(f.capture.status().pending,0);
});

test('a stale earlier proposal does not block the newer evidence-backed correction in the same batch',async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); await f.observe('stale','我已经退坑泰拉瑞亚了。');
  await f.observe('new-fact','我现在喜欢泰拉瑞亚。'); await f.observe('latest','我不再玩泰拉瑞亚了。');
  f.setExtract(async args=>response(args.messages.map(message=>amendment(args.existingPersonalTargets.find(row=>row.messageId==='new-fact'),message))));
  await f.capture.drain({force:true}); assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['我不再玩泰拉瑞亚了。']);
  assert.equal(f.capture.status().personalUpdates,1); assert.equal(f.capture.status().rejectionReasons.personal_update_source_older_than_target,1);
});

test('latest-valid preselection still rejects both captured revisions changed during extraction',async t=>{
  const entered=deferred(),release=deferred(),f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。');
  await f.observe('first','我已经退坑泰拉瑞亚了。'); await f.observe('second','我不再玩泰拉瑞亚了。');
  f.setExtract(async args=>{entered.resolve();await release.promise;return response(args.messages.map(message=>amendment(args.existingPersonalTargets[0],message)));});
  const draining=f.capture.drain({force:true}); await entered.promise; await f.observe('newest','我现在喜欢泰拉瑞亚。');release.resolve();await draining;
  assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['我现在喜欢泰拉瑞亚。']);
  assert.equal(f.capture.status().personalUpdates,0);assert.equal(f.capture.status().rejectionReasons.personal_update_target_changed,2);
});

test('failed atomic commit leaves earlier facts visible and pending retry durable',async t=>{
  const f=await fixture(t); await f.observe('old','我喜欢泰拉瑞亚。'); await f.observe('pending','我已经退坑泰拉瑞亚了。');
  f.setExtract(async args=>response([amendment(args.existingPersonalTargets[0],args.messages[0])]));
  const original=f.capture.save; let fail=true; f.capture.save=async state=>{if(fail){fail=false;throw new Error('test_commit_failure');}return original(state);};
  assert.equal(await f.capture.drain({force:true}),false);
  assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['我喜欢泰拉瑞亚。']); assert.equal(f.capture.status().pending,1);
  assert.deepEqual((await f.open()).recall(scope).map(row=>row.source),['我喜欢泰拉瑞亚。']);
  f.advance(3600001); assert.equal(await f.capture.drain({force:true}),true);
  assert.deepEqual(f.capture.recall(scope).map(row=>row.source),['我已经退坑泰拉瑞亚了。']);
});

test('legacy facts allow only time-proven updates and never assume a missing timestamp is safe',()=>{
  const fact={id:'fact_legacy',kind:'preference',key:'preference:泰拉瑞亚',source:'我喜欢泰拉瑞亚。',text:'我喜欢泰拉瑞亚。',speaker,messageId:'old',savedAt:new Date(2000).toISOString()};
  for(const [observedAt,expected] of [[new Date(3000).toISOString(),1],[new Date(1000).toISOString(),0],[undefined,0]]) {
    const message={speaker,messageId:'new',content:'我已经退坑泰拉瑞亚了。',observedAt};
    assert.equal(inspectPersonalUpdates([fact],[amendment(fact,message)],message,{targets:[fact],now:4000}).applied,expected);
  }
});
