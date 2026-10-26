import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService,channelArgs,channelResumeStep,sanitizeChannelResult} from '../src/channel_service.mjs';
import {deliveryPlan} from '../src/delivery_plan.mjs';

const action='feed.delete-and-mute';
const pickReceipt={success:true,data:{status:'waiting',id:'s-synthetic',step:'1/3',pending:{type:'pick',hint:'选择帖子',options:[{title:'明确的合成帖子 A',feed_id:'synthetic-a'},{title:'明确的合成帖子 B',feed_id:'synthetic-b'}],resume_command:'malicious shell text is never executed'}}};
const durationReceipt={success:true,data:{status:'waiting',id:'s-synthetic',step:'2/3',pending:{type:'input',hint:'禁言秒数',resume_command:'tencent-channel-cli feed delete-and-mute --resume-id s-synthetic --time-stamp <SECONDS> --json'}}};
const done={success:true,data:{status:'done',id:'s-synthetic',result:{success:true}}};
const proposal=()=>({action,status:'waiting',result:structuredClone(pickReceipt),steps:[]});
const event=(content,id='event')=>({id,content,author:{user_openid:'owner'}});
const plan={action,parameters_json:JSON.stringify({'guild-id':'123',query:'合成帖子'}),reply:'合成草稿'};
async function fixture(t,run){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_resume_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  const service=await new ChannelService({root,getOwner:()=> 'owner',generate:async()=>plan,run}).init(),replies=[];
  const send=text=>{replies.push(text);return {sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic-message'}]};};
  t.after(async()=>{await service.stop();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  await service.process(event('删除腾讯频道123的合成帖子并禁言','initial'),send);
  const id=Object.keys(service.state.proposals)[0];
  return {service,root,id,replies,send};
}
const childId=(service,sourceId)=>Object.entries(service.state.proposals).find(([,p])=>p.resume?.sourceId===sourceId&&p.status==='pending')?.[0];

test('resume builds fixed argv from the stored receipt, never from the returned shell command',()=>{
  const step=channelResumeStep(proposal(),{kind:'pick',value:1});
  assert.deepEqual(step.args,['feed','delete-and-mute','--json','--resume-id=s-synthetic','--pick=1','--yes']);
  assert.match(step.review,/合成帖子 B/);assert.doesNotMatch(step.review,/malicious/);
  for(const selection of [{kind:'pick',value:2},{kind:'pick',value:-1},{kind:'pick',value:'1;whoami'},{kind:'set',value:1},{kind:'time-stamp',value:1}])assert.throws(()=>channelResumeStep(proposal(),selection));
});

test('unknown, partial and unreviewable receipts are rejected before a new proposal',()=>{
  for(const modify of [p=>{p.action='feed.quick-publish';},p=>{p.result.data.id='x --yes';},p=>{p.result._projection={truncated:true};},p=>{p.result.data.pending.type='unknown';},p=>{p.result.data.pending.options=[{value:'unlabelled'}];},p=>{p.result.data.pending.options=Array.from({length:21},()=>({title:'x'}));},p=>{p.result=sanitizeChannelResult({...p.result,data:{...p.result.data,pending:{...p.result.data.pending,options:[{title:'x'.repeat(4600)}]}}});}]){
    const p=proposal();modify(p);assert.throws(()=>channelResumeStep(p,{kind:'pick',value:0}));
  }
});

test('initial model arguments cannot skip target review using shortcut control flags',async()=>{
  const commands=JSON.parse(await fs.readFile('src/channel_commands.json','utf8')),command=commands.find(c=>c.name===action);
  for(const [key,value]of[['pick','0'],['set','time-stamp=60'],['time-stamp','60']])assert.throws(()=>channelArgs(command,{'guild-id':'123',query:'synthetic',[key]:value}),/channel_resume_requires_saved_receipt/);
});

test('a previously consumed receipt cannot authorize the same step again',()=>{
  const p=proposal(),first=channelResumeStep(p,{kind:'pick',value:0});
  p.steps.push({receiptHash:first.receiptHash,status:'applied',selection:first.selection,target:first.target});
  assert.throws(()=>channelResumeStep(p,{kind:'pick',value:0}),/channel_resume_consumed_receipt/);
});

test('duration requires an explicit fixed-command template and a previously confirmed applied target',()=>{
  const p=proposal();p.result=structuredClone(durationReceipt);
  assert.throws(()=>channelResumeStep(p,{kind:'time-stamp',value:60}));
  p.steps=[{status:'applied',selection:{kind:'pick',value:0},target:{label:'合成帖子 A'}}];
  const step=channelResumeStep(p,{kind:'time-stamp',value:60});assert.ok(step.args.includes('--time-stamp=60'));assert.match(step.review,/合成帖子 A.*60 秒/s);
  for(const command of ['powershell -c dangerous','tencent-channel-cli feed delete-and-mute --resume-id s-other --time-stamp <SECONDS> --json','tencent-channel-cli feed delete-and-mute --resume-id s-synthetic --time-stamp <SECONDS> --json; dangerous']){p.result.data.pending.resume_command=command;assert.throws(()=>channelResumeStep(p,{kind:'time-stamp',value:60}));}
  p.result=structuredClone(durationReceipt);
  for(const value of [0,2592001])assert.throws(()=>channelResumeStep(p,{kind:'time-stamp',value}));
});

for(const [name,response]of[
  ['missing nested result',{success:true,data:{status:'done'}}],
  ['missing nested success',{success:true,data:{status:'done',result:{}}}],
  ['non-boolean nested success',{success:true,data:{status:'done',result:{success:'true'}}}],
  ['truncated terminal',{...done,truncated:true}],
  ['projected terminal',{...done,_projection:{truncated:true,paginationAllowed:false}}]
])test('initial shortcut '+name+' is uncertain rather than falsely completed',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return structuredClone(response);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);
  assert.equal(f.service.state.proposals[f.id].status,'uncertain');assert.doesNotMatch(f.replies.at(-1),/已成功执行|已完成/);
  await f.service.process(event('/channel-confirm '+f.id),f.send);assert.equal(calls,1);
});

test('owner selection creates a concrete reviewable proposal, persists executing before run, then resumes after restart',async t=>{
  let calls=0,f;const args=[];
  f=await fixture(t,async argv=>{
    calls++;args.push(argv);
    if(calls===1)return structuredClone(pickReceipt);
    const saved=JSON.parse(await fs.readFile(f.service.path,'utf8')),active=Object.values(saved.proposals).find(p=>p.resume&&p.status==='executing');
    assert.ok(active);assert.equal(saved.proposals[f.id].status,'executing');
    return calls===2?structuredClone(durationReceipt):structuredClone(done);
  });
  await f.service.process(event('/channel-confirm '+f.id),f.send);assert.equal(calls,1);
  assert.equal(f.service.accepts(event('/channel-resume '+f.id+' pick 1')),true);
  await f.service.process(event('/channel-resume '+f.id+' pick 1'),f.send);assert.equal(calls,1);assert.match(f.replies.at(-1),/合成帖子 B/);
  const pickId=childId(f.service,f.id);assert.ok(pickId);
  await f.service.process(event('/channel-confirm '+pickId),f.send);assert.equal(calls,2);assert.equal(f.service.state.proposals[f.id].status,'waiting');
  assert.equal(f.service.state.proposals[f.id].steps[0].status,'applied');assert.ok(args[1].includes('--pick=1'));
  await f.service.process(event('/channel-confirm '+pickId),f.send);assert.equal(calls,2);
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',generate:async()=>assert.fail('No replan'),run:f.service.run}).init();
  await restored.process(event('/channel-resume '+f.id+' time-stamp 60'),f.send);assert.equal(calls,2);
  const durationId=childId(restored,f.id);assert.match(f.replies.at(-1),/合成帖子 B.*60 秒/s);
  await restored.process(event('/channel-confirm '+durationId),f.send);assert.equal(calls,3);assert.equal(restored.state.proposals[f.id].status,'completed');assert.ok(args[2].includes('--time-stamp=60'));
  await restored.process(event('/channel-confirm '+durationId),f.send);assert.equal(calls,3);await restored.stop();
});

test('cross-owner/group, stale receipt and expired proposals cannot execute a resume',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return structuredClone(pickReceipt);});await f.service.process(event('/channel-confirm '+f.id),f.send);
  for(const e of [{...event('/channel-resume '+f.id+' pick 0'),author:{user_openid:'other'}},{...event('/channel-resume '+f.id+' pick 0'),group_openid:'group'}])await f.service.process(e,f.send);
  assert.equal(childId(f.service,f.id),undefined);
  await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const id=childId(f.service,f.id);
  await f.service.executeResume(event('unconfirmed'),id,f.send);assert.equal(calls,1);assert.equal(f.service.state.proposals[id].status,'pending');
  f.service.state.proposals[f.id].result.data.pending.options[0].title='changed';await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,1);
  await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const expired=childId(f.service,f.id);f.service.state.proposals[expired].at=0;
  await f.service.process(event('/channel-confirm '+expired),f.send);assert.equal(calls,1);
});

test('waiting cancel and forget invalidate both source and pending resume without replaying prior work',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return structuredClone(pickReceipt);});await f.service.process(event('/channel-confirm '+f.id),f.send);
  await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const id=childId(f.service,f.id);
  await f.service.process(event('/channel-cancel '+f.id),f.send);assert.equal(f.service.state.proposals[f.id].status,'canceled');assert.equal(f.service.state.proposals[id].status,'canceled');
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,1);
  f.service.state.proposals[f.id].status='waiting';await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const next=childId(f.service,f.id);
  await f.service.forget(event('forget'));assert.equal(f.service.state.proposals[f.id].status,'canceled');assert.equal(f.service.state.proposals[next].status,'canceled');
  await f.service.process(event('/channel-confirm '+next),f.send);assert.equal(calls,1);
});

for(const [name,response]of[['timeout',Error('timeout')],['same receipt',pickReceipt],['session changed',{...durationReceipt,data:{...durationReceipt.data,id:'s-other'}}],['terminal session changed',{...done,data:{...done.data,id:'s-other'}}],['missing terminal status',{success:true,data:{}}],['terminal missing nested result',{success:true,data:{status:'done'}}],['partial terminal',{...done,_projection:{truncated:true}}]])test('ambiguous resume '+name+' becomes uncertain and is never retried',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;if(calls===1)return structuredClone(pickReceipt);if(response instanceof Error)throw response;return structuredClone(response);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const id=childId(f.service,f.id);
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(f.service.state.proposals[f.id].status,'uncertain');assert.equal(f.service.state.proposals[id].status,'uncertain');
  await f.service.process(event('/channel-confirm '+id),f.send);await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);assert.equal(calls,2);
});

test('interruption after execution marker is persisted recovers as uncertain instead of replaying',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return structuredClone(pickReceipt);});await f.service.process(event('/channel-confirm '+f.id),f.send);
  await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const id=childId(f.service,f.id);
  f.service.state.proposals[f.id].status='executing';f.service.state.proposals[id].status='executing';await f.service.save();
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',run:async()=>assert.fail('No replay'),generate:async()=>assert.fail('No replan')}).init();
  assert.equal(restored.state.proposals[f.id].status,'uncertain');assert.equal(restored.state.proposals[id].status,'uncertain');await restored.process(event('/channel-confirm '+id),f.send);await restored.stop();assert.equal(calls,1);
});

test('failed persistence prevents the actual resume call',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return structuredClone(pickReceipt);});await f.service.process(event('/channel-confirm '+f.id),f.send);
  await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const id=childId(f.service,f.id),save=f.service.save.bind(f.service);
  f.service.save=async()=>{throw Error('simulated_disk_failure');};await assert.rejects(()=>f.service.process(event('/channel-confirm '+id),f.send),/simulated_disk_failure/);f.service.save=save;assert.equal(calls,1);
});

test('forget during an in-flight resume retains its receipt but never restores continuation capability',async t=>{
  let calls=0,release,started;const ready=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});
  const f=await fixture(t,async()=>{calls++;if(calls===1)return structuredClone(pickReceipt);started();await gate;return structuredClone(durationReceipt);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const id=childId(f.service,f.id);
  let valid=true;const inflight=f.service.process(event('/channel-confirm '+id),f.send,()=>valid);await ready;valid=false;await f.service.forget(event('forget'));release();await inflight;
  assert.equal(f.service.state.proposals[f.id].status,'canceled');assert.equal(f.service.state.proposals[f.id].steps[0].status,'applied');assert.deepEqual(f.service.state.proposals[f.id].result,durationReceipt);
  await f.service.prepareResume(event('select'),f.id,{kind:'time-stamp',value:60},f.send);assert.equal(calls,2);
});

test('forget while an initial shortcut is returning waiting does not resurrect the canceled flow',async t=>{
  let release,started;const ready=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});
  const f=await fixture(t,async()=>{started();await gate;return structuredClone(pickReceipt);});
  let valid=true;const work=f.service.process(event('/channel-confirm '+f.id),f.send,()=>valid);await ready;valid=false;await f.service.forget(event('forget'));release();await work;
  assert.equal(f.service.state.proposals[f.id].status,'canceled');assert.deepEqual(f.service.state.proposals[f.id].result,pickReceipt);
});

for(const [name,send]of[
  ['no receipt',()=>undefined],
  ['missing message id',text=>({sent_text:text.trim(),delivered_messages:[{content:text.trim()}]})],
  ['partial receipt',text=>({sent_text:text.slice(0,40),delivered_messages:[{content:text.slice(0,40),messageId:'synthetic'}]})]
])test('delete-and-mute continuation cannot execute after '+name,async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return calls===1?structuredClone(pickReceipt):structuredClone(done);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);
  await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},send);const id=childId(f.service,f.id),p=f.service.state.proposals[id];
  assert.equal(p.reviewProgress.nextPage,0);await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,1);
  await f.service.process(event('/channel-review '+id+' 1'),f.send);await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,2);
});

test('legacy pending delete-and-mute continuation requires review then a separate confirmation',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return calls===1?structuredClone(pickReceipt):structuredClone(done);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);
  const id=childId(f.service,f.id),p=f.service.state.proposals[id];delete p.reviewProgress;await f.service.save();
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,1);assert.equal(p.reviewProgress.nextPage,1);
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,2);
});

test('long delete-and-mute target review requires every page before confirmation',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return calls===1?structuredClone(pickReceipt):structuredClone(done);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);
  const source=f.service.state.proposals[f.id];source.result.data.pending.options[0].title='合成标题'.repeat(370);
  await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);const id=childId(f.service,f.id),p=f.service.state.proposals[id];
  assert.equal(p.reviewProgress.pageCount,2);assert.equal(p.reviewProgress.nextPage,1);assert.doesNotMatch(f.replies.at(-1),/channel-confirm/);
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,1);
  await f.service.process(event('/channel-review '+id+' 2'),f.send);await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,2);
});

for(const [name,change]of[
  ['args',p=>p.resume.args.push('--synthetic-unreviewed')],
  ['session',p=>{p.resume.sessionId='s-other';}],
  ['selection',p=>{p.resume.selection.value=1;}]
])test('delete-and-mute continuation checks its complete saved '+name+' binding',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return structuredClone(pickReceipt);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);
  const id=childId(f.service,f.id),p=f.service.state.proposals[id];change(p);
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(calls,1);assert.equal(p.status,'canceled');
});

for(const mode of ['forget','owner','valid','receipt'])test('delete-and-mute executing save observes '+mode+' changes before external write',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return structuredClone(pickReceipt);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);
  const id=childId(f.service,f.id),p=f.service.state.proposals[id],source=f.service.state.proposals[f.id],save=f.service.save.bind(f.service);
  let release,entered,waited=false,valid=true;const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
  f.service.save=async()=>{if(!waited&&p.status==='executing'){waited=true;entered();await gate;}return save();};
  const work=f.service.process(event('/channel-confirm '+id),f.send,()=>valid);await ready;
  if(mode==='forget')await f.service.forget(event('/forget'));
  if(mode==='owner')f.service.getOwner=()=> 'changed-owner';
  if(mode==='valid')valid=false;
  if(mode==='receipt')source.result.data.pending.options[0].title='保存期间变更';
  release();await work;assert.equal(calls,1);assert.equal(p.status,'canceled');assert.equal(source.status,'canceled');
});

test('forget with default validity during an external continuation keeps receipt but cancels further steps',async t=>{
  let calls=0,entered,release;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const f=await fixture(t,async()=>{calls++;if(calls===1)return structuredClone(pickReceipt);entered();await gate;return structuredClone(durationReceipt);});
  await f.service.process(event('/channel-confirm '+f.id),f.send);await f.service.prepareResume(event('select'),f.id,{kind:'pick',value:0},f.send);
  const id=childId(f.service,f.id),work=f.service.process(event('/channel-confirm '+id),f.send);await ready;await f.service.forget(event('/forget'));release();await work;
  const source=f.service.state.proposals[f.id];assert.equal(source.status,'canceled');assert.deepEqual(source.result,durationReceipt);
  await f.service.prepareResume(event('select'),f.id,{kind:'time-stamp',value:60},f.send);assert.equal(calls,2);
});

test('twenty maximum-length delete-and-mute menu titles and commands fit one remaining QQ bubble',async t=>{
  const response=structuredClone(pickReceipt);response.data.pending.options=Array.from({length:20},(_,i)=>({title:'合'.repeat(1497)+String(i).padStart(3,'0'),feed_id:'synthetic-'+i}));
  const f=await fixture(t,async()=>structuredClone(response));await f.service.process(event('/channel-confirm '+f.id),f.send);
  const text=f.replies.at(-1);assert.ok(Array.from(text).length<=1800);assert.deepEqual(deliveryPlan(text,{used:3,limit:4}).texts,[text]);
  for(let i=0;i<20;i++)assert.ok(text.includes(`\n${i}：${'合'.repeat(50)}…（名称省略，写入前会完整展示）`));
  assert.ok(text.includes(`/channel-resume ${f.id} pick 序号`));assert.ok(text.includes(`/channel-cancel ${f.id}`));
  assert.deepEqual(f.service.state.proposals[f.id].result,response);
  const saved=JSON.parse(await fs.readFile(f.service.path,'utf8'));assert.deepEqual(saved.proposals[f.id].result,response);
});

test('Unicode delete-and-mute labels are shortened by code point without losing menu controls or original titles',async t=>{
  const response=structuredClone(pickReceipt);response.data.pending.options=Array.from({length:20},(_,i)=>({title:'🙂'.repeat(748)+String(i).padStart(2,'0'),feed_id:'synthetic-'+i}));
  const f=await fixture(t,async()=>structuredClone(response));await f.service.process(event('/channel-confirm '+f.id),f.send);
  const text=f.replies.at(-1);assert.ok(text.includes('0：'+'🙂'.repeat(50)+'…'));assert.doesNotMatch(text,/\uFFFD/);
  assert.ok(Array.from(text).length<=1800);assert.deepEqual(deliveryPlan(text,{used:3,limit:4}).texts,[text]);
  assert.ok(text.includes(`/channel-resume ${f.id} pick 序号`));assert.deepEqual(f.service.state.proposals[f.id].result,response);
  await f.service.process(event(`/channel-resume ${f.id} pick 19`),f.send);const child=childId(f.service,f.id),p=f.service.state.proposals[child];
  assert.equal(p.resume.target.label,response.data.pending.options[19].title);assert.equal(p.resume.target.option.feed_id,'synthetic-19');
  assert.ok(p.resume.review.includes(response.data.pending.options[19].title));assert.equal(p.resume.selection.value,19);
});

test('identical shortened and full menu labels retain distinct exact selection indexes',async t=>{
  let calls=0;const response=structuredClone(pickReceipt),title='相同合成标题'.repeat(100);
  response.data.pending.options=[{title,feed_id:'synthetic-a'},{title,feed_id:'synthetic-b'}];
  const f=await fixture(t,async()=>{calls++;return structuredClone(response);});await f.service.process(event('/channel-confirm '+f.id),f.send);
  const text=f.replies.at(-1);assert.match(text,/\n0：.*\n1：/);assert.ok(text.includes('名称省略'));
  await f.service.process(event(`/channel-resume ${f.id} pick 1`),f.send);const child=childId(f.service,f.id),p=f.service.state.proposals[child];
  assert.equal(calls,1);assert.equal(p.resume.selection.value,1);assert.ok(p.resume.args.includes('--pick=1'));
  assert.equal(p.resume.target.option.feed_id,'synthetic-b');assert.equal(p.resume.target.label,title);assert.ok(p.resume.review.includes(title));assert.match(p.resume.review,/删除选项 1/);
  assert.deepEqual(f.service.state.proposals[f.id].result,response);
});
