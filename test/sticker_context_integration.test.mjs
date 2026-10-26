import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {Companion,hash} from '../src/core.mjs';
import {conversationPrompt,parseSocialResponse} from '../src/model_client.mjs';
import {compactReferences} from '../src/prompt_references.mjs';

const catalog=[{id:'approved_fixed',type:'sticker',source:'approved',title:'这题我会'},
  {id:'collected_tired',type:'sticker',source:'collected',title:'趴倒的小猫',usage_hint:'忙完以后累瘫了，想躺着休息'}];
const event={id:'current-message',group_openid:'synthetic-room',author:{member_openid:'synthetic-user'},content:'终于忙完了，好累，发个你收藏的表情'};
const selection={fit:'requested',message_id:event.id,catalog_evidence:'趴倒的小猫',intent:'接住忙完后累瘫想休息的情绪'};
async function setup(t,generate){
 const base=resolve('temp'),dataDir=await mkdtemp(join(base,'sticker_context_integration_'));
 const bot=await new Companion({dataDir,pairingHash:hash('synthetic'),generate,prepareInput:async()=>({mediaCatalog:catalog})}).init();
 t.after(async()=>{await bot.persistence;assert.ok(resolve(dataDir).startsWith(base+sep));await rm(dataDir,{recursive:true,force:true});});return bot;
}

test('core rejects fixed self sticker for a collected request but retains the substantive reply',async t=>{
 const bot=await setup(t,async()=>({reply:'终于能歇一会儿了。',media:{send_id:'approved_fixed',selection:{...selection,catalog_evidence:'这题我会'}}}));
 await bot.handle(event,async(text,options)=>{assert.equal(text,'终于能歇一会儿了。');assert.equal(options.media.send_id,'');return{id:'reply'};});
});

test('core retains a grounded collected choice and supplies the private current message ID',async t=>{
 let modelInput;const bot=await setup(t,async input=>{modelInput=input;return{reply:'',media:{send_id:'collected_tired',selection}};});
 await bot.handle(event,async(text,options)=>{assert.equal(text,'');assert.equal(options.media.send_id,'collected_tired');return{id:'image-receipt',delivered_messages:[{messageId:'image-receipt',content:'[发送图片：趴倒的小猫]'}]};});
 assert.equal(modelInput.messageId,event.id);
 const refs=compactReferences({messageId:event.id,text:'晚安',structured:true});
 const data=JSON.parse(conversationPrompt('synthetic',refs.input).split('\n').at(-1));
 assert.match(data.current_message.message_id,/^ref_local_/);
 assert.equal(refs.restore({media:{selection:{message_id:data.current_message.message_id}}}).media.selection.message_id,event.id);
});

test('media-only no-fit response falls back once without a false connection failure',async t=>{
 const bot=await setup(t,async()=>({reply:'',media:{send_id:'collected_tired',selection:{...selection,fit:'none'}}}));let calls=0;
 await bot.handle(event,async(text,options)=>{calls++;assert.match(text,/没找到贴合/);assert.equal(options.media.send_id,'');return{id:'text-receipt'};});assert.equal(calls,1);
});

test('social response retains same-turn selection for proactive validation',()=>{
 const value=parseSocialResponse(JSON.stringify({reply:'',social:{action:'say'},media:{send_id:'collected_tired',selection}}));
 assert.deepEqual(value.media.selection,selection);
});
