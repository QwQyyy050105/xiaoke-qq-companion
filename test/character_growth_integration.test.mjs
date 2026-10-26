import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {Companion,hash} from '../src/core.mjs';
import {CharacterGrowth} from '../src/character_growth.mjs';
import {compactReferences} from '../src/prompt_references.mjs';
import {conversationPrompt,parseChatResponse,parseSocialResponse} from '../src/model_client.mjs';
const group=(id,content)=>({id,content,group_openid:'synthetic-group',author:{member_openid:'synthetic-member'}});
const change=id=>({operation:'upsert',id:'',kind:'style',text:'接梗时一句就收，不再跟一段解释。',source_message_id:id,source_excerpt:'接梗别解释一大串'});
async function fixture(t,generate){
 const base=resolve('temp'),dataDir=await mkdtemp(join(base,'character_flow_'));
 t.after(async()=>{assert.ok(resolve(dataDir).startsWith(base+sep));await rm(dataDir,{recursive:true,force:true});});
 const characterGrowth=await CharacterGrowth.open({dataDir});const errors=[];
 const bot=await new Companion({dataDir,pairingHash:hash('synthetic'),characterGrowth,generate,onMemoryError:e=>errors.push(e.message)}).init();
 return {bot,characterGrowth,dataDir,errors};
}
test('real evidence IDs survive parsing and committed growth is read by the next reply and after restart',async t=>{
 const calls=[];
 const f=await fixture(t,async input=>{
  calls.push(input);const refs=compactReferences(input);
  return refs.restore(parseChatResponse(JSON.stringify({reply:'好，锅盖我先扣上。',character_updates:calls.length===1?[change(refs.input.messageId)]:[]}),{backgroundMemory:true}));
 });
 const event=group('long-real-message-id','接梗别解释一大串');await f.bot.handle(event,async()=>({id:'sent-1'}));
 assert.equal(f.characterGrowth.snapshot(event).entries.length,1);
 assert.equal(f.characterGrowth.snapshot(event).entries[0].source_message_id,event.id);
 await f.bot.handle(group('next','锅拿来了'),async()=>({id:'sent-2'}));
 assert.equal(calls[1].characterGrowth.entries.length,1);
 const restored=await CharacterGrowth.open({dataDir:f.dataDir});assert.equal(restored.snapshot(event).entries.length,1);
 assert.equal(restored.snapshot({id:'private',author:{user_openid:'synthetic-owner'}}).entries.length,0);
 assert.match(restored.summary(event),/一句就收/);
});
test('received feedback is learned even when sending the acknowledgement fails',async t=>{
 const f=await fixture(t,async input=>({reply:'懂。',character_updates:[change(input.messageId)]}));
 const event=group('failed','接梗别解释一大串');await assert.rejects(f.bot.handle(event,async()=>{throw Error('synthetic_send_failed');}));
 assert.equal(f.characterGrowth.snapshot(event).entries.length,1);
});
test('growth is grounded in the received message rather than an outgoing receipt',async t=>{
 const f=await fixture(t,async input=>({reply:'懂。',character_updates:[change(input.messageId)]}));
 for(const [id,delivery] of [['empty',{sent_text:'',delivered_messages:[]}],['unconfirmed',undefined]]){
  const event=group(id,'接梗别解释一大串');await f.bot.handle(event,async()=>delivery);
  assert.equal(f.characterGrowth.snapshot(event).entries.length,id==='empty'?1:2);
 }
});

test('listening silently preserves a new habit for the next turn',async t=>{
 const f=await fixture(t,async input=>({reply:'',social:{action:'silent'},expression:{mood:'playful',energy:0.7,continuity:'还在乐'},character_updates:[change(input.messageId)]}));
 const event={...group('listening','接梗别解释一大串'),allow_silence:true,explicit_mention:false};
 const result=await f.bot.handle(event,async()=>assert.fail('listening should not send'));
 assert.equal(result.status,'silent');
 const reopened=await CharacterGrowth.open({dataDir:f.dataDir});
 assert.equal(reopened.snapshot(event).entries.length,1);
 assert.equal(f.bot.room(event.group_openid).expression.mood,'playful');
});

test('a dynamic voice job learns feedback without waiting for audio delivery',async t=>{
 const f=await fixture(t,async input=>({reply:'知道啦',speech:{text:'知道啦',mood:'calm'},character_updates:[change(input.messageId)]}));
 const event=group('voice','接梗别解释一大串');
 const result=await f.bot.handle(event,async()=>({deferredSpeech:{status:'queued'},sent_text:'',delivered_messages:[]}));
 assert.equal(result.status,'deferred_speech');
 assert.equal(f.characterGrowth.snapshot(event).entries.length,1);
});
test('forget during delivery invalidates pending growth without discarding the successful chat',async t=>{
 const f=await fixture(t,async input=>({reply:'好。',character_updates:[change(input.messageId)]}));
 const event=group('stale','接梗别解释一大串');
 await f.bot.handle(event,async()=>{await f.characterGrowth.forget(event);return {id:'sent'};});
 assert.equal(f.characterGrowth.snapshot(event).entries.length,0);assert.ok(f.errors.length<=1);
});
test('private owner gets scoped current-message growth, and reset removes it',async t=>{
 const f=await fixture(t,async input=>({reply:'嗯。',character_updates:[change(input.messageId)]}));
 const event={id:'p1',content:'/pair synthetic',author:{user_openid:'owner'}};
 await f.bot.handle(event,async()=>({id:'paired'}));
 await f.bot.handle({...event,id:'p2',content:'接梗别解释一大串'},async()=>({id:'sent'}));
 assert.equal(f.characterGrowth.snapshot(event).entries.length,1);
 await f.bot.handle({...event,id:'p3',content:'/reset'},async()=>({id:'reset'}));
 assert.equal(f.characterGrowth.snapshot(event).entries.length,0);
});
test('prompt exposes effective growth as scoped data and proactive parser retains optional edits',()=>{
 const growth={revision:2,entries:[{id:'growth_1',kind:'style',text:'轻轻接一句'}]};
 const prompt=conversationPrompt('synthetic',{structured:true,backgroundMemory:true,text:'好累',characterGrowth:growth});
 assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)).character_growth,growth);
 assert.doesNotMatch(prompt,/大多15到70字|小柯固定角色由本机主人维护/);
 const parsed=parseSocialResponse(JSON.stringify({reply:'锅来了。',social:{action:'say'},character_updates:[change('old-message')]}));
 assert.deepEqual(parsed.character_updates,[change('old-message')]);
});
