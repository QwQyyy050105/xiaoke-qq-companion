import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService,channelArgs,sanitizeChannelResult,groupChannelParametersAllowed} from '../src/channel_service.mjs';

const commands=JSON.parse(await fs.readFile(new URL('../src/channel_commands.json',import.meta.url),'utf8'));
const command=commands.find(c=>c.name==='feed.get-feed-comments');
const allowed=new Set(['public-feed','other-feed']);
const prior=(cursor='page-two',feed='public-feed',rank=0)=>({action:command.name,parameters:{'feed-id':feed,'rank-type':rank},result:{success:true,data:{comments:[{text:'合成评论'}],attach_info:cursor}}});
const can=(parameters,trace=[prior()])=>groupChannelParametersAllowed(command.name,parameters,trace,allowed);

test('the default 20-comment page remains complete and its long opaque cursor survives CLI sanitization and args',()=>{
  const cursor='x'.repeat(6500)+'+/=;end',raw={success:true,data:{comments:Array.from({length:20},(_,i)=>({id:String(i),text:'合成评论'+i})),attach_info:cursor},access_token:'secret',cookie:'secret'};
  const result=sanitizeChannelResult(raw);
  assert.equal(result.data.comments.length,20);assert.equal(result.data.attach_info,cursor);assert.equal(result._projection,undefined);
  assert.equal(result.access_token,undefined);assert.equal(result.cookie,undefined);
  const parameters={'feed-id':'public-feed','attach-info':result.data.attach_info,count:20,'rank-type':0,'reply-list-num':1};
  assert.ok(channelArgs(command,parameters).includes('--attach-info='+cursor));
  assert.equal(can(parameters,[{...prior(),result}]),true);
});

test('group comment count, rank and reply-preview flags obey documented bounds without granting management access',()=>{
  for(const parameters of [ {'feed-id':'public-feed',count:20,'rank-type':2,'reply-list-num':10}, {'feed-id':'public-feed',count:1,'rank-type':0,'reply-list-num':0} ])assert.equal(can(parameters),true);
  for(const parameters of [ {'count':21},{'count':0},{'rank-type':3},{'rank-type':-1},{'reply-list-num':11},{'reply-list-num':-1},{'resume-id':'x'},{'guild-id':'999'} ])assert.equal(can({'feed-id':'public-feed',...parameters}),false);
  assert.equal(groupChannelParametersAllowed('feed.get-feed-detail',{'feed-id':'public-feed',count:20},[],allowed),false);
});

test('a cursor must come from the latest complete same-post same-sort comment result',()=>{
  const params={'feed-id':'public-feed','attach-info':'page-two','rank-type':0};
  assert.equal(can(params),true);
  for(const trace of [[],[prior('page-two','other-feed')],[prior('page-two','public-feed',2)],[prior(),prior('page-three')],
    [{...prior(),result:{success:false,data:{attach_info:'page-two'}}}],
    [{...prior(),result:{success:true,data:{comments:[{attach_info:'page-two'}]}}}],
    [{...prior(),result:{success:true,truncated:true,data:{attach_info:'page-two'}}}],
    [{...prior(),result:{success:true,_projection:{truncated:true,paginationAllowed:false},data:{attach_info:'page-two'}}}]
  ])assert.equal(can(params,trace),false);
  assert.equal(can({...params,'feed-id':'private-feed'}),false);
  assert.equal(can({...params,'attach-info':'fabricated'}),false);
});

test('guild and channel parameters still require matching public post detail evidence',()=>{
  const detail={action:'feed.get-feed-detail',result:{success:true,data:{feed:{feed_id:'public-feed',guild_id:'123',channel_id:'456'}}}};
  const params={'feed-id':'public-feed','guild-id':'123','channel-id':'456',count:20};
  assert.equal(can(params,[detail]),true);assert.equal(can({...params,'channel-id':'999'},[detail]),false);
  assert.equal(can(params,[{...detail,result:{...detail.result,_projection:{truncated:true}}}]),false);
});

for(const [name,raw] of [
  ['oversized cursor',{success:true,data:{attach_info:'x'.repeat(10001),comments:[]}}],
  ['omitted comment',{success:true,data:{attach_info:'page-two',comments:Array.from({length:21},()=>({text:'短评论'}))}}],
  ['truncated comment text',{success:true,data:{attach_info:'page-two',comments:[{text:'x'.repeat(4501)}]}}],
  ['oversized whole page',{success:true,data:{attach_info:'page-two',comments:Array.from({length:20},()=>({text:'x'.repeat(2000)}))}}]
])test(name+' is explicitly partial and cannot advance past unread content',()=>{
  const result=sanitizeChannelResult(raw);
  assert.equal(result._projection.truncated,true);assert.equal(result._projection.paginationAllowed,false);assert.ok(result._projection.omissions.length);
  assert.equal(can({'feed-id':'public-feed','attach-info':'page-two'},[{...prior(),result}]),false);
  assert.ok(JSON.stringify(result).length<24000);
  if(name==='oversized cursor')assert.equal(result.data.attach_info,null);
});

test('a real service session can read two public comment pages, survive restart and reject a cursor in another group',async t=>{
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_paging_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  const services=[];t.after(async()=>{await Promise.all(services.map(s=>s.stop()));assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  const plan=(action,parameters={})=>({reply:'合成结果',action,parameters_json:JSON.stringify(parameters)});
  const event=(id,group)=>({id,group_openid:group,author:{member_openid:'member'},content:'查看腾讯频道评论'});
  let step=0;const calls=[];
  const run=async args=>{calls.push(args);return sanitizeChannelResult(args[0]==='manage'?{success:true,data:{feeds:[{feed_id:'public-feed'}]}}:{success:true,data:{comments:Array.from({length:20},(_,i)=>({text:'合成'+i})),attach_info:args.some(a=>a.startsWith('--attach-info='))?'page-three':'page-two'}});};
  const service=await new ChannelService({root,getOwner:()=> 'owner',run,generate:async()=>[
    plan('manage.search-guild-content',{keyword:'合成',scope:'feed'}),plan(command.name,{'feed-id':'public-feed',count:20,'rank-type':1,'reply-list-num':1}),plan('finish')][step++]}).init();services.push(service);
  await service.process(event('first','room-a'),async()=>{});assert.equal(calls.length,2);
  let nextStep=0;const restored=await new ChannelService({root,getOwner:()=> 'owner',run,generate:async()=>nextStep++===0?plan(command.name,{'feed-id':'public-feed','attach-info':'page-two','rank-type':1}):plan('finish')}).init();services.push(restored);
  await restored.process(event('next','room-a'),async()=>{});assert.equal(calls.length,3);assert.ok(calls[2].includes('--attach-info=page-two'));
  nextStep=0;await restored.process(event('cross','room-b'),async()=>{});assert.equal(calls.length,3);
  await restored.forget(event('forget','room-a'));nextStep=0;await restored.process(event('forgotten','room-a'),async()=>{});assert.equal(calls.length,3);
});
