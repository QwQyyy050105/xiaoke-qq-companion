import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compactReferences } from '../src/prompt_references.mjs';
import { GroupRouter } from '../src/routing.mjs';
import { Companion, hash } from '../src/core.mjs';

test('request-local reference compression preserves bodies and restores actionable references', () => {
  const id='qq_'+ 'x'.repeat(300), ref='qq_'+ 'y'.repeat(300);
  const original={roomHistory:[{messageId:id,referenceId:ref,content:`原文 ${id}`}],turnMessages:[{messageId:id}],mediaCatalog:[{id:'sticker_original'}]};
  const c=compactReferences(original);
  assert.equal(c.input.roomHistory[0].content,original.roomHistory[0].content);
  assert.equal(c.input.mediaCatalog[0].id,'sticker_original');
  assert.equal(c.input.turnMessages[0].messageId,c.input.roomHistory[0].messageId);
  assert.ok(JSON.stringify(c.input).length<JSON.stringify(original).length-500);
  const answer=c.restore({delivery:{reply_to_message_id:c.input.roomHistory[0].messageId},room_memories:[{messageId:c.input.turnMessages[0].messageId}],reply:c.input.roomHistory[0].messageId});
  assert.equal(answer.delivery.reply_to_message_id,id);
  assert.equal(answer.room_memories[0].messageId,id);
  assert.equal(answer.reply,c.input.roomHistory[0].messageId);
  assert.deepEqual(original.roomHistory[0],{messageId:id,referenceId:ref,content:`原文 ${id}`});
});

test('reference aliases avoid collisions and do not leak across concurrent requests', () => {
  const a=compactReferences({roomHistory:[{messageId:'ref_local_1'},{messageId:'original-a'}]});
  const b=compactReferences({roomHistory:[{messageId:'original-b'}]});
  assert.notEqual(a.input.roomHistory[0].messageId,'ref_local_1');
  assert.equal(a.restore({messageId:a.input.roomHistory[1].messageId}).messageId,'original-a');
  assert.equal(b.restore({messageId:b.input.roomHistory[0].messageId}).messageId,'original-b');
});

test('contextual candidate skips classifier but does not extend activity by itself', async () => {
  let now=1_000_000;
  const router=new GroupRouter({now:()=>now,decideWithReply:true,classify:()=>assert.fail('second model call')});
  const event=id=>({id,group_openid:'room',author:{member_openid:'a'},content:'我也觉得好笑'});
  const history=[{role:'assistant',content:'猫像面包',at:now-1000}];
  assert.equal((await router.decide(event('one'),history)).reason,'contextual_candidate');
  assert.equal(router.groupActivity.size,0);
  assert.equal((await router.decide(event('two'),[])).addressed,false);
  assert.equal((await router.decide({...event('three'),mentions_other_members:true},history)).addressed,false);
  assert.equal((await router.decide({...event('four'),content:'小柯，在吗'},[])).reason,'called_by_name');
});

test('different rooms proceed independently while each room keeps order and memory', async t => {
  const dir=await mkdtemp(join(process.cwd(),'temp','realtime_'));
  let release, started;
  const blocked=new Promise(resolve=>release=resolve), entered=new Promise(resolve=>started=resolve);
  const calls=[];
  const bot=await new Companion({dataDir:dir,pairingHash:hash('test'),generate:async input=>{
    calls.push(input.text);
    if(input.text==='slow') {started();await blocked;}
    return 'reply '+input.text;
  }}).init();
  t.after(async()=>{release();await bot.persistence;await rm(dir,{recursive:true,force:true});});
  const event=(id,group,text)=>({id,group_openid:group,author:{member_openid:'a'},content:text});
  const slow=bot.handle(event('s','one','slow'),async()=>{});await entered;
  const second=bot.handle(event('s2','one','second'),async()=>{});
  const fast=bot.handle(event('f','two','fast'),async()=>{});
  await fast;
  assert.deepEqual(calls,['slow','fast']);
  release();await Promise.all([slow,second]);
  assert.deepEqual(calls,['slow','fast','second']);
  assert.equal(bot.groupContext('one').filter(x=>x.role==='assistant').length,2);
  assert.equal(bot.groupContext('two').filter(x=>x.role==='assistant').length,1);
});

test('single-pass candidate can stay silent without inventing an assistant history entry', async t => {
  const dir=await mkdtemp(join(process.cwd(),'temp','realtime_silent_'));
  const bot=await new Companion({dataDir:dir,pairingHash:hash('test'),prepareInput:async e=>({allowSilence:e.allow_silence}),generate:async input=>{
    assert.equal(input.allowSilence,true);return {reply:'',memories:[],social:{action:'silent'}};
  }}).init();
  t.after(async()=>{await bot.persistence;await rm(dir,{recursive:true,force:true});});
  const result=await bot.handle({id:'one',group_openid:'room',author:{member_openid:'a'},content:'老张我去拿快递了',allow_silence:true,explicit_mention:false},async()=>assert.fail('should not send'));
  assert.equal(result.status,'silent');
  assert.equal(bot.groupContext('room').filter(x=>x.role==='assistant').length,0);
});
