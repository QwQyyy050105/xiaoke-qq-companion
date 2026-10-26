import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {ChannelService,channelArgs,channelRequest} from '../src/channel_service.mjs';
const event=(id,text,group)=>({id,content:text,...(group?{group_openid:group,author:{member_openid:'member'}}:{author:{user_openid:'owner'}})});
const delivered=text=>({sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic-message'}]});
async function fixture(t,generate,run){const root=await mkdtemp(join(process.cwd(),'temp','channel_test_'));await mkdir(join(root,'src'));await copyFile('src/channel_commands.json',join(root,'src','channel_commands.json'));const s=await new ChannelService({root,generate,run,getOwner:()=> 'owner'}).init();t.after(async()=>{await s.stop();await rm(root,{recursive:true,force:true});});return s;}
test('channel intent avoids ordinary chat and args cannot invoke shells or read files',()=>{
 assert.equal(channelRequest('小柯，搜索腾讯频道里的数学帖子'),true);assert.equal(channelRequest('今天吃什么'),false);
 const c={name:'manage.search-guild-content',flags:[{name:'keyword',type:'string',required:true}]};
 assert.deepEqual(channelArgs(c,{keyword:'$(bad); & cmd'}),['manage','search-guild-content','--json','--keyword=$(bad); & cmd']);
 assert.throws(()=>channelArgs(c,{'content-file':'D:/secret'}));assert.throws(()=>channelArgs(c,{yes:true}));
});
test('group calls only public search and carries actual results into final response',async t=>{
 let step=0;const calls=[];
 const s=await fixture(t,async input=>{assert.ok(input.channelCommands.every(c=>c.risk==='read')); assert.ok(!input.channelCommands.some(c=>c.name==='manage.get-my-join-guild-info'));return step++===0?{reply:'',action:'manage.search-guild-content',parameters_json:'{"keyword":"数学","scope":"feed"}'}:(assert.equal(input.channelTrace.at(-1).result.success,true),{reply:'找到了数学讨论帖子。',action:'finish',parameters_json:'{}'});},async args=>{calls.push(args);return{success:true,data:[{title:'数学'}]};});
 const replies=[];assert.equal(s.start(event('one','搜索腾讯频道数学帖子','g'),async x=>replies.push(x)),true);await s.stop();assert.equal(calls.length,1);assert.equal(replies.at(-1),'找到了数学讨论帖子。');
 s.start(event('one','搜索腾讯频道数学帖子','g'),async()=>assert.fail('duplicate'));await s.stop();assert.equal(calls.length,1);
});
test('owner mutation is reviewed and only matching owner confirmation executes once',async t=>{
 let step=0,calls=0;const s=await fixture(t,async()=>step++===0?{reply:'',action:'manage.get-my-join-guild-info',parameters_json:'{}'}:{reply:'把测试频道名称改为新名称',action:'manage.update-guild-info',parameters_json:'{"guild-id":"123456789","name":"新名称"}'},async()=>{calls++;return{success:true,data:{guild_id:'123456789'}};});
 // Locate the live CLI flag rather than assume the name of a vendor field.
 const update=s.commands.find(c=>c.name==='manage.update-guild-info');const name=update.flags.find(f=>/name/.test(f.name)).name;
 s.generate=async()=>step++===0?{reply:'',action:'manage.get-my-join-guild-info',parameters_json:'{}'}:{reply:'将测试频道名称改为新名称',action:update.name,parameters_json:JSON.stringify({'guild-id':'123456789',[name]:'新名称'})};
 const replies=[];await s.process(event('a','修改腾讯频道名称'),async x=>{replies.push(x);return delivered(x);});
 assert.equal(calls,1);const id=Object.keys(s.state.proposals)[0];assert.ok(id);
 await s.process(event('bad','/channel-confirm '+id,'g'),async()=>{});assert.equal(calls,1);
 await s.process(event('ok','/channel-confirm '+id),async()=>{});assert.equal(calls,2);
 await s.process(event('again','/channel-confirm '+id),async()=>{});assert.equal(calls,2);
});
test('forget invalidates an in-flight channel result and prevents context restoration',async t=>{
 let release,started;const entered=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const s=await fixture(t,async()=>{started();await wait;return{reply:'late',action:'finish',parameters_json:'{}'};},async()=>assert.fail());
 const e=event('a','搜索腾讯频道猫','g');s.start(e,async()=>assert.fail('forgotten result'));await entered;await s.forget(e);release();await s.stop();assert.deepEqual(s.state.sessions,{});
});
test('write timeout is uncertain and repeated confirmation never duplicates a write',async t=>{
 const s=await fixture(t,async()=>({reply:'修改指定频道',action:'manage.update-guild-info',parameters_json:'{"guild-id":"123456789","guild-name":"测试"}'}),async()=>{throw Error('timeout');});
 await s.process(event('a','修改腾讯频道123456789名称'),delivered);const id=Object.keys(s.state.proposals)[0];assert.ok(id);
 await s.process(event('b','/channel-confirm '+id),async()=>{});assert.equal(s.state.proposals[id].status,'uncertain');
 s.run=async()=>assert.fail('must not retry');await s.process(event('c','/channel-confirm '+id),async()=>{});
});

 test('group post reads require actual search provenance in the same conversation',async t=>{
 let step=0;const calls=[];
 const plan=(action,params)=>({reply:'ok',action,parameters_json:JSON.stringify(params)});
 const s=await fixture(t,async()=>[plan('feed.get-feed-detail',{'feed-id':'private'}),plan('manage.search-guild-content',{keyword:'math',scope:'feed'}),plan('feed.get-feed-detail',{'feed-id':'public'}),plan('finish',{})][step++],async args=>{calls.push(args);return{success:true,data:{feeds:[{feed_id:'public'}]}};});
 await s.process(event('a','搜索腾讯频道帖子','room'),async()=>{});
 assert.equal(calls.length,2);assert.ok(calls[1].includes('--feed-id=public'));
 s.generate=async()=>plan('feed.get-feed-detail',{'feed-id':'public'});
 await s.process(event('b','搜索腾讯频道帖子','other-room'),async()=>{});assert.equal(calls.length,2);
 });
