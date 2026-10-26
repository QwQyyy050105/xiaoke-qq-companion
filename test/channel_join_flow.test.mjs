import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService} from '../src/channel_service.mjs';
import {channelJoinNeedsVerification,channelJoinVerification} from '../src/channel_join_flow.mjs';

const event=(content,id='synthetic')=>({id,content,author:{user_openid:'owner'}});
const delivered=text=>({sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic-message'}]});
const single=()=>({success:true,data:{status:'need_verification',joinType:5,question:{items:[{question:'请用自己的话介绍来意'}]}}});
const quiz=()=>({success:true,data:{need_verification:true,setting:{join_type:'JOIN_GUILD_TYPE_QUIZ',quiz:{items:[{question:'第一题',answers:['甲','乙']},{question:'第二题',answers:['丙','丁']}]}}}});
async function fixture(t,result=single()){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_join_flow_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  const calls=[],replies=[],generate=async()=>({action:'manage.join-guild',parameters_json:JSON.stringify({'guild-id':'123'}),reply:'合成入群草稿'});
  const run=async(args,options)=>{calls.push({args,options});return calls.length===1?structuredClone(result):{success:true,data:{status:'submitted'}};};
  const service=await new ChannelService({root,getOwner:()=> 'owner',generate,run}).init();
  const send=text=>{replies.push(text);return delivered(text);};
  t.after(async()=>{await service.stop();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  return {root,service,calls,replies,generate,run,send};
}
async function begin(f,send=f.send){
  await f.service.process(event('加入腾讯频道123'),f.send);const id=Object.keys(f.service.state.proposals)[0];
  await f.service.process(event('/channel-confirm '+id),send);return id;
}
const childId=(f,id)=>f.service.state.proposals[id].joinVerification.pendingAnswerId;

test('documented numeric and named join types preserve real question order while unknown shapes stay unresolved',()=>{
  for(const type of [4,5,'JOIN_GUILD_TYPE_QUESTION_WITH_ADMIN_AUDIT']){
    const result=single();result.data.joinType=type;assert.equal(channelJoinVerification(result).kind,'comment');
  }
  const multi=single();multi.data.joinType=6;multi.data.question.items.push({question:'第二题'});
  assert.deepEqual(channelJoinVerification(multi).questions.map(q=>q.question),['请用自己的话介绍来意','第二题']);
  assert.equal(channelJoinVerification(quiz()).kind,'answers');
  assert.equal(channelJoinVerification({success:true,data:{status:'need_verification',joinType:2}}).kind,'comment');
  for(const result of [{success:true,data:{status:'need_verification',questions:['unbound']}},{...single(),_projection:{truncated:true}},{success:true,data:{need_verification:{questions:['unknown']}}}]){
    assert.equal(channelJoinNeedsVerification(result),true);assert.equal(channelJoinVerification(result),null);
  }
});

test('a successful CLI join submission never fabricates membership confirmation',async t=>{
  const f=await fixture(t,{success:true}),id=await begin(f);
  assert.equal(f.service.state.proposals[id].status,'completed');assert.equal(f.service.state.proposals[id].membershipConfirmed,false);
  assert.match(f.replies.at(-1),/请求已提交/);assert.doesNotMatch(f.replies.at(-1),/已成功加入|加入成功/);
});

test('single-question natural owner answer becomes a separately reviewed literal stdin submission',async t=>{
  const f=await fixture(t),id=await begin(f),source=f.service.state.proposals[id];
  assert.equal(source.status,'verification_required');assert.equal(f.calls.length,1);assert.match(f.replies.at(-1),/请用自己的话介绍来意/);
  const answer='我想来聊数学\n不是执行命令：$(echo no)';assert.equal(f.service.accepts(event(answer)),true);
  await f.service.process(event(answer),f.send);const child=childId(f,id),p=f.service.state.proposals[child];
  assert.equal(p.parameters.join_guild_comment,answer);assert.equal(source.status,'verification_reserved');assert.equal(f.calls.length,1);
  await f.service.process(event('/channel-confirm '+child),f.send);assert.equal(f.calls.length,2);
  assert.deepEqual(JSON.parse(f.calls[1].options.stdin),{guild_id:'123',join_guild_comment:answer});
  assert.equal(p.status,'completed');assert.equal(source.joinVerification.answerOutcome.status,'completed');assert.equal(source.joinVerification.answerOutcome.membershipConfirmed,false);
  await f.service.process(event('/channel-confirm '+child),f.send);assert.equal(f.calls.length,2);
});

test('ordered quiz answers support natural numbered lines and explicit option indices after restart',async t=>{
  const f=await fixture(t,quiz()),id=await begin(f);
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',generate:f.generate,run:f.run}).init();t.after(()=>restored.stop());
  assert.equal(restored.accepts(event('1. 2\n2. 丙')),true);
  await restored.process(event('1. 2\n2. 丙'),f.send);const child=restored.state.proposals[id].joinVerification.pendingAnswerId;
  assert.deepEqual(restored.state.proposals[child].parameters.join_guild_answers,[{answer:'乙'},{answer:'丙'}]);
  await restored.process(event('/channel-confirm '+child),f.send);assert.equal(f.calls.length,2);
  assert.deepEqual(JSON.parse(f.calls[1].options.stdin),{guild_id:'123',join_guild_answers:[{answer:'乙'},{answer:'丙'}]});
});

test('unknown need_verification shape is saved as unfinished without inventing questions or retrying',async t=>{
  const f=await fixture(t,{success:true,data:{status:'need_verification',vendor_blob:{unrecognized:true}}}),id=await begin(f),source=f.service.state.proposals[id];
  assert.equal(source.status,'verification_unknown');assert.match(f.replies.at(-1),/没有加入成功/);
  await f.service.process(event(`/channel-join-answer ${id} {"comment":"不能猜题"}`),f.send);
  assert.equal(f.calls.length,1);assert.equal(Object.keys(f.service.state.proposals).length,1);
});

test('all actual question pages must be fully delivered before any answer draft can be prepared',async t=>{
  const result=single();result.data.question.items[0].question='长问题'.repeat(1000);
  const f=await fixture(t,result),id=await begin(f),v=f.service.state.proposals[id].joinVerification;
  assert.ok(v.progress.pageCount>1);await f.service.process(event('我的答案'),f.send);assert.equal(childId(f,id),undefined);
  while(v.progress.nextPage<v.progress.pageCount)await f.service.process(event(`/channel-review ${id} ${v.progress.nextPage+1}`),f.send);
  await f.service.process(event('我的答案'),f.send);assert.ok(childId(f,id));assert.equal(f.calls.length,1);
});

test('missing delivery proof cannot be replaced by an explicit JSON answer',async t=>{
  const f=await fixture(t),id=await begin(f,()=>undefined);
  assert.equal(f.service.state.proposals[id].joinVerification.progress.nextPage,0);
  await f.service.process(event(`/channel-join-answer ${id} {"comment":"我的答案"}`),f.send);assert.equal(childId(f,id),undefined);assert.equal(f.calls.length,1);
});

test('question receipt mutation after delivery prevents binding an answer to stale questions',async t=>{
  const f=await fixture(t),id=await begin(f);f.service.state.proposals[id].result.data.question.items[0].question='被替换的问题';
  await f.service.process(event('我的答案'),f.send);assert.equal(childId(f,id),undefined);assert.equal(f.calls.length,1);
});

test('question delivery pending durable save cannot race ahead into answer preparation',async t=>{
  const f=await fixture(t),id=await begin(f,()=>undefined),s=f.service,save=s.save.bind(s);
  let enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  s.save=async()=>{enter();await gate;return save();};
  const work=s.process(event(`/channel-review ${id} 1`),f.send);await ready;
  await s.process(event('提前的答案'),f.send);assert.equal(childId(f,id),undefined);
  release();await work;s.save=save;await s.process(event('最终的答案'),f.send);assert.ok(childId(f,id));
});

test('forget persists verification cancellation so a restart cannot resurrect the old questions',async t=>{
  const f=await fixture(t),id=await begin(f);await f.service.forget(event('/forget'));
  assert.equal(f.service.state.proposals[id].status,'canceled');
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',generate:f.generate,run:f.run}).init();t.after(()=>restored.stop());
  assert.equal(restored.joinFlow.latest(event('答案')),undefined);
  await restored.process(event(`/channel-join-answer ${id} {"comment":"答案"}`),f.send);assert.equal(f.calls.length,1);
});

test('a new verification created after forget survives restart even though runtime epochs reset',async t=>{
  const f=await fixture(t),oldId=await begin(f);await f.service.forget(event('/forget'));
  f.service.run=async(args,options)=>{f.calls.push({args,options});return single();};
  await f.service.process(event('加入腾讯频道123','new-request'),f.send);const id=Object.keys(f.service.state.proposals).find(key=>key!==oldId);
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(f.service.state.proposals[id].status,'verification_required');assert.equal(f.service.state.proposals[id].joinVerification.epoch,1);
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',generate:f.generate,run:f.run}).init();t.after(()=>restored.stop());
  assert.equal(restored.state.proposals[oldId].status,'canceled');assert.equal(restored.joinFlow.latest(event('新答案'))[0],id);
  await restored.process(event('新答案'),f.send);assert.ok(restored.state.proposals[id].joinVerification.pendingAnswerId);
});

test('owner changes, group input and target mutations cannot submit saved verification answers',async t=>{
  const f=await fixture(t),id=await begin(f);
  await f.service.process({...event(`/channel-join-answer ${id} {"comment":"答案"}`),author:{user_openid:'other'}},f.send);
  await f.service.process({...event(`/channel-join-answer ${id} {"comment":"答案"}`),group_openid:'group',author:{member_openid:'owner'}},f.send);
  assert.equal(childId(f,id),undefined);
  await f.service.process(event('真正的主人答案'),f.send);const child=childId(f,id);f.service.state.proposals[child].parameters['guild-id']='999';
  await f.service.process(event('/channel-confirm '+child),f.send);assert.equal(f.calls.length,1);assert.equal(f.service.state.proposals[child].status,'canceled');
});

test('canceling a reserved verification cancels its unsent answer draft',async t=>{
  const f=await fixture(t),id=await begin(f);await f.service.process(event('准备的答案'),f.send);const child=childId(f,id);
  await f.service.process(event('/channel-cancel '+id),f.send);assert.equal(f.service.state.proposals[id].status,'canceled');assert.equal(f.service.state.proposals[child].status,'canceled');
  await f.service.process(event('/channel-confirm '+child),f.send);assert.equal(f.calls.length,1);
});

test('forget during an already issued join request preserves result but never restores verification or sends questions',async t=>{
  const f=await fixture(t);let issued;
  f.service.run=async()=>{issued=true;await f.service.forget(event('/forget'));return single();};
  const id=await begin(f);assert.equal(issued,true);assert.equal(f.service.state.proposals[id].status,'canceled');assert.ok(f.service.state.proposals[id].result);
  assert.ok(!f.replies.some(reply=>reply.startsWith('频道加入验证')));
});

test('model-fabricated answer parameters cannot bypass the explicit owner question flow',async t=>{
  const f=await fixture(t);let count=0;
  f.service.generate=async()=>count++===0?{action:'manage.join-guild',parameters_json:JSON.stringify({'guild-id':'123',join_guild_comment:'模型编的答案'})}:{action:'finish',reply:'需要先核对问题',parameters_json:'{}'};
  await f.service.process(event('加入腾讯频道123'),f.send);assert.equal(f.calls.length,0);assert.equal(Object.keys(f.service.state.proposals).length,0);
});

test('cancel during the executing-marker save invalidates the source before CLI admission',async t=>{
  const f=await fixture(t),id=await begin(f);await f.service.process(event('原文答案'),f.send);const child=childId(f,id),p=f.service.state.proposals[child],save=f.service.save.bind(f.service);
  let paused=false,enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  f.service.save=async()=>{if(p.status==='executing'&&!paused){paused=true;enter();await gate;}return save();};
  const work=f.service.process(event('/channel-confirm '+child),f.send);await ready;
  await f.service.process(event('/channel-cancel '+id),f.send);assert.match(f.replies.at(-1),/本地取消不能撤回/);
  release();await work;f.service.save=save;
  assert.equal(f.calls.length,1);assert.equal(p.status,'canceled');assert.equal(f.service.state.proposals[id].status,'canceled');
});

test('cancel after CLI admission does not claim withdrawal and preserves the late real result',async t=>{
  const f=await fixture(t),id=await begin(f);await f.service.process(event('原文答案'),f.send);const child=childId(f,id),p=f.service.state.proposals[child];
  let enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  f.service.run=async(args,options)=>{f.calls.push({args,options});enter();await gate;return {success:true,data:{status:'submitted'}};};
  const work=f.service.process(event('/channel-confirm '+child),f.send);await ready;
  await f.service.process(event('/channel-cancel '+id),f.send);assert.match(f.replies.at(-1),/本地取消不能撤回/);assert.doesNotMatch(f.replies.at(-1),/尚未提交的答案不会发送/);
  release();await work;
  assert.equal(f.calls.length,2);assert.equal(f.service.state.proposals[id].status,'canceled');assert.equal(p.result.success,true);assert.equal(p.status,'completed');
  assert.equal(f.service.state.proposals[id].joinVerification.answerOutcome.status,'completed');
});

test('canceling a source after successful submission preserves the completed child and explains its limit',async t=>{
  const f=await fixture(t),id=await begin(f);await f.service.process(event('原文答案'),f.send);const child=childId(f,id);
  await f.service.process(event('/channel-confirm '+child),f.send);await f.service.process(event('/channel-cancel '+id),f.send);
  assert.equal(f.service.state.proposals[child].status,'completed');assert.match(f.replies.at(-1),/本地取消不能撤回/);assert.equal(f.calls.length,2);
});

test('real start queue admits owner cancellation immediately while answer confirmation waits on persistence',async t=>{
  const f=await fixture(t),id=await begin(f);await f.service.process(event('原文答案'),f.send);const child=childId(f,id),p=f.service.state.proposals[child],save=f.service.save.bind(f.service);
  let paused=false,enter,release,cancelSent;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r),cancellation=new Promise(r=>cancelSent=r);
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('cancellation was blocked by the confirmation queue')),2000);})]);}finally{clearTimeout(timer);}};
  f.service.save=async()=>{if(p.status==='executing'&&!paused){paused=true;enter();await gate;}return save();};
  assert.equal(f.service.start(event('/channel-confirm '+child,'queued-confirmation'),f.send),true);
  try{
    await bounded(ready);
    assert.equal(f.service.start(event('/channel-cancel '+id,'immediate-cancellation'),text=>{cancelSent();return f.send(text);}),true);
    await bounded(cancellation);assert.equal(f.service.state.proposals[id].status,'canceled');assert.match(f.replies.at(-1),/本地取消不能撤回/);
  }finally{release();await f.service.stop();f.service.save=save;}
  assert.equal(f.calls.length,1);assert.equal(p.status,'canceled');
});
