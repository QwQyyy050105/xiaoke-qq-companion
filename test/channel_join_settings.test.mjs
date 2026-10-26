import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {ChannelService,channelInvocation,channelCli} from '../src/channel_service.mjs';
import {channelJoinSettingsCommand} from '../src/channel_join_settings.mjs';

const commands=JSON.parse(await fs.readFile(new URL('../src/channel_commands.json',import.meta.url),'utf8'));
const command=commands.find(c=>c.name==='manage.update-join-guild-setting');
const params=(kind,setting)=>({'guild-id':'123','join-type':'JOIN_GUILD_TYPE_'+kind,...(setting?{setting}:{})});
const multi=()=>params('MULTI_QUESTION',{question:{items:[{question:'题目一\n保留原文',answer:'字面答案 "2"'},{question:'题目二',answer:'B'}]}});
const quiz=()=>params('QUIZ',{quiz:{items:[{question:'合成题目',answers:['甲','乙'],correctAnswer:'乙'}],minAnswerNum:1,minCorrectAnswerNum:1}});
const event=(content,id='synthetic')=>({content,id,author:{user_openid:'owner'}});
const delivered=text=>({sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic-message'}]});
async function fixture(t,parameters){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_join_settings_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  const calls=[],replies=[],generate=async input=>{
    assert.ok(input.channelCommands.find(c=>c.name===command.name).stdin_parameters.setting);
    return {action:command.name,parameters_json:JSON.stringify(parameters),reply:'合成草稿'};
  };
  const run=async(args,options)=>{calls.push({args,options});return {success:true};};
  const service=await new ChannelService({root,getOwner:()=> 'owner',generate,run}).init();
  const send=text=>{replies.push(text);return delivered(text);};
  t.after(async()=>{await service.stop();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  return {root,service,calls,replies,generate,run,send};
}
async function begin(f){await f.service.process(event('把腾讯频道123的加入设置改成指定题目'),f.send);return Object.keys(f.service.state.proposals)[0];}
async function finishReview(service,id,send){const p=service.state.proposals[id];while(p.reviewProgress.nextPage<p.reviewProgress.pageCount)await service.process(event(`/channel-review ${id} ${p.reviewProgress.nextPage+1}`),send);}

test('all documented advanced join settings use typed complete stdin with exact text, and basic joins remain flags',()=>{
  for(const parameters of [multi(),quiz(),params('QUESTION_WITH_ADMIN_AUDIT',{question:{items:[{question:'请介绍自己'}]}})]){
    const invocation=channelInvocation(command,parameters),body=JSON.parse(invocation.stdin);
    assert.deepEqual(invocation.args,['manage','update-join-guild-setting','--json']);
    assert.equal(body.guild_id,'123');assert.equal(body.setting.join_type,parameters['join-type']);
    const key=parameters.setting.quiz?'quiz':'question';assert.deepEqual(body.setting[key],parameters.setting[key]);
  }
  assert.deepEqual(channelInvocation(command,params('DIRECT')),{args:['manage','update-join-guild-setting','--json','--guild-id=123','--join-type=JOIN_GUILD_TYPE_DIRECT']});
  assert.ok(channelJoinSettingsCommand(command).stdin_parameters.setting.description.includes('question, not title'));
});

test('advanced join settings reject missing or untyped content, unknown keys, contradictory types and impossible quizzes',()=>{
  const cases=[params('MULTI_QUESTION'),params('QUIZ',{quiz:{items:[],minAnswerNum:1,minCorrectAnswerNum:1}}),
    params('MULTI_QUESTION',{question:{items:[{title:'错误字段',answer:'2'}]}}),
    params('MULTI_QUESTION',{question:{items:[{question:'题',answer:2}]}}),
    params('QUESTION_WITH_ADMIN_AUDIT',{question:{items:[{question:'题',cookie:'secret'}]}}),
    params('MULTI_QUESTION',{join_type:'JOIN_GUILD_TYPE_DIRECT',question:{items:[{question:'题',answer:'2'}]}}),
    params('DIRECT',{question:{items:[{question:'题'}]}}),{...multi(),'guild-id':123},
    {...multi(),setting:{...multi().setting,token:'secret'}}];
  for(const change of [q=>{q.setting.quiz.items[0].correctAnswer='丙';},q=>{q.setting.quiz.items[0].answers=['甲','甲'];},q=>{q.setting.quiz.minAnswerNum='1';},q=>{q.setting.quiz.minCorrectAnswerNum=2;},q=>{q.setting.quiz.minAnswerNum=2;}]){const p=quiz();change(p);cases.push(p);}
  for(const parameters of cases)assert.throws(()=>channelInvocation(command,parameters),/channel_/);
});

test('nested join questions survive paged actual-receipt review, persistence and explicit one-time confirmation',async t=>{
  const parameters=multi();parameters.setting.question.items[0].question='完整长题目'.repeat(550);
  const f=await fixture(t,parameters),id=await begin(f),p=f.service.state.proposals[id];
  assert.ok(p.reviewProgress.pageCount>1);assert.equal(f.calls.length,0);
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(f.calls.length,0);
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',generate:f.generate,run:f.run}).init();t.after(()=>restored.stop());
  await finishReview(restored,id,f.send);
  await restored.process(event('/channel-confirm '+id),f.send);assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].args,['manage','update-join-guild-setting','--json','--yes']);
  assert.deepEqual(JSON.parse(f.calls[0].options.stdin).setting.question,parameters.setting.question);
  await restored.process(event('/channel-confirm '+id),f.send);assert.equal(f.calls.length,1);
});

test('changing nested answers after review cancels before stdin can execute',async t=>{
  const f=await fixture(t,multi()),id=await begin(f),p=f.service.state.proposals[id];
  p.parameters.setting.question.items[0].answer='未审阅答案';
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(f.calls.length,0);assert.equal(p.status,'canceled');
});

test('forget during durable execution marker prevents advanced stdin write',async t=>{
  const f=await fixture(t,quiz()),id=await begin(f),p=f.service.state.proposals[id],save=f.service.save.bind(f.service);
  f.service.save=async()=>{if(p.status==='executing'){f.service.save=save;await f.service.forget(event('/forget'));}return save();};
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(f.calls.length,0);assert.equal(p.status,'canceled');
});

test('stdin invocation exception is uncertain and is never replayed by a later confirmation',async t=>{
  const f=await fixture(t,multi()),id=await begin(f);let runs=0;
  f.service.run=async()=>{runs++;throw Error('synthetic pipe failure');};
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(f.service.state.proposals[id].status,'uncertain');
  await f.service.process(event('/channel-confirm '+id),f.send);assert.equal(runs,1);
});

test('CLI stdin transport pipes UTF-8 JSON directly without shell or duplicate flags',async()=>{
  const invocation=channelInvocation(command,multi());let launched,written='';
  const spawnProcess=(exe,args,options)=>{
    launched={exe,args,options};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    child.stdin=new Writable({write(chunk,encoding,callback){written+=chunk.toString('utf8');callback();},final(callback){callback();setImmediate(()=>{child.stdout.write(JSON.stringify({success:true,data:{accepted:true}}));child.emit('close',0);});}});
    return child;
  };
  const response=await channelCli(path.resolve('.'),invocation.args,{stdin:invocation.stdin,spawnProcess});
  assert.equal(response.success,true);assert.equal(written,invocation.stdin+'\n');assert.equal(launched.options.shell,false);assert.equal(launched.options.windowsHide,true);
  assert.deepEqual(launched.options.stdio,['pipe','pipe','pipe']);assert.deepEqual(launched.args,invocation.args);
  assert.equal(launched.options.env.TEMP,path.join(path.resolve('.'),'temp'));assert.equal(launched.options.env.QQ_APP_SECRET,undefined);
});

test('CLI rejects invalid stdin and timeout options before spawning a child',async()=>{
  const spawnProcess=()=>assert.fail('invalid request must never spawn');
  await assert.rejects(()=>channelCli(path.resolve('.'),['manage','synthetic'],{stdin:{},spawnProcess}),/invalid_stdin/);
  await assert.rejects(()=>channelCli(path.resolve('.'),['manage','synthetic'],{stdin:'\0',spawnProcess}),/invalid_stdin/);
  await assert.rejects(()=>channelCli(path.resolve('.'),['manage','synthetic'],{timeoutMs:0,spawnProcess}),/invalid_timeout/);
});
