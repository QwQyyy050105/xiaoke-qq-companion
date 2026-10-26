import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService,channelArgs,channelRequest,sanitizeChannelResult} from '../src/channel_service.mjs';
import {channelShortcutStep,channelShortcutSummary,classifyShortcutResult,shortcutRequestHash,validateShortcutRequest} from '../src/channel_shortcuts.mjs';
import {deliveryPlan} from '../src/delivery_plan.mjs';

const recorded=JSON.parse(await fs.readFile(new URL('./fixtures/channel_shortcut_receipts.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
const event=(content,id='event')=>({id,content,author:{user_openid:'owner'}});
const plan=(action,parameters)=>({action,parameters_json:JSON.stringify(parameters),reply:'合成说明'});
const waiting=()=>clone(recorded.waiting);
const doneRead=()=>clone(recorded.done);
const doneWrite=()=>({success:true,data:{status:'done',result:{success:true}}});
const postWaiting=()=>({success:true,data:{status:'waiting',id:'s-synthetic-read',pending:{type:'pick',options:[{_index:0,feed_id:'synthetic-feed',guild_id:'123',title:'合成帖子 A'}],resume_command:'do not execute'}}});
const boardWaiting=()=>({success:true,data:{status:'waiting',id:'s-synthetic-read',step:'2/3',pending:{type:'pick',options:[{_index:0,guild_id:'123',channel_id:'456',name:'合成版块 B'}],resume_command:'do not execute'}}});
const pendingChild=(service,sourceId)=>Object.entries(service.state.proposals).find(([,p])=>p.resume?.sourceId===sourceId&&p.status==='pending')?.[0];
const sourceId=service=>Object.entries(service.state.proposals).find(([,p])=>!p.resume)?.[0];
const selection=(id,value=0)=>event(`/channel-resume ${id} pick ${value}`);
const confirm=id=>event('/channel-confirm '+id);
async function fixture(t,action,parameters,responses,{generate}={}){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_shortcuts_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  const calls=[],replies=[],generation=[];let service;
  const run=async args=>{calls.push(args);const saved=JSON.parse(await fs.readFile(service.path,'utf8'));assert.ok(Object.values(saved.proposals).some(p=>p.status==='executing'));const next=responses.shift();if(next instanceof Error)throw next;return typeof next==='function'?next(args):clone(next);};
  const generator=async input=>{generation.push(input);return generate?generate(input):input.channelCommands.length?plan(action,parameters):{action:'finish',parameters_json:'{}',reply:'基于真实详情的合成摘要'};};
  service=await new ChannelService({root,getOwner:()=> 'owner',run,generate:generator}).init();
  const send=text=>{replies.push(text);return {sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic-message'}]};};
  t.after(async()=>{await service.stop();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  return {service,root,calls,replies,generation,send,run,generator};
}
async function begin(f){await f.service.process(event('看看腾讯频道123相关内容','initial'),f.send);return sourceId(f.service);}

for(const action of ['feed.latest-feeds-detail','feed.hot-feeds-detail'])test(action+' persists real read-envelope shape, selects without write approval and summarizes actual details',async t=>{
  const f=await fixture(t,action,{count:2},[waiting(),doneRead()]),id=await begin(f);
  assert.equal(f.service.state.proposals[id].status,'waiting');assert.equal(f.calls.length,1);assert.match(f.replies.at(-1),/合成频道 A/);
  assert.equal(f.generation[0].channelCommands.find(c=>c.name===action).risk,'read');
  await f.service.process(selection(id),f.send);
  assert.equal(f.calls.length,2);assert.ok(f.calls[1].includes('--count=2'));assert.ok(!f.calls.flat().includes('--yes'));assert.equal(f.service.state.proposals[id].status,'completed');
  assert.equal(f.generation.at(-1).channelCommands.length,0);assert.equal(f.generation.at(-1).channelTrace[0].result.data.result.feeds[0].feed.content,'合成正文');
  assert.equal(f.replies.at(-1),'基于真实详情的合成摘要');
  await f.service.process(selection(id),f.send);assert.equal(f.calls.length,2);
});

test('read selection survives restart without refetching the initial list',async t=>{
  const f=await fixture(t,'feed.latest-feeds-detail',{count:2},[waiting(),doneRead()]),id=await begin(f);
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',run:f.run,generate:f.generator}).init();
  await restored.process(selection(id),f.send);assert.equal(f.calls.length,2);assert.equal(restored.state.proposals[id].status,'completed');await restored.stop();
});

for(const [action,parameters,receipt,label]of[
  ['manage.search-and-join',{keyword:'合成'},waiting(),'合成频道 A'],
  ['feed.search-and-comment',{'guild-id':'123',query:'合成',content:'原文\n保留 $() 和 ; 字符'},postWaiting(),'合成帖子 A']
])test(action+' binds a concrete target and original body before the committing pick',async t=>{
  const f=await fixture(t,action,parameters,[receipt,doneWrite()]),id=await begin(f);
  await f.service.process(selection(id),f.send);assert.equal(f.calls.length,1);const child=pendingChild(f.service,id);assert.ok(child);assert.match(f.replies.at(-1),new RegExp(label));
  if(parameters.content)assert.ok(f.replies.at(-1).includes(parameters.content));
  await f.service.executeShortcutResume(event('unconfirmed'),child,f.send);assert.equal(f.calls.length,1);
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);assert.ok(f.calls[1].includes('--yes'));if(parameters.content)assert.ok(f.calls[1].includes('--content='+parameters.content));
  assert.equal(f.service.state.proposals[id].status,'completed');await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);
});

test('quick publish guild selection is read-only and board selection binds guild, board and every body option before publish',async t=>{
  const params={content:'确定正文',title:'确定标题',link:['https://example.invalid/|资料']};
  const f=await fixture(t,'feed.quick-publish',params,[waiting(),boardWaiting(),doneWrite()]),id=await begin(f);
  await f.service.process(selection(id),f.send);assert.equal(f.calls.length,2);assert.ok(!f.calls[1].includes('--yes'));assert.equal(f.service.state.proposals[id].steps[0].target.kind,'guild');
  await f.service.process(selection(id),f.send);assert.equal(f.calls.length,2);const child=pendingChild(f.service,id);assert.ok(child);
  for(const text of ['合成频道 A','合成版块 B','确定正文','确定标题','https://example.invalid/|资料'])assert.ok(f.replies.at(-1).includes(text));
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,3);assert.ok(f.calls[2].includes('--yes'));assert.equal(f.service.state.proposals[id].status,'completed');
});

for(const [label,change]of[
  ['starts at board phase',r=>{r.data.step='2/3';r.data.pending.options[0].channel_id='456';}],
  ['claims guild phase with board fields',r=>{r.data.pending.options[0].channel_id='456';}],
  ['missing phase',r=>{delete r.data.step;}],
  ['unrecognized phase',r=>{r.data.step='choose-board';}]
])test('quick publish '+label+' is preserved but never auto-picked',async t=>{
  const receipt=waiting();change(receipt);const f=await fixture(t,'feed.quick-publish',{content:'原文'},[receipt]),id=await begin(f);await f.service.process(selection(id),f.send);assert.equal(f.calls.length,1);assert.equal(f.service.state.proposals[id].status,'waiting');assert.equal(pendingChild(f.service,id),undefined);
});

test('quick publish does not accept a repeated or missing board phase after the saved guild selection',async t=>{
  for(const phase of ['1/3',undefined,'3/3']){
    const next=boardWaiting();if(phase===undefined)delete next.data.step;else next.data.step=phase;
    const f=await fixture(t,'feed.quick-publish',{content:'原文'},[waiting(),next]),id=await begin(f);await f.service.process(selection(id),f.send);await f.service.process(selection(id),f.send);assert.equal(f.calls.length,2);assert.equal(pendingChild(f.service,id),undefined);
  }
});

test('8000-character comment is completely reviewed across delivered pages before confirmation, including after restart',async t=>{
  const content='字'.repeat(7900)+'结尾🦊'.repeat(25),f=await fixture(t,'feed.search-and-comment',{'guild-id':'123',query:'合成',content},[postWaiting(),doneWrite()]),id=await begin(f),pages=[];
  const limitedSend=text=>{
    const actual=deliveryPlan(text,{used:3,limit:4}).texts;
    assert.equal(actual.length,1);assert.equal(actual[0],text.trim());
    if(text.startsWith('频道续接草稿（'))pages.push(text);
    return {sent_text:actual.join('\n\n'),delivered_messages:actual.map((part,index)=>({content:part,messageId:'synthetic-'+index}))};
  };
  await f.service.process(selection(id),limitedSend);const child=pendingChild(f.service,id),draft=f.service.state.proposals[child];assert.ok(draft.reviewProgress.pageCount>4);assert.equal(draft.reviewProgress.nextPage,1);assert.ok(!pages[0].includes('/channel-confirm'));
  await f.service.process(confirm(child),limitedSend);assert.equal(f.calls.length,1);
  await f.service.process(event(`/channel-review ${child} ${draft.reviewProgress.pageCount}`),limitedSend);assert.equal(draft.reviewProgress.nextPage,1);
  await f.service.process(event(`/channel-review ${child} 2`),limitedSend);
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',run:f.run,generate:f.generator}).init();assert.equal(restored.state.proposals[child].reviewProgress.nextPage,2);
  for(let page=3;page<=draft.reviewProgress.pageCount;page++)await restored.process(event(`/channel-review ${child} ${page}`),limitedSend);
  const body=pages.map(value=>value.slice(value.indexOf('：\n')+2,value.lastIndexOf('\n\n'))).join('');assert.equal(body,draft.resume.review);assert.ok(pages.at(-1).includes('/channel-confirm '+child));
  await restored.process(confirm(child),limitedSend);assert.equal(f.calls.length,2);assert.ok(f.calls[1].includes('--content='+content));await restored.stop();
});

test('long quick-publish review retains all body and metadata without permitting early confirmation',async t=>{
  const params={content:'正文'.repeat(4000),title:'标题',link:['https://example.invalid/|资料']},f=await fixture(t,'feed.quick-publish',params,[waiting(),boardWaiting()]),id=await begin(f);
  await f.service.process(selection(id),f.send);await f.service.process(selection(id),f.send);const child=pendingChild(f.service,id),draft=f.service.state.proposals[child];assert.ok(draft.reviewProgress.pageCount>1);assert.equal(draft.resume.review.includes(params.content),true);
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);assert.equal(draft.status,'pending');
});

for(const [label,receipt]of[
  ['no delivery metadata',()=>undefined],
  ['truncated actual text',text=>({sent_text:text.slice(0,100),delivered_messages:[{content:text.slice(0,100),messageId:'synthetic'}]})],
  ['no delivered message',text=>({sent_text:text,delivered_messages:[]})],
  ['missing message receipt id',text=>({sent_text:text,delivered_messages:[{content:text}]})]
])test('review '+label+' does not grant write approval',async t=>{
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[waiting()]),id=await begin(f);await f.service.process(selection(id),text=>receipt(text));const child=pendingChild(f.service,id);assert.equal(f.service.state.proposals[child].reviewProgress.nextPage,0);await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,1);
});

test('review page persistence failure rolls back approval progress',async t=>{
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[waiting()]),id=await begin(f),save=f.service.save.bind(f.service);let saves=0;
  f.service.save=async()=>{if(++saves===2)throw Error('review persistence failed');return save();};await assert.rejects(()=>f.service.process(selection(id),f.send),/review persistence failed/);const child=pendingChild(f.service,id);assert.equal(f.service.state.proposals[child].reviewProgress.nextPage,0);f.service.save=save;await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,1);
});

test('forget while a review page is being delivered cannot restore approval progress',async t=>{
  let release,started;const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[waiting()]),id=await begin(f);
  const work=f.service.process(selection(id),async text=>{started();await gate;return{sent_text:text,delivered_messages:[{content:text,messageId:'synthetic'}]};});await ready;await f.service.forget(event('forget'));release();await work;
  const draft=Object.values(f.service.state.proposals).find(p=>p.resume);assert.equal(draft.status,'canceled');assert.equal(draft.reviewProgress.nextPage,0);assert.equal(f.calls.length,1);
});

test('large choice labels are explicitly abbreviated so resume controls remain deliverable in one remaining slot',()=>{
  const params={keyword:'合成'},receipt=waiting();receipt.data.pending.options=Array.from({length:20},(_,i)=>({_index:i,guild_id:String(123+i),name:'长名称'.repeat(400)}));
  const source={action:'manage.search-and-join',parameters:params,requestHash:shortcutRequestHash(params),status:'waiting',result:receipt,steps:[]};
  const message=channelShortcutSummary(source,'abcdef123456'),actual=deliveryPlan(message,{used:3,limit:4}).texts;assert.equal(actual.length,1);assert.equal(actual[0],message);assert.match(message,/名称省略/);assert.match(message,/channel-resume abcdef123456/);
});

test('request hash prevents a changed body from reusing target review or an unconfirmed selection',async t=>{
  const f=await fixture(t,'feed.search-and-comment',{'guild-id':'123',query:'合成',content:'原文'},[postWaiting()]),id=await begin(f);
  await f.service.process(selection(id),f.send);const child=pendingChild(f.service,id);
  f.service.state.proposals[id].parameters.content='被替换的正文';await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,1);assert.equal(f.service.state.proposals[child].status,'canceled');
  await f.service.process(selection(id),f.send);assert.equal(f.calls.length,1);
});

test('changed target, changed resume argv, cross-owner and group cannot consume a reviewed write',async t=>{
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[waiting()]),id=await begin(f);
  await f.service.process({...selection(id),author:{user_openid:'other'}},f.send);await f.service.process({...selection(id),group_openid:'other-group'},f.send);assert.equal(pendingChild(f.service,id),undefined);
  await f.service.process(selection(id),f.send);let child=pendingChild(f.service,id);f.service.state.proposals[child].resume.args.push('--evil');await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,1);
  await f.service.process(selection(id),f.send);child=pendingChild(f.service,id);f.service.state.proposals[id].result.data.pending.options[0].name='别的目标';await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,1);
});

test('unknown and arbitrary set steps remain waiting without running returned shell instructions',async t=>{
  const receipt=waiting();receipt.data.pending={type:'input',resume_command:'powershell dangerous',set:'unknown=value'};
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[receipt]),id=await begin(f);assert.equal(f.service.state.proposals[id].status,'waiting');
  await f.service.process(selection(id),f.send);await f.service.process(event(`/channel-resume ${id} set unknown=value`),f.send);assert.equal(f.calls.length,1);assert.deepEqual(f.service.state.proposals[id].result,receipt);
});

for(const [label,response]of[
  ['unexpected initial done',doneWrite()],['partial initial', {...waiting(),_projection:{truncated:true}}],['missing status',{success:true,data:{}}]
])test(label+' never claims completion',async t=>{
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[response]),id=await begin(f);assert.equal(f.service.state.proposals[id].status,'uncertain');assert.doesNotMatch(f.replies.at(-1),/已完成|已成功执行/);await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);
});

for(const [label,response]of[
  ['timeout',Error('synthetic timeout')],['same receipt',postWaiting()],['different session',{...doneWrite(),data:{...doneWrite().data,id:'s-other'}}],['no terminal evidence',{success:true,data:{status:'done',result:{}}}],['partial done',{...doneWrite(),truncated:true}]
])test('ambiguous write '+label+' is retained as uncertain and never replayed',async t=>{
  const f=await fixture(t,'feed.search-and-comment',{'guild-id':'123',query:'合成',content:'原文'},[postWaiting(),response]),id=await begin(f);await f.service.process(selection(id),f.send);const child=pendingChild(f.service,id);await f.service.process(confirm(child),f.send);
  assert.equal(f.service.state.proposals[id].status,'uncertain');await f.service.process(confirm(child),f.send);await f.service.process(selection(id),f.send);assert.equal(f.calls.length,2);
});

test('need_verification preserves the actual receipt without pretending membership or fabricating an answer',async t=>{
  const verification={success:true,data:{status:'done',result:{success:true,data:{need_verification:true,questions:['合成问题']}}}};
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[waiting(),verification]),id=await begin(f);await f.service.process(selection(id),f.send);await f.service.process(confirm(pendingChild(f.service,id)),f.send);
  assert.equal(f.service.state.proposals[id].status,'waiting');assert.equal(f.service.state.proposals[id].blockedReason,'verification_required');assert.deepEqual(f.service.state.proposals[id].result,verification);assert.match(f.replies.at(-1),/尚未确认加入成功/);await f.service.process(selection(id),f.send);assert.equal(f.calls.length,2);
});

test('cancel, expiry and a persisted interrupted step prevent another write',async t=>{
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[waiting()]),id=await begin(f);await f.service.process(selection(id),f.send);const child=pendingChild(f.service,id);
  await f.service.process(event('/channel-cancel '+id),f.send);await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,1);
  const source=f.service.state.proposals[id];source.status='waiting';source.updatedAt=0;source.at=0;await f.service.process(selection(id),f.send);assert.equal(f.calls.length,1);
  source.status='executing';f.service.state.proposals[child].status='executing';await f.service.save();const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',run:async()=>assert.fail('No replay'),generate:async()=>assert.fail('No replan')}).init();assert.equal(restored.state.proposals[id].status,'uncertain');await restored.process(confirm(child),f.send);await restored.stop();
});

test('failed initial persistence prevents starting a child process',async t=>{
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[waiting()]);const save=f.service.save.bind(f.service);f.service.save=async()=>{throw Error('disk failure');};await assert.rejects(()=>begin(f),/disk failure/);assert.equal(f.calls.length,0);f.service.save=save;
});

test('failed execution-marker persistence prevents a confirmed continuation',async t=>{
  const f=await fixture(t,'manage.search-and-join',{keyword:'合成'},[waiting()]),id=await begin(f);await f.service.process(selection(id),f.send);const child=pendingChild(f.service,id),save=f.service.save.bind(f.service);
  f.service.save=async()=>{throw Error('disk failure');};await assert.rejects(()=>f.service.process(confirm(child),f.send),/disk failure/);assert.equal(f.calls.length,1);f.service.save=save;
});

test('forget during initial read, read selection or confirmed write cannot restore waiting capability',async t=>{
  for(const during of ['initial','read','write']){
    let release,started;const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const delayed=async()=>{started();await gate;return during==='initial'?waiting():during==='read'?boardWaiting():{success:true,data:{status:'done',result:{success:true,data:{need_verification:true}}}};};
    const f=await fixture(t,during==='initial'?'feed.latest-feeds-detail':during==='read'?'feed.quick-publish':'manage.search-and-join',during==='initial'?{count:2}:during==='read'?{content:'原文'}:{keyword:'合成'},during==='initial'?[delayed]:[waiting(),delayed]);
    let work;if(during==='initial')work=begin(f);else{const id=await begin(f);if(during==='read')work=f.service.process(selection(id),f.send);else{await f.service.process(selection(id),f.send);work=f.service.process(confirm(pendingChild(f.service,id)),f.send);}}
    await ready;await f.service.forget(event('forget'));release();await work;const id=sourceId(f.service);assert.equal(f.service.state.proposals[id].status,'canceled');await f.service.process(selection(id),f.send);assert.equal(f.calls.length,during==='initial'?1:2);assert.equal(Object.keys(f.service.state.sessions).length,0);
  }
});

test('forget during read summarization prevents a late summary from being delivered',async t=>{
  let release,started;const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,'feed.latest-feeds-detail',{count:2},[waiting(),doneRead()],{generate:async input=>{if(input.channelCommands.length)return plan('feed.latest-feeds-detail',{count:2});started();await gate;return{action:'finish',reply:'不应发送的旧摘要'};}}),id=await begin(f);
  const work=f.service.process(selection(id),f.send);await ready;await f.service.forget(event('forget'));release();await work;assert.ok(!f.replies.includes('不应发送的旧摘要'));assert.equal(Object.keys(f.service.state.sessions).length,0);
});

test('read and write shortcut candidates require typed, unambiguous indices and targets',()=>{
  const params={count:2},make=()=>({action:'feed.latest-feeds-detail',parameters:params,requestHash:shortcutRequestHash(params),status:'waiting',result:waiting(),steps:[]});
  for(const modify of [s=>{s.result.data.pending.options[0]._index=5;},s=>{delete s.result.data.pending.options[0].guild_id;},s=>{s.result.data.pending.options[0].name='a\nb';},s=>{s.result=sanitizeChannelResult({...s.result,data:{...s.result.data,pending:{...s.result.data.pending,options:Array.from({length:21},()=>({name:'合成',guild_id:'123'}))}}});}]){const source=make();modify(source);assert.throws(()=>channelShortcutStep(source,{kind:'pick',value:0}));}
  for(const selection of [{kind:'pick',value:-1},{kind:'pick',value:1},{kind:'set',value:0},{kind:'pick',value:'0;dangerous'}])assert.throws(()=>channelShortcutStep(make(),selection));
});

test('private account shortcut list is not exposed in group plans',async t=>{
  const f=await fixture(t,'feed.latest-feeds-detail',{count:2},[],{generate:async input=>{for(const name of ['feed.latest-feeds-detail','feed.hot-feeds-detail','manage.search-and-join','feed.search-and-comment','feed.quick-publish'])assert.ok(!input.channelCommands.some(c=>c.name===name));return{action:'finish',reply:'仅使用公开查询'};}});
  await f.service.process({...event('看看腾讯频道帖子'),group_openid:'synthetic-group',author:{member_openid:'member'}},f.send);assert.equal(f.calls.length,0);
});

test('read terminal requires matching selected guild and complete detail structure, not just done',()=>{
  const source={action:'feed.latest-feeds-detail',parameters:{count:2},requestHash:shortcutRequestHash({count:2}),status:'waiting',result:waiting(),steps:[]},step=channelShortcutStep(source,{kind:'pick',value:0});
  assert.equal(classifyShortcutResult(source,doneRead(),step).status,'completed');
  for(const modify of [r=>{r.data.result.guild_id='999';},r=>{r.data.result.feeds[0].feed.guild_id='999';},r=>{delete r.data.result.feeds[0].feed;},r=>{r.data.result.count=200;},r=>{r._projection={truncated:true};}]){const result=doneRead();modify(result);assert.equal(classifyShortcutResult(source,result,step).status,'uncertain');}
});

test('empty read result is valid and summary failure still returns substantive observed details',async t=>{
  const empty=doneRead();empty.data.result.count=0;empty.data.result.feeds=[];const f=await fixture(t,'feed.hot-feeds-detail',{count:2},[waiting(),empty]),id=await begin(f);await f.service.process(selection(id),f.send);assert.match(f.replies.at(-1),/暂时没有/);
  const g=await fixture(t,'feed.latest-feeds-detail',{count:2},[waiting(),doneRead()],{generate:async input=>{if(!input.channelCommands.length)throw Error('synthetic model failure');return plan('feed.latest-feeds-detail',{count:2});}}),gid=await begin(g);await g.service.process(selection(gid),g.send);assert.match(g.replies.at(-1),/合成帖子.*合成正文/s);
});

test('new shortcut parameters cannot inject continuation flags, files or incomplete publication',async()=>{
  const commands=JSON.parse(await fs.readFile('src/channel_commands.json','utf8'));
  for(const name of ['feed.latest-feeds-detail','feed.hot-feeds-detail','feed.search-and-comment','feed.quick-publish','manage.search-and-join']){const command=commands.find(c=>c.name===name);assert.ok(command);for(const bad of [{'resume-id':'s-evil'},{pick:'0'},{'content-file':'C:/private'}])assert.throws(()=>channelArgs(command,bad));}
  for(const body of [{},{content:'a','markdown-content':'b'},{'markdown-content':'a'},{content:'a','feed-type':2},{content:'a',title:'b','topic-name':['c']}])assert.throws(()=>validateShortcutRequest('feed.quick-publish',body));
  for(const count of [0,11,1.5,'bad'])assert.throws(()=>validateShortcutRequest('feed.hot-feeds-detail',{count}));
});

for(const action of ['manage.subscribe-notices','manage.unsubscribe-notices','manage.notify-daemon','manage.notices-on','manage.notices-off'])test(action+' is blocked both in plans and old saved proposals regardless of nominal success',async t=>{
  const f=await fixture(t,action,{},[],{generate:async input=>{assert.ok(!input.channelCommands.some(c=>c.name===action));return plan(action,{});}});
  await f.service.process(event('看看腾讯频道相关功能'),f.send);assert.equal(f.calls.length,0);assert.match(f.replies.at(-1),/OpenClaw.*没有接入/);
  await f.service.process(event('关闭频道通知'),f.send);assert.equal(f.calls.length,0);assert.ok(channelRequest('关闭频道通知'));
  // Reuse an ordinary owner proposal's scope, never fabricate a cross-owner bypass.
  f.service.generate=async()=>plan('manage.update-guild-info',{'guild-id':'123','guild-name':'合成'});await f.service.process(event('修改腾讯频道123名称'),f.send);const id=sourceId(f.service),p=f.service.state.proposals[id];p.action=action;p.result={success:true,data:{status:'test_sent'}};
  for(const state of ['pending','waiting']){p.status=state;await f.service.save();await f.service.process(confirm(id),f.send);assert.equal(p.status,'unsupported');assert.equal(f.calls.length,0);assert.doesNotMatch(f.replies.at(-1),/已成功执行|通知已开启/);}
});
