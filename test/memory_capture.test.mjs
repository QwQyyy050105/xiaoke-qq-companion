import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { MemoryCapture } from '../src/memory_capture.mjs';
import { Companion, hash } from '../src/core.mjs';
import { codexArgs, conversationPrompt, parseChatResponse } from '../src/model_client.mjs';
import { recordInteractionLatency } from '../src/interaction_latency.mjs';

const scope = name => `member_${hash(name)}`;
const room = hash('room-a');
const speaker = 'member_' + hash('a').slice(0, 16);
const message = (id, content, extra = {}) => ({ scope: scope('a'), room, speaker, messageId: id, content, ...extra });
async function fixture(t, options = {}) {
  const base = resolve(process.cwd(), 'temp'), dir = await mkdtemp(join(base, 'capture_test_'));
  const capture = await MemoryCapture.open({ dataDir: dir, ...options });
  t.after(async () => { await capture.close(); assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true }); });
  return { capture, dir };
}

test('clear quoted and comparative preferences persist immediately without a model call', async t => {
  let calls = 0;
  const { capture, dir } = await fixture(t, { extract: async () => { calls++; return { personal: [], room: [] }; } });
  await capture.observe(message('one', '我喜欢“龙娘”这种角色。'));
  await capture.observe(message('two', '比起咖啡，我更爱红茶。'));
  assert.equal(calls, 0); assert.equal(capture.status().accepted, 2);
  const disk = JSON.parse(await readFile(join(dir, 'memory_capture.json'), 'utf8'));
  assert.equal(disk.facts[scope('a')].length, 2);
  const restored = await MemoryCapture.open({ dataDir: dir });
  assert.deepEqual(restored.recall(scope('a')).map(fact => fact.source).sort(), ['我喜欢“龙娘”这种角色。', '比起咖啡，我更爱红茶。'].sort());
  await restored.close();
});

test('names and opposed preferences replace only the same member key', async t => {
  const { capture } = await fixture(t);
  for (const [id, text] of [['a','以后叫我阿白。'],['b','我喜欢咖啡。'],['c','我现在不喜欢咖啡了。'],['d','以后叫我小白。']]) await capture.observe(message(id,text));
  const facts = capture.recall(scope('a'));
  assert.equal(facts.length, 2); assert.ok(facts.some(fact => fact.text === '以后叫我小白。'));
  assert.ok(facts.some(fact => fact.text === '我现在不喜欢咖啡了。'));
  assert.deepEqual(capture.recall(scope('b')), []); assert.deepEqual(capture.recall('private_owner'), []);
});

test('repeated events are deduplicated and opt-outs never become facts or pending review', async t => {
  const { capture } = await fixture(t, { extract: async () => ({ personal: [], room: [] }) });
  assert.equal(await capture.observe(message('one','我喜欢猫。')),true);
  assert.equal(await capture.observe(message('one','我喜欢猫。')),false);
  await capture.observe(message('two','别记这条。我喜欢红茶。'));
  assert.equal(capture.recall(scope('a')).length,1); assert.equal(capture.status().pending,0);
  assert.ok(capture.status().rejectionReasons.opt_out > 0);
});

test('a failed persistence commit cannot publish facts or lose the original state', async t => {
  const { capture } = await fixture(t);
  const save = capture.save;
  capture.save = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(capture.observe(message('one','我喜欢猫。')), /disk unavailable/);
  assert.deepEqual(capture.recall(scope('a')), []); assert.equal(capture.state.seen.length,0);
  capture.save = save; await capture.observe(message('one','我喜欢猫。'));
  assert.equal(capture.recall(scope('a')).length,1);
});

test('foreground activity defers extraction and empty results are recorded distinctly', async t => {
  let busy = true, calls = 0;
  const { capture } = await fixture(t, { isBusy: () => busy, extract: async () => { calls++; return { personal: [], room: [] }; } });
  await capture.observe(message('one','下次接着聊这个问题。'));
  assert.equal(await capture.drain({ force:true }),false); assert.equal(calls,0);
  busy=false; assert.equal(await capture.drain({ force:true }),true);
  assert.equal(capture.status().noChange,1); assert.equal(capture.status().pending,0);
});

test('background review uses actual source IDs and does not attribute another member fact', async t => {
  const { capture } = await fixture(t, { extract: async input => ({ personal:[{text:'我喜欢猫。',source:'我喜欢猫。',speaker:'someone_else',messageId:input.messages[0].messageId}],
    room:[{kind:'request',text:input.messages[0].content,source:input.messages[0].content,speaker:input.messages[0].speaker,messageId:input.messages[0].messageId,operation:'remember',targetId:''}] }) });
  await capture.observe(message('actual-id','下次接着讲极限，还没讲完。'));
  await capture.drain({ force:true });
  assert.deepEqual(capture.recall(scope('a')),[]);
  assert.equal(capture.recallRoom(room)[0].messageId,'actual-id'); assert.equal(capture.status().pending,0);
});

test('forget during an in-flight extraction cannot resurrect erased room memory', async t => {
  let complete;
  const { capture } = await fixture(t, { extract: input => new Promise(resolve => { complete = () => resolve({personal:[],room:[{kind:'request',text:input.messages[0].content,source:input.messages[0].content,speaker:input.messages[0].speaker,messageId:input.messages[0].messageId,operation:'remember',targetId:''}]}); }) });
  await capture.observe(message('one','下次接着讲极限。'));
  const pending=capture.drain({force:true}); await Promise.resolve();
  await capture.forget(scope('a'),room); complete(); await pending;
  assert.deepEqual(capture.recallRoom(room),[]); assert.equal(capture.status().pending,0);
});

test('failed extraction retains the earliest pending messages for a later retry', async t => {
  let now=1000, fail=true;
  const { capture } = await fixture(t, { now:()=>now,extract:async()=>{if(fail)throw Error('model unavailable');return {personal:[],room:[]};} });
  await capture.observe(message('one','下次聊极限。')); await capture.observe(message('two','回头聊导数。'));
  await capture.drain({force:true}); assert.equal(capture.status().pending,2); assert.equal(capture.status().failures,1);
  fail=false; now+=300000; await capture.drain({force:true}); assert.equal(capture.status().pending,0);
});

test('Chinese keyword recall can find an older relevant fact inside a longer question', async t => {
  const { capture } = await fixture(t);
  await capture.observe(message('tea','我喜欢红茶。'));
  for(let i=0;i<20;i++)await capture.observe(message('other'+i,`我喜欢作品第${i}集。`));
  assert.equal(capture.recall(scope('a'),{query:'你还记得我说红茶的事情吗',limit:1})[0].messageId,'tea');
});

test('a corrupt memory file is rejected without replacing it by an empty store', async t => {
  const { dir }=await fixture(t); const file=join(dir,'memory_capture.json'); await writeFile(file,'{broken');
  await assert.rejects(MemoryCapture.open({dataDir:dir})); assert.equal(await readFile(file,'utf8'),'{broken');
});

test('Companion injects new sourced memories and forget removes them in the matching scope', async t => {
  const {capture,dir}=await fixture(t);const seen=[];
  const bot=await new Companion({dataDir:dir,pairingHash:hash('test'),memoryCapture:capture,generate:async input=>{seen.push(input);return {reply:'听见啦。',memories:[]};}}).init();
  const event=(id,content,member='a')=>({id,content,group_openid:'g',author:{member_openid:member}});
  await bot.handle(event('one','我喜欢“龙娘”这种角色。'),async()=>{});
  assert.equal(seen.at(-1).memory[0].source,'我喜欢“龙娘”这种角色。');
  await bot.handle(event('two','接着聊','b'),async()=>{});assert.deepEqual(seen.at(-1).memory,[]);
  await bot.handle(event('forget','/forget'),async()=>{});
  await bot.handle(event('three','接着聊'),async()=>{});assert.deepEqual(seen.at(-1).memory,[]);
});

test('memory extraction has a fixed tool-free schema and excludes unrelated chat material',()=>{
  const args=codexArgs(process.cwd(),{structured:true,memoryCapture:true});
  assert.equal(args[args.indexOf('--output-schema')+1],join(process.cwd(),'src','memory_capture_v2.schema.json'));
  const prompt=conversationPrompt('PRIVATE_PERSONA_SENTINEL',{mode:'memory_capture',messages:[{content:'下次接着聊极限。',speaker,messageId:'real'}],history:[{content:'PRIVATE_HISTORY_SENTINEL'}]});
  assert.doesNotMatch(prompt,/PRIVATE_PERSONA_SENTINEL|PRIVATE_HISTORY_SENTINEL/);assert.match(prompt,/real/);
});

test('fast chat supports null unused actions while the legacy parser still requires memory evidence',async()=>{
  const result={reply:'那我举手站红茶这边。',messages:[],social:null,media:null,delivery:null,math_document:null,expression:{mood:'playful',energy:0.6,continuity:''},speech:null,vocabulary_actions:[]};
  assert.throws(()=>parseChatResponse(JSON.stringify(result)),/invalid_chat_response/);
  assert.equal(parseChatResponse(JSON.stringify(result),{backgroundMemory:true}).reply,result.reply);
  const args=codexArgs(process.cwd(),{structured:true,backgroundMemory:true});
  const schema=JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8'));
  assert.equal('memories' in schema.properties,false);assert.equal('room_memories' in schema.properties,false);
  for(const field of ['media','social','speech','delivery'])assert.equal(schema.properties[field].anyOf[0].type,'null');
  const prompt=conversationPrompt('角色说明',{text:'聊聊红茶',structured:true,backgroundMemory:true});
  assert.doesNotMatch(prompt,/memories单人最多两条|room_memories\.operation|feedback只记录本轮/);
});

test('reply timing measures the real preparation/model/delivery path without treating queue acknowledgements as replies',async t=>{
  const {dir}=await fixture(t);let clock=10000;const rows=[];
  const bot=await new Companion({dataDir:dir,pairingHash:hash('test'),now:()=>clock,onTiming:row=>rows.push(row),
    prepareInput:async()=>{clock+=7;return {};},generate:async()=>{clock+=30;return '接着聊。';}}).init();
  await bot.handle({id:'timed',content:'你好',group_openid:'g',author:{member_openid:'a'},_receivedAt:9000},async()=>{clock+=5;});
  assert.equal(rows.length,1);const row=rows[0];
  assert.deepEqual([row.queue_ms,row.prepare_ms,row.model_ms,row.delivery_ms,row.total_ms],[1000,7,30,5,1042]);
  const resilient=await new Companion({dataDir:dir,pairingHash:hash('test'),onTiming:()=>{throw Error('diagnostic only');},generate:async()=> '照常聊天。'}).init();
  await resilient.handle({id:'not-blocked',content:'你好',group_openid:'g',author:{member_openid:'a'}},async()=>{});
});

test('latency evidence stores only technical counters and never chat or member identity',async t=>{
  const {dir}=await fixture(t);await mkdir(join(dir,'data'));
  await recordInteractionLatency(dir,{at:new Date().toISOString(),is_group:true,queue_ms:2,model_ms:10,total_ms:15,text:'PRIVATE_TEXT_SENTINEL',member_openid:'PRIVATE_ID_SENTINEL'});
  const text=await readFile(join(dir,'data','interaction_latency.json'),'utf8');
  assert.doesNotMatch(text,/PRIVATE_TEXT_SENTINEL|PRIVATE_ID_SENTINEL/);
  assert.equal(JSON.parse(text).summary.model_ms.p50,10);
});
