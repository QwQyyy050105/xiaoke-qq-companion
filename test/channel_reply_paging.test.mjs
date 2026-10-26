import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService,groupChannelParametersAllowed,sanitizeChannelResult} from '../src/channel_service.mjs';

const action='feed.get-next-page-replies',allowed=new Set(['public']);
const detail={action:'feed.get-feed-detail',result:{success:true,data:{feed:{feed_id:'public',guild_id:'123',channel_id:'456'}}}};
const comments={action:'feed.get-feed-comments',parameters:{'feed-id':'public'},result:{success:true,data:{comments:[{comment_id:'comment-a',attach_info:'reply-one'},{comment_id:'comment-b',attach_info:'other-comment'}],attach_info:'comments-two'}}};
const params={'feed-id':'public','comment-id':'comment-a','guild-id':'123','channel-id':'456','attach-info':'reply-one',count:20};
const can=(p=params,trace=[detail,comments])=>groupChannelParametersAllowed(action,p,trace,allowed);
const reply=(cursor='reply-two',changes={})=>({action,parameters:{...params,...changes},result:{success:true,data:{replies:[{reply_id:'reply-a',content:'合成回复'}],attach_info:cursor}}});

test('public reply first page requires the specific comment cursor and actual guild/channel evidence',()=>{
  assert.equal(can(),true);
  for(const patch of [{'feed-id':'private'},{'comment-id':'missing'},{'attach-info':'comments-two'},{'attach-info':'other-comment'},{'guild-id':'999'},{'channel-id':'999'},{'count':21},{'count':0},{'attach-info':''},{'rank-type':0},{'resume-id':'s-x'}])assert.equal(can({...params,...patch}),false);
  assert.equal(can(params,[comments]),false);
  assert.equal(can(params,[detail]),false);
  assert.equal(can(params,[detail,{...comments,result:{success:true,data:{unknown_comments:comments.result.data.comments}}}]),false);
});

test('reply continuation binds the latest complete same-comment page and never falls back after failure or omission',()=>{
  const next={...params,'attach-info':'reply-two'};
  assert.equal(can(next,[detail,comments,reply()]),true);
  assert.equal(can(next,[detail,comments,reply('reply-two',{'comment-id':'comment-b'})]),false);
  assert.equal(can(next,[detail,comments,reply('reply-two',{'guild-id':'999'})]),false);
  assert.equal(can(next,[detail,comments,reply(),reply('reply-three')]),false);
  for(const bad of [{success:false},{success:true,truncated:true,data:{attach_info:'reply-two'}},{success:true,_projection:{truncated:true},data:{attach_info:'reply-two'}},{success:true,data:{replies:[{attach_info:'reply-two'}]}}]){
    assert.equal(can(next,[detail,comments,{...reply(),result:bad}]),false);
    assert.equal(can(params,[detail,comments,{...reply(),result:bad}]),false);
  }
});

test('reply cursors survive sanitization, while a partial comment or reply page cannot be consumed',()=>{
  const cursor='x'.repeat(6500)+'+/=a&b';
  const initial=sanitizeChannelResult({...comments.result,data:{comments:[{comment_id:'comment-a',attach_info:cursor}]}});
  assert.equal(can({...params,'attach-info':cursor},[detail,{...comments,result:initial}]),true);
  for(const result of [sanitizeChannelResult({success:true,data:{comments:Array.from({length:21},()=>({comment_id:'comment-a',attach_info:'reply-one'}))}}),{...comments.result,_projection:{truncated:true}}])assert.equal(can(params,[detail,{...comments,result}]),false);
  assert.equal(can(params,[{...detail,result:{...detail.result,_projection:{truncated:true}}},comments]),false);
});

test('actual service permits public replies, persists continuation, and rejects another group and forgotten context',async t=>{
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_reply_paging_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  const services=[];t.after(async()=>{await Promise.all(services.map(s=>s.stop()));assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  const calls=[],plans=[];
  const event=(id,group='group-a')=>({id,content:'查看腾讯频道评论回复',group_openid:group,author:{member_openid:'member'}});
  const plan=(a,p={})=>({action:a,parameters_json:JSON.stringify(p),reply:'合成内容'});
  const run=async args=>{calls.push(args);if(args[0]==='manage')return {success:true,data:{feeds:[{feed_id:'public'}]}};if(args[1]==='get-feed-detail')return detail.result;if(args[1]==='get-feed-comments')return comments.result;return reply(args.includes('--attach-info=reply-two')?'reply-three':'reply-two').result;};
  plans.push(plan('manage.search-guild-content',{keyword:'合成',scope:'feed'}),plan(detail.action,{'feed-id':'public'}),plan(comments.action,{'feed-id':'public'}),plan(action,params),plan('finish'));
  const create=async()=>{const service=await new ChannelService({root,getOwner:()=> 'owner',run,generate:async input=>{assert.ok(input.channelCommands.some(c=>c.name===action));return plans.shift()||plan('finish');}}).init();services.push(service);return service;};
  const service=await create();await service.process(event('first'),async()=>{});assert.equal(calls.length,4);
  const restored=await create();plans.push(plan(action,{...params,'attach-info':'reply-two'}),plan('finish'));
  await restored.process(event('second'),async()=>{});assert.equal(calls.length,5);assert.ok(calls.at(-1).includes('--attach-info=reply-two'));
  plans.push(plan(action,{...params,'attach-info':'reply-three'}),plan('finish'));await restored.process(event('cross','group-b'),async()=>{});assert.equal(calls.length,5);
  await restored.forget(event('forget'));plans.push(plan(action,{...params,'attach-info':'reply-three'}),plan('finish'));await restored.process(event('forgotten'),async()=>{});assert.equal(calls.length,5);
});
