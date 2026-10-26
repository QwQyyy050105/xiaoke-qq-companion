import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {generator,conversationPrompt} from '../src/model_client.mjs';

test('actual generator selects companion instructions only for conversation, and re-reads the edited card',async t=>{
 const base=resolve('temp'),root=await mkdtemp(join(base,'companion_prompt_'));
 await mkdir(join(root,'temp'));await mkdir(join(root,'data'));
 t.after(async()=>{assert.equal(dirname(await realpath(root)),await realpath(base));await rm(root,{recursive:true,force:true});});
 const card={name:'小柯',core:[],voice:[],editable_persona:'ROLE_BEFORE_EDIT'};
 await writeFile(join(root,'character_card.json'),JSON.stringify(card));
 await writeFile(join(root,'voice_profile.json'),JSON.stringify({spoken_delivery:'SPOKEN_ONLY_REFERENCE'}));
 const calls=[];
 const generate=generator(root,{codexPath:process.execPath,media:{tts:true}},{spawnProcess:(_exe,args)=>{
  const row={args,prompt:''};calls.push(row);const child=new EventEmitter();
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};child.unref=()=>{};
  child.stdin=new Writable({write(chunk,_enc,done){row.prompt+=chunk.toString();done();},final(done){done();queueMicrotask(()=>{
   const result=args.some(a=>a.endsWith('memory_capture_v2.schema.json'))?{personal:[],room:[]}:{reply:'好的',memories:[]};
   child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}})+'\n');
   child.emit('close',0);
  });}});return child;
 }});
 await generate({text:'嗨',structured:true,speechStatus:{ready:false}});
 await writeFile(join(root,'character_card.json'),JSON.stringify({...card,editable_persona:'ROLE_AFTER_EDIT'}));
 await generate({text:'想听你说两句',structured:true,speechStatus:{ready:true}});
 await generate({mode:'memory_capture',structured:true,messages:[]});
 assert.ok(calls[0].args.some(a=>a.startsWith('model_instructions_file=')&&a.includes('companion_instructions.txt')));
 assert.ok(calls[1].args.some(a=>a.startsWith('model_instructions_file=')));
 assert.ok(!calls[2].args.some(a=>a.startsWith('model_instructions_file=')));
 assert.match(calls[0].prompt,/ROLE_BEFORE_EDIT/);assert.doesNotMatch(calls[1].prompt,/ROLE_BEFORE_EDIT/);
 assert.match(calls[1].prompt,/ROLE_AFTER_EDIT/);assert.doesNotMatch(calls[2].prompt,/ROLE_AFTER_EDIT/);
 assert.doesNotMatch(calls[0].prompt,/SPOKEN_ONLY_REFERENCE/);assert.match(calls[1].prompt,/SPOKEN_ONLY_REFERENCE/);
 for(const row of calls){assert.ok(row.args.includes('read-only'));assert.ok(row.args.includes('model_reasoning_effort="low"'));assert.ok(!row.args.some(a=>a.startsWith('service_tier=')));}
});

test('media instructions follow actual inputs while short follow-ups retain math and creation capabilities',()=>{
 const input={runtimeCapabilities:{math:{available:true},image_generation:{available:true}},text:'那就做吧',structured:true,backgroundMemory:true,history:[{role:'user',content:'把刚才的极限解答做成图'}]};
 const plain=conversationPrompt('CUSTOM_PERSONALITY',input);
 assert.doesNotMatch(plain,/【现成图片】|【本轮看图】|【已有语音】|语音任务语义|能A但是不能B|念稿组/);
 assert.match(plain,/math_document/);assert.match(plain,/media.create_prompt/);
 const visual=conversationPrompt('CUSTOM_PERSONALITY',{...input,mediaCatalog:[{id:'actual_sticker'}],visionFiles:[{id:'actual_image'}],voiceCatalog:[{id:'actual_voice'}]});
 assert.match(visual,/【现成图片】/);assert.match(visual,/【本轮看图】/);assert.match(visual,/【已有语音】/);
 assert.deepEqual(JSON.parse(visual.split('\n').at(-1)).image_inputs,[{id:'actual_image'}]);
 assert.match(plain,/把刚才的极限解答做成图/);
});

test('active character stays independent of voice profile and old singing incident',async()=>{
 const card=JSON.parse(await readFile('character_card.json','utf8'));
 assert.doesNotMatch(card.editable_persona,/念白|唱歌|speech|能力介绍/);
 const prompt=conversationPrompt(card.editable_persona,{structured:true,backgroundMemory:true,text:'大家今晚聊什么呀'});
 assert.equal(prompt.split(card.editable_persona).length-1,1);
 assert.ok(prompt.length<6500,'empty-context chat no longer carries the old complete workflow manual');
});
