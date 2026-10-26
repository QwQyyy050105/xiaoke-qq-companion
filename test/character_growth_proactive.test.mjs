import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {ProactiveCompanion} from '../src/proactive.mjs';
import {CharacterGrowth} from '../src/character_growth.mjs';

const MINUTE=60_000;
const group='synthetic-growth-group';
const event=(id,content='接梗别解释一大串')=>({chat_type:'group',group_openid:group,id,content,author:{member_openid:'synthetic-member'}});
const change=id=>({operation:'upsert',id:'',kind:'style',text:'接梗时一句就收，不再跟一段解释。',source_message_id:id,source_excerpt:'接梗别解释一大串'});
const draft=()=>({reply:'锅盖先扣住。',social:{action:'say'},character_updates:[change('source-1')]});
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

async function fixture(t,{generate,send}={}){
 const base=resolve('temp');await mkdir(base,{recursive:true});
 const dataDir=await mkdtemp(join(base,'character_proactive_'));
 let time=Date.parse('2026-10-24T10:00:00+08:00'),history=[];
 const characterGrowth=await CharacterGrowth.open({dataDir,now:()=>time});
 const calls=[],sent=[],logs=[];
 const bot=await new ProactiveCompanion({dataDir,characterGrowth,now:()=>time,random:()=>0,
  getRoomHistory:()=>structuredClone(history),
  generate:async input=>{calls.push(input);return generate?generate(input):draft();},
  send:async(...args)=>{sent.push(args);return send?send(...args):{sent_text:args[1]};},log:value=>logs.push(value)
 }).init();
 t.after(async()=>{bot.stop();await bot.writeQueue;assert.ok(resolve(dataDir).startsWith(base+sep));await rm(dataDir,{recursive:true,force:true});});
 const observe=async(id,content)=>{const value=event(id,content);history.push({role:'user',messageId:value.id,content:value.content,group_openid:group});await bot.observe(value);};
 await observe('source-1');
 return {bot,characterGrowth,dataDir,calls,sent,logs,observe,advance:()=>{time+=31*MINUTE;},
  forget:async()=>{history=[];await bot.observe(event('forget-now','/forget'));await characterGrowth.forget({group_openid:group});},
  snapshot:()=>characterGrowth.snapshot({group_openid:group}),
  reopened:async()=>(await CharacterGrowth.open({dataDir})).snapshot({group_openid:group})};
}

test('proactive reflection persists before delivery and is supplied to the next generation',async t=>{
 const sending=gate(),delivered=gate();let count=0;
 const f=await fixture(t,{generate:()=>++count===1?draft():{reply:'刚才那个锅，谁拿走了。',social:{action:'say'},character_updates:[]},
  send:async(_group,text)=>{if(count===1){sending.resolve();await delivered.promise;}return {delivered_messages:[{content:text}]};}});
 f.advance();const pending=f.bot.tick();await sending.promise;
 assert.equal(f.snapshot().entries.length,1,'received history supports learning before an outgoing message');
 assert.equal((await f.reopened()).entries.length,1);
 delivered.resolve();assert.equal(await pending,true);
 assert.equal(f.snapshot().entries.length,1);assert.equal(f.snapshot().entries[0].source_message_id,'source-1');
 assert.deepEqual(await f.reopened(),f.snapshot());
 await f.observe('next-turn','小柯，接着聊。');f.advance();assert.equal(await f.bot.tick(),true);
 assert.equal(f.calls[1].characterGrowth.entries.length,1);
 assert.equal(f.calls[1].characterGrowth.entries[0].text,change('source-1').text);
 assert.equal(f.characterGrowth.snapshot({group_openid:'different-synthetic-group'}).entries.length,0);
});

for(const [name,send] of [
 ['failed transport',async()=>{throw Error('synthetic_send_failed');}],
 ['empty receipt',async()=>({sent_text:'',delivered_messages:[]})],
 ['legacy undefined receipt',async()=>undefined],
 ['unconfirmed object',async()=>({})]
]){
 test(`proactive learning does not depend on ${name}`,async t=>{
  const f=await fixture(t,{send});f.advance();await f.bot.tick();
  assert.equal(f.snapshot().entries.length,1);
  assert.equal((await f.reopened()).entries.length,1);
 });
}

test('a silent proactive decision preserves reflection without sending a message',async t=>{
 const f=await fixture(t,{generate:()=>({...draft(),reply:'',social:{action:'silent'}})});f.advance();
 assert.equal(await f.bot.tick(),false);assert.equal(f.sent.length,0);assert.equal(f.snapshot().entries.length,1);
});

for(const stage of ['generation','delivery'])for(const invalidation of ['forget','new room version']){
 test(`${invalidation} during proactive ${stage} cannot revive an old growth proposal`,async t=>{
  const started=gate(),release=gate();
  const f=await fixture(t,{
   generate:async()=>{if(stage==='generation'){started.resolve();await release.promise;}return draft();},
   send:async(_group,text)=>{if(stage==='delivery'){started.resolve();await release.promise;}return {sent_text:text};}
  });
  f.advance();const pending=f.bot.tick();await started.promise;
  if(invalidation==='forget')await f.forget();else await f.observe('newer-turn','小柯，这句刚才已经聊完啦。');
  const versionAfterInvalidation=f.snapshot().revision;
  release.resolve();assert.equal(await pending,stage==='delivery');
  assert.equal(f.snapshot().entries.length,stage==='delivery'&&invalidation==='new room version'?1:0);assert.equal(f.snapshot().revision,versionAfterInvalidation);
  assert.deepEqual(await f.reopened(),f.snapshot());
  if(stage==='generation')assert.equal(f.sent.length,0);
 });
}
