import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService,channelArgs,sanitizeChannelResult} from '../src/channel_service.mjs';

const commands=JSON.parse(await fs.readFile(new URL('../src/channel_commands.json',import.meta.url),'utf8'));
const command=name=>commands.find(item=>item.name===name);
const event=(id,content,group)=>({id,content,...(group?{group_openid:group,author:{member_openid:'member'}}:{author:{user_openid:'owner'}})});
const plan=(action,parameters={})=>({reply:'合成验证',action,parameters_json:JSON.stringify(parameters)});
const delivered=text=>({sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic-message'}]});
async function fixture(t,generate,run){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_parameters_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  const service=await new ChannelService({root,generate,run,getOwner:()=> 'owner'}).init();
  t.after(async()=>{await service.stop();assert.ok(path.resolve(root).startsWith(base+path.sep));await fs.rm(root,{recursive:true,force:true});});
  return service;
}

test('official pagination cursors and guild description remain literal supported business parameters',()=>{
  for(const [name,parameters,expected]of[
    ['manage.search-guild-content',{keyword:'数学','next-page-token':'opaque+/=% token'},'--next-page-token=opaque+/=% token'],
    ['manage.get-guild-member-list',{'guild-id':'123','next-page-token':'page-two'},'--next-page-token=page-two'],
    ['feed.search-guild-feeds',{'guild-id':'123','next-page-cookie':'opaque;cursor'},'--next-page-cookie=opaque;cursor'],
    ['manage.update-guild-info',{'guild-id':'123','guild-profile':'数学交流；保留原文'},'--guild-profile=数学交流；保留原文']
  ])assert.ok(channelArgs(command(name),parameters).includes(expected));
});

test('business exceptions do not admit credential, file or unknown-command parameters',()=>{
  const forbidden=['access-token','refresh-token','app-secret','cookie','content-file','image-path','image','video','avatar','ref','resume-id','session','yes','confirm','guild-profile-file','next-page-token-file','push-command','__worker__'];
  const c={name:'manage.synthetic',flags:forbidden.map(name=>({name,type:'string'}))};
  for(const name of forbidden)assert.throws(()=>channelArgs(c,{[name]:'synthetic'}),/channel_parameter_not_supported/);
  assert.throws(()=>channelArgs(command('feed.get-feed-detail'),{'feed-id':'123','next-page-token':'not-in-this-schema'}),/channel_parameter_not_supported/);
});

test('the actual CLI result sanitizer preserves only known business cursor fields while removing credential cookies',()=>{
  const result=sanitizeChannelResult({success:true,data:{next_page_cookie:'synthetic-next-cookie','next-page-cookie':'synthetic-hyphen-cookie',next_page_token:'synthetic-next-token','next-page-token':'synthetic-hyphen-token',
    cookie:'secret-fixture',cookies:{a:'secret-fixture'},access_token:'secret-fixture','access-token':'secret-fixture',refresh_token:'secret-fixture',app_secret:'secret-fixture',authorization:'secret-fixture',credentials:'secret-fixture',
    nested:[{next_page_cookie:'nested-cursor',session_cookie:'secret-fixture'}]}});
  assert.equal(result.data.next_page_cookie,'synthetic-next-cookie');assert.equal(result.data['next-page-cookie'],'synthetic-hyphen-cookie');
  assert.equal(result.data.next_page_token,'synthetic-next-token');assert.equal(result.data['next-page-token'],'synthetic-hyphen-token');
  assert.deepEqual(result.data.nested,[{next_page_cookie:'nested-cursor'}]);assert.doesNotMatch(JSON.stringify(result),/secret-fixture/);
  assert.ok(channelArgs(command('feed.search-guild-feeds'),{'guild-id':'123','next-page-cookie':result.data.next_page_cookie}).includes('--next-page-cookie=synthetic-next-cookie'));
  assert.ok(channelArgs(command('manage.search-guild-content'),{keyword:'数学','next-page-token':result.data.next_page_token}).includes('--next-page-token=synthetic-next-token'));
});

test('group public search exposes pagination and carries a real prior mocked cursor into the next call',async t=>{
  let step=0;const calls=[];
  const service=await fixture(t,async input=>{
    const search=input.channelCommands.find(c=>c.name==='manage.search-guild-content');assert.ok(search.flags.some(f=>f.name==='next-page-token'));
    assert.ok(!input.channelCommands.some(c=>c.name==='manage.update-guild-info'));
    if(step++===0)return plan(search.name,{keyword:'数学',scope:'feed'});
    if(step===2)return plan(search.name,{keyword:'数学',scope:'feed','next-page-token':input.channelTrace.at(-1).result.data.next_page_token});
    return plan('finish');
  },async args=>{calls.push(args);return sanitizeChannelResult({success:true,data:{next_page_token:'synthetic-page-two',feeds:[]}});});
  await service.process(event('search','搜索腾讯频道数学帖子','synthetic-group'),async()=>{});
  assert.equal(calls.length,2);assert.ok(calls[1].includes('--next-page-token=synthetic-page-two'));
});

test('owner can prepare a description change while media paths stay unavailable and no mutation executes',async t=>{
  const service=await fixture(t,async input=>{
    const update=input.channelCommands.find(c=>c.name==='manage.update-guild-info');assert.ok(update.flags.some(f=>f.name==='guild-profile'));
    assert.ok(!input.channelCommands.some(c=>c.name==='manage.upload-guild-avatar'));
    assert.ok(!input.channelCommands.some(c=>c.name==='manage.notify-daemon'));
    assert.ok(input.channelCommands.every(c=>c.flags.every(f=>!['push-command','__worker__'].includes(f.name))));
    assert.ok(!input.channelCommands.find(c=>c.name==='feed.publish-feed').flags.some(f=>f.name==='content-file'||f.name==='image'||f.name==='video'));
    return plan(update.name,{'guild-id':'123456789','guild-profile':'合成频道简介'});
  },async()=>assert.fail('No mutation before owner confirmation'));
  await service.process(event('description','修改腾讯频道123456789简介'),async()=>{});
  const proposals=Object.values(service.state.proposals);assert.equal(proposals.length,1);assert.equal(proposals[0].status,'pending');assert.equal(proposals[0].parameters['guild-profile'],'合成频道简介');
});

test('shortcut waiting persists its real continuation receipt, never claims completion and never replays after restart',async t=>{
  let calls=0;const replies=[];
  const service=await fixture(t,async()=>plan('feed.delete-and-mute',{'guild-id':'123456789',query:'合成关键词'}),async()=>{
    calls++;return{success:true,data:{status:'waiting',id:'s-synthetic-real-receipt',pending:{type:'pick',options:[{title:'合成选项'}],resume_command:'untrusted command must never execute'}}};
  });
  await service.process(event('create','在腾讯频道123456789删除合成关键词帖子并禁言'),async x=>{replies.push(x);return delivered(x);});
  const id=Object.keys(service.state.proposals)[0];await service.process(event('confirm','/channel-confirm '+id),async x=>replies.push(x));
  assert.equal(calls,1);assert.equal(service.state.proposals[id].status,'waiting');assert.match(replies.at(-1),/尚未完成/);assert.doesNotMatch(replies.at(-1),/已成功执行|s-synthetic|untrusted command/);
  const saved=JSON.parse(await fs.readFile(service.path,'utf8'));assert.equal(saved.proposals[id].result.data.id,'s-synthetic-real-receipt');
  const restored=await new ChannelService({root:service.root,getOwner:()=> 'owner',generate:async()=>assert.fail('No replan'),run:async()=>assert.fail('No repeated write')}).init();
  await restored.process(event('repeat','/channel-confirm '+id),async x=>replies.push(x));assert.match(replies.at(-1),/尚未完成/);
  await restored.process({...event('other','/channel-confirm '+id),author:{user_openid:'different-owner'}},async x=>replies.push(x));assert.match(replies.at(-1),/没有找到/);
  await restored.stop();assert.equal(calls,1);
});

for(const [label,result,status]of[
  ['done',{success:true,data:{status:'done',result:{success:true}}},'completed'],
  ['nested failure',{success:true,data:{status:'done',result:{success:false,error:{message:'synthetic_failure'}}}},'failed'],
  ['missing terminal status',{success:true,data:{result:{success:true}}},'uncertain']
])test('shortcut '+label+' is classified from terminal evidence',async t=>{
  let calls=0;const replies=[];
  const service=await fixture(t,async()=>plan('feed.delete-and-mute',{'guild-id':'123456789',query:'合成关键词'}),async()=>{calls++;return result;});
  await service.process(event('create','在腾讯频道123456789删除合成关键词帖子并禁言'),delivered);
  const id=Object.keys(service.state.proposals)[0];await service.process(event('confirm','/channel-confirm '+id),async x=>replies.push(x));
  assert.equal(service.state.proposals[id].status,status);assert.equal(calls,1);
  if(status!=='completed')assert.doesNotMatch(replies.at(-1),/已成功执行/);
  await service.process(event('repeat','/channel-confirm '+id),async()=>{});assert.equal(calls,1);
});

test('an old pending notification daemon proposal cannot bypass the unavailable command filter',async t=>{
  const service=await fixture(t,async()=>plan('manage.update-guild-info',{'guild-id':'123456789','guild-profile':'合成说明'}),async()=>assert.fail('No daemon execution'));
  await service.process(event('create','修改腾讯频道123456789简介'),async()=>{});
  const id=Object.keys(service.state.proposals)[0],proposal=service.state.proposals[id];proposal.action='manage.notify-daemon';proposal.parameters={'push-command':'synthetic','__worker__':true};await service.save();
  const replies=[];await service.process(event('confirm','/channel-confirm '+id),async x=>replies.push(x));
  assert.equal(proposal.status,'unsupported');assert.match(replies.at(-1),/没有启动/);assert.doesNotMatch(replies.at(-1),/已成功执行/);
});
