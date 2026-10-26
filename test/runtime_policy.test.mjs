import {MemoryCapture} from '../src/memory_capture.mjs';
import {VocabularyResearch} from '../src/vocabulary_research.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {channelCli} from '../src/channel_service.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import http from 'node:http';
import {defaults,openPublicConfig} from '../src/public_config.mjs';
import {inspectRuntimeCapabilities,effectiveRole,prepareRuntimeInput,ttsCapability,ttsResidentStatus} from '../src/runtime_policy.mjs';
import {RuntimeScopeGuard,RUNTIME_AUTHORIZATION,applyRuntimeConfig,eventForMemoryCapture} from '../src/runtime_scope.mjs';
import {chatGenerator,conversationPrompt} from '../src/model_client.mjs';
import {MediaLibrary} from '../src/media.mjs';
import {SharedVoiceSpeech} from '../src/shared_voice_speech.mjs';
import {planReplySpeech} from '../src/reply_speech_route.mjs';
import {deliverProactiveSpeech} from '../src/proactive_speech.mjs';
import {Companion,hash} from '../src/core.mjs';
import {GroupInbox} from '../src/inbox.mjs';
import {QQClient} from '../src/qq.mjs';
import {startLocalConsole} from '../src/local_console.mjs';
import {ProactiveCompanion} from '../src/proactive.mjs';
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const event=(id='message')=>({id,group_openid:'room',chat_type:'group',author:{member_openid:'member'},content:'hello',timestamp:new Date().toISOString()});
async function fixture(t){await mkdir(resolve('temp'),{recursive:true});const root=await mkdtemp(resolve('temp','runtime_policy_'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'assets'));await mkdir(join(root,'temp'));for(const name of ['character_card.json','persona.txt','assets/console.html'])await copyFile(name,join(root,name));return root;}
async function service(t,handler){const server=http.createServer(handler);await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));return `http://127.0.0.1:${server.address().port}`;}

test('actual API generator describes only configured optional capabilities and suppresses stale ready TTS',async t=>{
 const root=await fixture(t);let observed;
 const baseURL=await service(t,async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;observed=JSON.parse(raw).messages[0].content;res.end(JSON.stringify({choices:[{message:{content:'{"reply":"ok","memories":[]}'}}]}));});
 const config=defaults();config.modelProvider={...config.modelProvider,type:'openai-compatible',baseURL,model:'synthetic-model',envKey:'RUNTIME_TEST_KEY'};
 process.env.RUNTIME_TEST_KEY='synthetic';t.after(()=>delete process.env.RUNTIME_TEST_KEY);
 await chatGenerator(root,config)({text:'make an image, PDF or channel post',speechStatus:{available:true,ready:true}});
 const data=JSON.parse(observed.split('\n\nRequired JSON response schema:')[0].split('\n').at(-1));
 assert.equal(data.runtime_capabilities.image_generation.available,false);assert.equal(data.runtime_capabilities.math.available,false);assert.equal(data.runtime_capabilities.channel.available,false);assert.equal(data.speech_status.available,false);
 assert.match(data.capabilities.channel,/不可用/);assert.match(data.capabilities.math,/不承诺/);assert.match(observed,/math_document必须为null/);
 assert.doesNotMatch(observed,/已接入腾讯频道工具|已接入确定性KaTeX|收发、识图、收藏和独立原生生图|【制作图片】/);
});
test('optional capability readiness tracks actual project files and explicit enablement without claiming login',async t=>{
 const root=await fixture(t),config=defaults();config.media.imageGeneration=true;
 const missing=await inspectRuntimeCapabilities(root,config,{findCodex:async()=>process.execPath,env:{}});assert.equal(missing.image_generation.available,false);
 await mkdir(join(root,'runtime','codex_home'),{recursive:true});await writeFile(join(root,'assets','reference.png'),PNG);await writeFile(join(root,'assets','media_approved.json'),JSON.stringify({images:[{id:'avatar',type:'avatar',path:'assets/reference.png'}]}));
 const browser=join(root,'runtime','browser-fixture');await writeFile(browser,'inert executable fixture');await writeFile(join(root,'runtime','math_runtime.json'),JSON.stringify({chromiumPath:browser}));
 const ready=await inspectRuntimeCapabilities(root,config,{findCodex:async()=>process.execPath,env:{XIAOKE_CHANNEL_CLI:browser}});
 assert.equal(ready.image_generation.available,true);assert.equal(ready.math.available,true);assert.equal(ready.channel.available,true);assert.match(ready.channel.reason,/unverified/);
 await rm(browser);assert.equal((await inspectRuntimeCapabilities(root,config,{findCodex:async()=>process.execPath,env:{XIAOKE_CHANNEL_CLI:browser}})).math.available,false);
});
test('effective role uses local character and configured aliases rather than old default identity',async t=>{
 const root=await fixture(t),config=defaults();config.character.aliases=['NewAlias'];await writeFile(join(root,'character_card.local.json'),JSON.stringify({name:'NewCharacter',core:[],voice:[],editable_persona:'New character likes astronomy and speaks in short sentences.'}));
 const role=await effectiveRole(root,config);assert.equal(role.name,'NewCharacter');assert.deepEqual(role.aliases,['NewCharacter','NewAlias']);assert.doesNotMatch(JSON.stringify(role),/白发|紫瞳|柯霜|小柯/);
});
test('disabled vision skips real media download and temp files; disabling during preparation releases every file',async t=>{
 const root=await fixture(t),config=defaults();let downloads=0;const media=await MediaLibrary.open({root,fetchImage:async()=>{downloads++;config.media.vision=false;return {buffer:PNG};}});
 const e={...event(),attachments:[{content_type:'image/png',url:'https://gchat.qpic.cn/synthetic'}]};
 const skipped=await prepareRuntimeInput({media,event:e,getConfig:()=>config});assert.deepEqual(skipped.visionFiles,[]);assert.deepEqual(skipped.mediaErrors,[]);assert.equal(downloads,0);
 config.media.vision=true;let prepared=[];const original=media.visionFiles.bind(media);media.visionFiles=async(...args)=>{prepared=await original(...args);return prepared;};
 const cancelled=await prepareRuntimeInput({media,event:e,getConfig:()=>config});assert.equal(downloads,1);assert.ok(prepared.length);assert.deepEqual(cancelled.visionFiles,[]);for(const file of prepared)await assert.rejects(stat(file.path),{code:'ENOENT'});
});
test('TTS disabled overrides ready backend in reply/proactive paths and lower engine gates never contact it',async t=>{
 const root=await fixture(t),config=defaults();let enabled=false,statusCalls=0,generations=0,imports=0;
 const ready={characterId:'xiaoke',implementation:'shared_base_v1',runtimeImplemented:true,enabled:true,available:true,ready:true,paused:false,phase:'ready',reason:'ready',blockers:[],selectionStatus:'approved',transportSupported:true,profileHash:'a'.repeat(64),modelIdentity:'Qwen/Qwen3-TTS-12Hz-1.7B-Base',serviceReady:true,halted:false,modelResident:true,workerPhase:'ready'};
 const engine=new SharedVoiceSpeech(root,{isEnabled:()=>enabled,verifyModule:()=>{},readControl:()=>({paused:false}),readSharedStatus:()=>({inferenceAllowed:true,generationImplemented:true,paused:false}),readBrokerControl:()=>({allowed:true}),clientFactory:()=>{imports++;return {characterId:'xiaoke',status:async()=>{statusCalls++;return ready;},generate:async()=>{generations++;throw Error('must not synthesize');}};}});t.after(()=>engine.stop());
 await assert.rejects(engine.warm(),/voice_paused/);engine.applyResourceControl();assert.equal(imports,0);assert.equal(statusCalls,0);
 enabled=true;config.media.tts=true;await engine.warm();assert.equal(engine.status().ready,true);
 enabled=false;config.media.tts=false;const before=statusCalls;engine.applyResourceControl();assert.equal(ttsCapability(config,engine).available,false);
 const plan=planReplySpeech({event:{...event(),content:'用语音回复'},content:'reply',options:{chatReply:true,speech:{text:'reply'}},capability:ttsCapability(config,engine),state:ttsResidentStatus(config,engine),settings:{spontaneousStickers:true}});assert.equal(plan.job,undefined);
 await assert.rejects(engine.generate('text'),/voice_paused/);await assert.rejects(engine.refreshStatus(),/voice_paused/);assert.equal(generations,0);assert.equal(statusCalls,before);
 let synth=0,texts=0,voices=0;await deliverProactiveSpeech({group:'room',text:'fallback',spoken:{text:'spoken'},status:()=>ttsResidentStatus(config,engine),settings:()=>({spontaneousStickers:true,proactiveEnabled:true}),lastSent:new Map(),synthesize:async()=>{synth++;},sendVoice:async()=>{voices++;return {id:'v'};},sendText:async()=>{texts++;return {id:'t'};}});assert.equal(synth,0);assert.equal(voices,0);assert.equal(texts,1);
});
test('persisted scope revocation cancels active Companion generation, drops GroupInbox queue and rejects late results after regrant',async t=>{
 const root=await fixture(t),store=await openPublicConfig(root),config=await store.update({scope:{groups:['room'],privateUsers:[]}}),guard=new RuntimeScopeGuard(()=>config);
 const started=gate(),finish=gate();let generations=0,signal,sends=0;
 const client=new QQClient('synthetic','synthetic',{fetcher:guard.fetcher(async url=>url.endsWith('getAppAccessToken')?new Response('{"access_token":"synthetic","expires_in":3600}'):new Response(JSON.stringify({id:'sent-'+(++sends)})))});
 const bot=await new Companion({dataDir:join(root,'data','conversation'),pairingHash:hash('synthetic'),progressDelayMs:0,generate:guard.wrapGenerator(async input=>{generations++;signal=input.signal;if(generations===1){started.resolve();await finish.promise;}return {reply:'late answer',memories:[]};})}).init();
 const inbox=new GroupInbox({delayMs:0,gapMs:0,sleep:async()=>{},handle:e=>guard.withEvent(e,()=>bot.handle(e,text=>client.reply(e,text,1))).catch(error=>{if(error.code==='scope_revoked')return {status:'cancelled'};throw error;})});
 const queue=id=>{const e=event(id);return inbox.enqueue({...e,[RUNTIME_AUTHORIZATION]:guard.issue(e)});};
 const first=queue('first');await started.promise;const second=queue('second');
 const apply=patch=>applyRuntimeConfig({store,config,patch,guard,inbox,onRevoked:e=>bot.invalidateDeliveries(e)});
 const server=await startLocalConsole({root,port:0,callbacks:{publicConfig:()=>store.get(),updatePublicConfig:async patch=>{await apply(patch);return {ok:true};}}});t.after(()=>server.close());
 const page=await(await fetch(server.url)).text(),csrf=page.match(/const csrf='([^']+)'/)[1];const response=await fetch(server.url+'/api/config',{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-console-csrf':csrf},body:JSON.stringify({scope:{groups:[],privateUsers:[]}})});assert.equal(response.status,200);assert.equal(signal.aborted,true);assert.equal((await second).status,'cancelled');
 await apply({scope:{groups:['room'],privateUsers:[]}});finish.resolve();assert.equal((await first).status,'cancelled');assert.equal(generations,1);assert.equal(sends,0);
 assert.equal((await queue('new-grant')).status,'replied');assert.equal(generations,2);assert.equal(sends,1);
});
test('QQ actual fetch boundary rechecks authorization after token await and before any message upload',async t=>{
 const root=await fixture(t),store=await openPublicConfig(root),config=await store.update({scope:{groups:['room'],privateUsers:[]}}),guard=new RuntimeScopeGuard(()=>config),started=gate(),finish=gate();let requests=0;
 const client=new QQClient('synthetic','synthetic',{fetcher:guard.fetcher(async url=>{if(url.endsWith('getAppAccessToken')){started.resolve();await finish.promise;return new Response('{"access_token":"synthetic","expires_in":3600}');}requests++;return new Response('{"id":"must-not-send"}');})});
 const work=guard.withEvent(event(),()=>client.reply(event(),'private text',1));await started.promise;await applyRuntimeConfig({store,config,patch:{scope:{groups:[],privateUsers:[]}},guard});finish.resolve();await assert.rejects(work,/scope_revoked/);assert.equal(requests,0);
});
test('proactive authorization issued before generation cannot be reused after scope revoke and regrant',{timeout:10000},async t=>{
 const root=await fixture(t),store=await openPublicConfig(root),config=await store.update({scope:{groups:['room'],privateUsers:[]}}),guard=new RuntimeScopeGuard(()=>config),started=gate(),finish=gate();let sends=0,now=Date.now();
 const bot=await new ProactiveCompanion({dataDir:join(root,'data','social'),now:()=>now,random:()=>0,isAwake:()=>true,getAuthorization:group=>guard.issue({group_openid:group}),generate:input=>guard.withAuthorization(input.runtimeAuthorization,()=>guard.run(input,async()=>{started.resolve();await finish.promise;return 'old thought';})),send:(_group,_text,{authorization})=>guard.withAuthorization(authorization,async()=>{sends++;return {sent_text:'old thought'};})}).init();t.after(()=>bot.stop());
 await bot.observe(event());now+=30*60000;const work=bot.tick();await started.promise;await applyRuntimeConfig({store,config,patch:{scope:{groups:[],privateUsers:[]}},guard,social:bot});await applyRuntimeConfig({store,config,patch:{scope:{groups:['room'],privateUsers:[]}},guard,social:bot});finish.resolve();assert.equal(await work,false);assert.equal(sends,0);
});

test('disabling TTS while real shared engine synthesis is pending aborts the provider and rejects its result',async t=>{
 const root=await fixture(t);let enabled=true;const started=gate();let providerSignal;
 const ready={characterId:'xiaoke',implementation:'shared_base_v1',runtimeImplemented:true,enabled:true,available:true,ready:true,paused:false,phase:'ready',reason:'ready',blockers:[],selectionStatus:'approved',transportSupported:true,profileHash:'a'.repeat(64),modelIdentity:'Qwen/Qwen3-TTS-12Hz-1.7B-Base',serviceReady:true,halted:false,modelResident:true,workerPhase:'ready'};
 const engine=new SharedVoiceSpeech(root,{isEnabled:()=>enabled,verifyModule:()=>{},readControl:()=>({paused:false}),readSharedStatus:()=>({inferenceAllowed:true,generationImplemented:true,paused:false}),readBrokerControl:()=>({allowed:true}),clientFactory:()=>({characterId:'xiaoke',status:async()=>ready,generate:({signal})=>{providerSignal=signal;started.resolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('provider aborted')),{once:true}));}})});t.after(()=>engine.stop());
 const pending=engine.generate('pending text');await started.promise;enabled=false;engine.applyResourceControl();assert.equal(providerSignal.aborted,true);await assert.rejects(pending,/voice_paused/);assert.equal(engine.status().ready,false);
});

test('revocation after QQ request submission stays uncertain rather than claiming known unsent',async t=>{
 const root=await fixture(t),store=await openPublicConfig(root),config=await store.update({scope:{groups:['room'],privateUsers:[]}}),guard=new RuntimeScopeGuard(()=>config),started=gate();let requests=0;
 const client=new QQClient('synthetic','synthetic',{fetcher:guard.fetcher(async(url,options)=>{if(url.endsWith('getAppAccessToken'))return new Response('{"access_token":"synthetic","expires_in":3600}');requests++;started.resolve();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));})});
 const pending=guard.withEvent(event(),()=>client.reply(event(),'authorized before revoke',1));await started.promise;await applyRuntimeConfig({store,config,patch:{scope:{groups:[],privateUsers:[]}},guard});await assert.rejects(pending,error=>error.code==='scope_revoked'&&error.deliveryUncertain===true&&error.messageNotSent!==true);assert.equal(requests,1);
});
test('proactive scope cancellation during preparation clears a proved-unsent reservation without a QQ request',async t=>{
 const root=await fixture(t),store=await openPublicConfig(root),config=await store.update({scope:{groups:['room'],privateUsers:[]}}),guard=new RuntimeScopeGuard(()=>config),started=gate(),finish=gate();let sends=0,now=Date.now();
 const client=new QQClient('synthetic','synthetic',{fetcher:guard.fetcher(async url=>url.endsWith('getAppAccessToken')?new Response('{"access_token":"synthetic","expires_in":3600}'):new Response(JSON.stringify({id:'sent-'+(++sends)})))});
 const bot=await new ProactiveCompanion({dataDir:join(root,'data','social'),now:()=>now,random:()=>0,isAwake:()=>true,getAuthorization:group=>guard.issue({group_openid:group}),generate:input=>guard.withAuthorization(input.runtimeAuthorization,()=>guard.run(input,async()=> 'thought')),send:(group,text,{authorization})=>guard.withAuthorization(authorization,async()=>{started.resolve();await finish.promise;return client.proactive(group,text);})}).init();t.after(()=>bot.stop());
 await bot.observe(event());now+=30*60000;const pending=bot.tick();await started.promise;await applyRuntimeConfig({store,config,patch:{scope:{groups:[],privateUsers:[]}},guard,social:bot});finish.resolve();assert.equal(await pending,false);assert.equal(sends,0);assert.equal(Object.values(bot.state.groups)[0].awaitingReply,false);
});

test('optional channel CLI honors cancellation before spawn and terminates an already running uncertain operation',async t=>{
 const root=await fixture(t);let launches=0,killed=0;const controller=new AbortController();controller.abort();
 await assert.rejects(channelCli(root,['read'],{signal:controller.signal,spawnProcess:()=>{launches++;}}),error=>error.code==='channel_cancelled'&&error.messageNotSent===true);assert.equal(launches,0);
 const running=new AbortController(),child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed++;};
 const pending=channelCli(root,['read'],{signal:running.signal,spawnProcess:()=>{launches++;return child;}});running.abort();await assert.rejects(pending,error=>error.code==='channel_cancelled'&&error.deliveryUncertain===true&&error.messageNotSent!==true);assert.equal(killed,1);assert.equal(launches,1);
 child.stdout.write('{"success":true}');child.emit('close',0);
});

test('deferred memory resolves its own room instead of inheriting another timer scope and revoked queued extraction cannot resume',async t=>{
 const root=await fixture(t),store=await openPublicConfig(root),config=await store.update({scope:{groups:['room-a'],privateUsers:[]}}),guard=new RuntimeScopeGuard(()=>config);let calls=0;
 const capture=await MemoryCapture.open({dataDir:join(root,'data','memory'),extract:input=>guard.withEvent(eventForMemoryCapture(input,config),()=>guard.run(input,async()=>{calls++;assert.equal(guard.current().event.group_openid,'room-b');return {personal:[],room:[]};}))});t.after(()=>capture.close());
 const scope='member_'+hash('member-b'),room=hash('room-b'),speaker='member_'+hash('member-b').slice(0,16);
 const observe=(id,content)=>capture.observe({scope,room,speaker,messageId:id,content});
 await observe('fact','我喜欢猫。');await observe('old-pending','下次接着讲极限，还没讲完。');await capture.drain({force:true});assert.equal(calls,0);assert.equal(capture.status().pending,1);
 const apply=patch=>applyRuntimeConfig({store,config,patch,guard,onScopeChanged:()=>capture.cancelPending()});
 await apply({scope:{groups:['room-a','room-b'],privateUsers:[]}});assert.equal(capture.status().pending,0);assert.equal(capture.recall(scope).length,1);
 await observe('current-pending','下次接着讲导数，还没讲完。');await guard.withEvent({group_openid:'room-a'},()=>capture.drain({force:true}));assert.equal(calls,1);assert.equal(capture.status().pending,0);
 await observe('cancelled','下次接着讲积分。');await apply({scope:{groups:['room-a'],privateUsers:[]}});await apply({scope:{groups:['room-a','room-b'],privateUsers:[]}});assert.equal(await capture.drain({force:true}),false);assert.equal(calls,1);assert.equal(capture.recall(scope).length,1);
});
test('deferred vocabulary research retains the observed room authorization and clears old tickets on revoke',async()=>{
 const config=defaults();config.scope.groups=['room-a','room-b'];const guard=new RuntimeScopeGuard(()=>config);let now=1000,calls=0;
 const learning={prepareResearch:()=>({token:'ticket',revisionKey:'revision',context:{candidates:[{id:'word',term:'synthetic'}]}}),releaseResearch:()=>{},applyModelActions:async()=>({researchCurrent:true,applied:1})};
 const research=new VocabularyResearch({learning,now:()=>now,getAuthorization:e=>guard.issue(e),generate:input=>guard.withAuthorization(input.runtimeAuthorization,()=>guard.run(input,async()=>{calls++;assert.equal(guard.current().event.group_openid,'room-a');return {actions:[]};}))});
 research.observe({group_openid:'room-a'});now+=31000;assert.equal(await guard.withEvent({group_openid:'room-b'},()=>research.tick()),true);assert.equal(calls,1);
 research.observe({group_openid:'room-a'});guard.revoke();research.clearPending();now+=31000;assert.equal(await research.tick(),false);assert.equal(calls,1);research.stop();
});
