import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService} from '../src/channel_service.mjs';
import {channelReviewPages,channelReviewProgress} from '../src/channel_review.mjs';
import {deliveryPlan} from '../src/delivery_plan.mjs';

const event=(content,id='synthetic-event')=>({id,content,author:{user_openid:'owner'}});
const receipt=text=>({sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic-message'}]});
const confirm=id=>event('/channel-confirm '+id);
const review=(id,page)=>event(`/channel-review ${id} ${page}`);
async function fixture(t,{body='合成正文',action='feed.publish-feed',parameters}={}){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_atomic_review_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  parameters??={'guild-id':'123','channel-id':'456',content:body};
  const calls=[],replies=[],generate=async()=>({action,parameters_json:JSON.stringify(parameters),reply:'不能代替实际参数的概述'});
  const run=async args=>{calls.push(args);return {success:true};};
  const service=await new ChannelService({root,getOwner:()=> 'owner',generate,run}).init();
  const send=text=>{replies.push(text);return receipt(text);};
  t.after(async()=>{await service.stop();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  return {service,root,parameters,generate,run,calls,replies,send};
}
async function begin(f,send=f.send){await f.service.process(event('在腾讯频道123版块456执行操作'),send);return Object.keys(f.service.state.proposals)[0];}
async function allPages(service,id,send){const p=service.state.proposals[id];while(p.reviewProgress.nextPage<p.reviewProgress.pageCount)await service.process(review(id,p.reviewProgress.nextPage+1),send);}

test('atomic long body and full targets survive one-slot pages, persistence and explicit final confirmation',async t=>{
  const f=await fixture(t,{body:'合成正文'.repeat(1998)+'结尾🙂'}),pages=[];
  const limited=text=>{
    const delivered=deliveryPlan(text,{used:3,limit:4});assert.deepEqual(delivered.texts,[text]);
    if(text.startsWith('频道操作草稿'))pages.push(text);return receipt(text);
  };
  const id=await begin(f,limited),p=f.service.state.proposals[id];
  assert.equal(f.calls.length,0);assert.equal(p.reviewProgress.nextPage,1);assert.ok(p.reviewProgress.pageCount>4);
  assert.doesNotMatch(pages[0],/channel-confirm/);assert.match(pages[0],/"guild-id": "123"/);assert.match(pages[0],/"channel-id": "456"/);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
  await f.service.process(review(id,3),f.send);assert.equal(p.reviewProgress.nextPage,1);
  await f.service.process(review(id,2),limited);
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',generate:f.generate,run:f.run}).init();
  t.after(()=>restored.stop());assert.equal(restored.state.proposals[id].reviewProgress.nextPage,2);
  await allPages(restored,id,limited);assert.equal(f.calls.length,0);
  const reconstructed=pages.map(text=>text.slice(text.indexOf('：\n')+2,text.lastIndexOf('\n\n'))).join('');
  assert.equal(reconstructed,p.atomicReview.text);assert.ok(reconstructed.includes(f.parameters.content));
  assert.match(pages.at(-1),new RegExp('/channel-confirm '+id));
  await restored.process(confirm(id),f.send);assert.equal(f.calls.length,1);assert.ok(f.calls[0].includes('--content='+f.parameters.content));
  await restored.process(confirm(id),f.send);assert.equal(f.calls.length,1);
});

for(const [name,deliver]of[
  ['missing receipt',()=>undefined],['missing message id',text=>({sent_text:text.trim(),delivered_messages:[{content:text.trim()}]})],
  ['truncated text',text=>({sent_text:text.slice(0,40),delivered_messages:[{content:text.slice(0,40),messageId:'synthetic'}]})],
  ['wrong body receipt',text=>({sent_text:text.trim(),delivered_messages:[{content:'different',messageId:'synthetic'}]})]
])test('atomic review never authorizes a page with '+name,async t=>{
  const f=await fixture(t),id=await begin(f,deliver),p=f.service.state.proposals[id];
  assert.equal(p.reviewProgress.nextPage,0);await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
  await f.service.process(review(id,1),f.send);await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);
});

for(const [name,change]of[
  ['body',p=>{p.parameters.content='未审阅的新正文';}],['target',p=>{p.parameters['channel-id']='999';}],
  ['action',p=>{p.action='manage.update-guild-info';p.parameters={'guild-id':'123','guild-name':'新名字'};}],
  ['review text',p=>{p.atomicReview.text+='隐藏变化';}],['payload hash',p=>{p.atomicReview.payloadHash='0'.repeat(64);}]
])test('atomic '+name+' mutation invalidates the reviewed immutable proposal',async t=>{
  const f=await fixture(t),id=await begin(f),p=f.service.state.proposals[id];change(p);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);assert.equal(p.status,'canceled');
});

test('legacy pending atomic proposal must receive a new complete review and a separate confirmation',async t=>{
  const f=await fixture(t),id=await begin(f),p=f.service.state.proposals[id];delete p.atomicReview;delete p.reviewProgress;await f.service.save();
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);assert.equal(p.status,'pending');assert.equal(p.reviewProgress.nextPage,1);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);
});

test('atomic final-page proof is rolled back on failed persistence and cannot be approved',async t=>{
  const f=await fixture(t),id=await begin(f,()=>undefined),p=f.service.state.proposals[id],save=f.service.save.bind(f.service);
  f.service.save=async()=>{throw Error('synthetic_save_failure');};
  await assert.rejects(()=>f.service.process(review(id,1),f.send),/synthetic_save_failure/);assert.equal(p.reviewProgress.nextPage,0);
  f.service.save=save;await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
});

test('atomic review in-flight persistence cannot authorize a concurrent confirm before durable proof',async t=>{
  const f=await fixture(t),id=await begin(f,()=>undefined),save=f.service.save.bind(f.service);
  let enter,release;const ready=new Promise(r=>{enter=r;}),gate=new Promise(r=>{release=r;});
  f.service.save=async()=>{enter();await gate;return save();};
  const work=f.service.process(review(id,1),f.send);await ready;
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);release();await work;f.service.save=save;
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);
});

test('forget while an atomic review page is sending cannot restore authorization',async t=>{
  const f=await fixture(t),id=await begin(f,()=>undefined),p=f.service.state.proposals[id];
  await f.service.process(review(id,1),async text=>{await f.service.forget(event('/forget'));return receipt(text);});
  assert.equal(p.status,'canceled');assert.equal(p.reviewProgress.nextPage,0);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
});

test('changing an atomic payload while a page is sending cannot mark the page delivered',async t=>{
  const f=await fixture(t),id=await begin(f,()=>undefined),p=f.service.state.proposals[id];
  await f.service.process(review(id,1),text=>{p.parameters.content='变更正文';return receipt(text);});
  assert.equal(p.reviewProgress.nextPage,0);await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
});

test('atomic payload changes during executing persistence cannot use already-built argv',async t=>{
  const f=await fixture(t),id=await begin(f),p=f.service.state.proposals[id],save=f.service.save.bind(f.service);
  f.service.save=async()=>{if(p.status==='executing')p.parameters.content='保存过程中变更';return save();};
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);assert.equal(p.status,'canceled');
});

test('atomic review preserves multiline text, arrays and all exact target parameters',async t=>{
  const parameters={'guild-id':'123','channel-id':'456',title:'合成标题',content:'第一行\n第二行 "引号" \\ 路径字符',link:['https://example.invalid/a|合成链接'], 'topic-name':['合成主题']};
  const f=await fixture(t,{parameters}),id=await begin(f),p=f.service.state.proposals[id];
  const reviewed=JSON.parse(p.atomicReview.text.slice(p.atomicReview.text.indexOf('{')));assert.deepEqual(reviewed,parameters);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);
  for(const [key,value]of Object.entries(parameters))for(const item of Array.isArray(value)?value:[value])assert.ok(f.calls[0].includes(`--${key}=${item}`));
});

test('atomic review refuses another owner, a group and an expired proposal',async t=>{
  const f=await fixture(t),id=await begin(f,()=>undefined),p=f.service.state.proposals[id];
  await f.service.process({...review(id,1),author:{user_openid:'other'}},f.send);
  await f.service.process({...review(id,1),group_openid:'group'},f.send);
  assert.equal(p.reviewProgress.nextPage,0);p.at=0;await f.service.process(review(id,1),f.send);await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
});

test('shared review pages preserve surrogate pairs and keep controls within one text slot',()=>{
  const text='🙂'.repeat(2500),pages=channelReviewPages(text);assert.equal(pages.join(''),text);assert.deepEqual(pages.map(x=>Array.from(x).length),[1200,1200,100]);
  assert.equal(channelReviewProgress(text).pageCount,3);
});
