import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Companion,hash} from '../src/core.mjs';
import {loadCharacter,characterRequest,characterSummary,normalizeExpression,expressionView} from '../src/character.mjs';
import {speechRequest,validateSpeechText} from '../src/speech.mjs';
import {parseChatResponse} from '../src/model_client.mjs';
const group=(id,room='a')=>({id,group_openid:room,author:{member_openid:'member'},content:'你好'});
async function fixture(t,generate,prepareInput){const dataDir=await mkdtemp(join(process.cwd(),'temp','character_test_'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return new Companion({dataDir,pairingHash:hash('test'),generate,prepareInput}).init();}
test('character card is readable and role mood expires instead of becoming permanent',async()=>{
 const card=await loadCharacter(process.cwd());assert.match(characterSummary(card),/柯霜/);assert.equal(characterRequest('看看你的人格卡'),true);
 const state=normalizeExpression({mood:'playful',energy:5,continuity:'锅'},0);assert.equal(state.energy,1);assert.equal(expressionView(state,100).mood,'playful');assert.equal(expressionView(state,5*3600000).mood,'calm');
});
test('mood follows conversation scope and survives restart, then forget clears it',async t=>{
 const inputs=[];const generate=async input=>{inputs.push(input);return {reply:'哼哼',expression:{mood:'playful',energy:0.8,continuity:'锅'}};};
 const bot=await fixture(t,generate);await bot.handle(group('1'),async()=>({id:'r1'}));await bot.handle(group('2'),async()=>({id:'r2'}));assert.equal(inputs.at(-1).expressionState.mood,'playful');
 await bot.handle(group('3','b'),async()=>({id:'r3'}));assert.equal(inputs.at(-1).expressionState,undefined);
 const restored=await new Companion({dataDir:bot.dataDir,generate,pairingHash:hash('test')}).init();await restored.handle(group('4'),async()=>({id:'r4'}));assert.equal(inputs.at(-1).expressionState.mood,'playful');
 await restored.handle({...group('5'),content:'/forget'},async()=>{});await restored.handle(group('6'),async()=>({id:'r6'}));assert.equal(inputs.at(-1).expressionState,undefined);
});
test('a visually verified sticker can be remembered silently with no fabricated assistant message',async t=>{
 const bot=await fixture(t,async()=>({reply:'',social:{action:'silent'},media:{remember_sticker:true,note_id:'received_ok',note:'猫猫摇头',tags:['摇头'],usage:'拒绝'}}),async()=>({visionFiles:[{id:'received_ok'}]}));let options;
 const result=await bot.handle({...group('s'),allow_silence:true},async(text,extra)=>{assert.equal(text,'');options=extra;return {delivered_messages:[]};});
 assert.equal(options.media.collect_id,'received_ok');assert.equal(options.media.remember_sticker,true);assert.equal(result.status,'silent');assert.ok(!bot.groupContext('a').some(x=>x.role==='assistant'));
});
test('unseen images cannot gain automatic sticker memory, voice-only response remains valid',async t=>{
 const bot=await fixture(t,async()=>({reply:'',social:{action:'silent'},media:{remember_sticker:true,note_id:'unseen'}}));await bot.handle({...group('s'),allow_silence:true},async()=>assert.fail('unseen action'));
 const parsed=parseChatResponse(JSON.stringify({reply:'',memories:[],speech:{text:'晚安啦',mood:'sleepy'}}));assert.equal(parsed.speech.text,'晚安啦');
 assert.equal(speechRequest({content:'用语音说一句晚安'}),true);assert.equal(speechRequest({content:'不用语音'}),false);assert.throws(()=>validateSpeechText('a'.repeat(121)),/limit/);
});

 test('recognized stickers are collected by category but explicit do-not-save wins',async t=>{
 const bot=await fixture(t,async()=>({reply:'好好笑',media:{collect_id:'received_pic',image_kind:'sticker',note_id:'received_pic',note:'猫猫捂脸',tags:['捂脸'],usage:'尴尬'}}),async()=>({visionFiles:[{id:'received_pic'}]}));
 let options;await bot.handle(group('first'),async(text,extra)=>{options=extra;return{id:'reply1'};});assert.equal(options.media.remember_sticker,true);
 await bot.handle({...group('second'),content:'不要保存这张图'},async(text,extra)=>{options=extra;return{id:'reply2'};});assert.ok(!options.media.remember_sticker);assert.equal(options.media.collect_id,'');
 });
