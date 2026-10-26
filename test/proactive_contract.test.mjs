import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Companion, hash } from '../src/core.mjs';
import { conversationPrompt, parseSocialResponse } from '../src/model_client.mjs';

test('proactive contract retains valid expression and bounded speech, and advertises real availability',async()=>{
  const expression={mood:'playful',energy:0.7,continuity:'龙角先留着'};
  const output=parseSocialResponse(JSON.stringify({reply:'我把锅盖藏起来了。',social:{action:'say'},expression,speech:{text:'我把锅盖藏起来了。',mood:'playful'}}));
  assert.equal(output.expression.mood,'playful');assert.equal(output.speech.text,'我把锅盖藏起来了。');
  const invalid=parseSocialResponse(JSON.stringify({reply:'先坐一会儿。',social:{action:'say'},expression:{mood:'fabricated'},speech:{text:'长'.repeat(121)}}));
  assert.equal(invalid.reply,'先坐一会儿。');assert.equal(invalid.expression,undefined);assert.equal(invalid.speech,undefined);
  const prompt=conversationPrompt('synthetic persona',{mode:'proactive',structured:true,speechStatus:{available:false,reason:'paused',max_chars:120}});
  assert.match(prompt,/"speech_status":\{"available":false,"reason":"paused"/);
  assert.match(prompt,/不可用时用文字/);
  const schema=JSON.parse(await readFile('src/social_response.schema.json','utf8'));
  assert.ok(schema.required.includes('expression')&&schema.required.includes('speech'));
  assert.equal(schema.properties.speech.properties.text.maxLength,120);
});

test('proactive room expression persists in that room only and a stale send cannot recreate a forgotten state',async t=>{
  const base=resolve('temp'),dir=await mkdtemp(join(base,'expression_contract_'));
  t.after(async()=>{assert.ok(resolve(dir).startsWith(base+sep));await rm(dir,{recursive:true,force:true});});
  const open=()=>new Companion({dataDir:dir,pairingHash:hash('synthetic'),generate:async()=>({reply:'知道啦。'})}).init();
  let bot=await open();
  const event={id:'synthetic-event',content:'小柯，晚上好',group_openid:'room-a',author:{member_openid:'member-a'}};
  await bot.observeGroup(event);
  assert.equal(await bot.setGroupExpression('room-a',{mood:'happy',energy:0.8,continuity:'晚风'},()=>true),true);
  bot=await open();assert.equal(bot.groupExpression('room-a').mood,'happy');assert.equal(bot.groupExpression('room-b').mood,'calm');
  let current=false;
  await bot.handle({...event,id:'forget-event',content:'/forget'},async()=>{});
  assert.equal(await bot.setGroupExpression('room-a',{mood:'annoyed'},()=>current),false);
  bot=await open();assert.equal(bot.groupExpression('room-a').mood,'calm');
  assert.equal(await bot.setGroupExpression('unknown-room',{mood:'happy'},()=>true),false);
});
