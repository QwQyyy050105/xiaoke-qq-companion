import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import http from 'node:http';
import {defaults,validateConfig,openPublicConfig,isEventAllowed} from '../src/public_config.mjs';
import {createModelProvider,isKeylessLocalApi} from '../src/model_providers.mjs';
import {chatGenerator} from '../src/model_client.mjs';
import {loadExtensions,loadConfiguredExtensions,wrapGenerate} from '../src/extensions.mjs';
import {startLocalConsole} from '../src/local_console.mjs';
import {GroupRouter} from '../src/routing.mjs';
async function fixture(t){await mkdir(resolve('temp'),{recursive:true});const root=await mkdtemp(resolve('temp','public_'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'temp'));await mkdir(join(root,'assets'));await copyFile('character_card.json',join(root,'character_card.json'));await copyFile('persona.txt',join(root,'persona.txt'));await copyFile('assets/console.html',join(root,'assets/console.html'));return root;}
async function service(t,handler){const server=http.createServer(handler);await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));return `http://127.0.0.1:${server.address().port}/v1`;}
const api=baseURL=>({...defaults().modelProvider,type:'openai-compatible',baseURL,model:'example-model',envKey:'TEST_MODEL_KEY',timeoutMs:1000});
test('config is portable, rejects embedded secrets, persists all controls, scopes and quiet hours',async t=>{
 const root=await fixture(t),store=await openPublicConfig(root);assert.equal(isEventAllowed(store.get(),{group_openid:'a'}),false);
 const p={scope:{groups:['allowed'],privateUsers:['owner']},character:{aliases:['柯柯'],style:'short'},participation:{mode:'contextual',quietStart:22,quietEnd:8,timeZone:'UTC'},media:{vision:true,asr:false,tts:false,imageGeneration:false}};
 await store.update(p);assert.deepEqual((await openPublicConfig(root)).get().character,p.character);
 assert.equal(isEventAllowed(store.get(),{group_openid:'allowed'},new Date('2026-01-01T12:00Z')),true);assert.equal(isEventAllowed(store.get(),{group_openid:'allowed'},new Date('2026-01-01T23:00Z')),false);
 for(const patch of [{secret:'x'},{modelProvider:{...api('http://evil.invalid'),key:'x'}},{modelProvider:{...api('https://a:b@example.com/v1')}},{plugins:['../outside.mjs']},{scope:{groups:[''],privateUsers:[]}}])assert.throws(()=>validateConfig({...defaults(),...patch}));
});
test('real API provider sends exact model/auth and generator validates structured chat response',async t=>{
 let observed;const baseURL=await service(t,async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;observed={url:req.url,authorization:req.headers.authorization,body:JSON.parse(raw)};res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"reply":"实际 API 回复","memories":[]}'}}]}));});
 const root=await fixture(t);process.env.TEST_MODEL_KEY='synthetic-local-key';t.after(()=>delete process.env.TEST_MODEL_KEY);
 const answer=await chatGenerator(root,{modelProvider:api(baseURL)})({text:'hello'});assert.equal(answer.reply,'实际 API 回复');assert.equal(observed.url,'/v1/chat/completions');assert.equal(observed.authorization,'Bearer synthetic-local-key');assert.equal(observed.body.model,'example-model');assert.deepEqual(observed.body.response_format,{type:'json_object'});
 assert.doesNotMatch(await readFile(join(root,'data/model_usage.json'),'utf8'),/synthetic-local-key|hello/);
});
test('API timeout, caller abort, malformed envelopes and malformed structured replies fail explicitly',async t=>{
 const baseURL=await service(t,(_req,_res)=>{});const p=createModelProvider({...api(baseURL),timeoutMs:100},{env:{TEST_MODEL_KEY:'fake'}});
 await assert.rejects(p.complete({prompt:'x',input:{}}),/model_timeout/);
 const controller=new AbortController(),pending=p.complete({prompt:'x',input:{},signal:controller.signal});controller.abort();await assert.rejects(pending,/model_aborted/);
 const bad=createModelProvider(api(baseURL),{env:{TEST_MODEL_KEY:'fake'},fetcher:async()=>new Response('{"choices":[]}',{status:200})});await assert.rejects(bad.complete({prompt:'x',input:{}}),/model_empty_response/);
 const root=await fixture(t);const invalidURL=await service(t,(_req,res)=>res.end(JSON.stringify({choices:[{message:{content:'{"reply":42}'}}]})));process.env.TEST_MODEL_KEY='fake';t.after(()=>delete process.env.TEST_MODEL_KEY);await assert.rejects(chatGenerator(root,{modelProvider:api(invalidURL)})({text:'x'}),/invalid_chat_response/);
});
test('Mock chat is offline and plugin hooks really enter generation; unsupported remains explicit',async t=>{
 const root=await fixture(t);await mkdir(join(root,'plugins'));
 await writeFile(join(root,'plugins/style.mjs'),`export default {apiVersion:1,id:'style-test',capabilities:['beforeGenerate','afterGenerate'],setup(){return {beforeGenerate:async input=>({...input,text:'plugin '+input.text}),afterGenerate:async result=>({...result,reply:result.reply+' done'})}}}`);
 const extensions=await loadExtensions({root,paths:['./plugins/style.mjs']});const g=wrapGenerate(chatGenerator(root,{modelProvider:defaults().modelProvider}),extensions);assert.equal((await g({text:'hello'})).reply,'演示回复：plugin hello done');assert.deepEqual(await extensions.call('asr',{}),{status:'unsupported',capability:'asr'});
 await writeFile(join(root,'plugins/bad.mjs'),`export default {apiVersion:2,id:'bad-plugin',capabilities:['chat'],setup(){return {chat:()=>({reply:'x'})}}}`);await assert.rejects(loadExtensions({root,paths:['./plugins/bad.mjs']}),/plugin_manifest_invalid/);
});
test('panel config writes require CSRF, persist validated settings and never return environment keys',async t=>{
 const root=await fixture(t),store=await openPublicConfig(root),server=await startLocalConsole({root,port:0,callbacks:{publicConfig:()=>store.get(),updatePublicConfig:patch=>store.update(patch)}});t.after(()=>server.close());
 const page=await(await fetch(server.url)).text(),csrf=page.match(/const csrf='([^']+)'/)[1];const patch={modelProvider:{...defaults().modelProvider,model:'chosen-model'},character:{aliases:['柯柯'],style:'自然'}};
 const req=token=>fetch(server.url+'/api/config',{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-console-csrf':token},body:JSON.stringify(patch)});
 assert.equal((await req('bad')).status,403);assert.equal((await req(csrf)).status,200);const state=await(await fetch(server.url+'/api/config')).json();assert.equal(state.modelProvider.model,'chosen-model');assert.deepEqual((await openPublicConfig(root)).get().character.aliases,['柯柯']);assert.equal('apiKey'in state.modelProvider,false);
});
test('custom aliases reach existing group routing without a classifier',async()=>{const router=new GroupRouter({aliases:['柯柯'],decideWithReply:true});const decision=await router.decide({id:'event',group_openid:'room',author:{member_openid:'user'},content:'柯柯，晚上好'});assert.equal(decision.addressed,true);assert.equal(decision.reason,'called_by_name');});

test('API compatibility can omit response_format and select max_completion_tokens',async t=>{
 let body;const baseURL=await service(t,async(req,res)=>{let raw='';for await(const part of req)raw+=part;body=JSON.parse(raw);res.end(JSON.stringify({choices:[{message:{content:'{"reply":"ok","memories":[]}'}}]}));});
 const provider=createModelProvider({...api(baseURL),tokenLimitField:'max_completion_tokens',responseFormat:'prompt'},{env:{TEST_MODEL_KEY:'fake'}});
 await provider.complete({prompt:'respond as JSON',input:{structured:true}});assert.equal(body.max_completion_tokens,1200);assert.equal('max_tokens'in body,false);assert.equal('response_format'in body,false);
 await assert.rejects(provider.complete({prompt:'x',input:{},images:['a','b','c','d']}),/model_image_count_limit/);
});
test('panel role edits write only ignored local overlay and preserve distributed card bytes',async t=>{
 const root=await fixture(t),original=await readFile(join(root,'character_card.json'));
 const server=await startLocalConsole({root,port:0});t.after(()=>server.close());
 const page=await(await fetch(server.url)).text(),csrf=page.match(/const csrf='([^']+)'/)[1];
 const result=await fetch(server.url+'/api/roles',{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-console-csrf':csrf},body:JSON.stringify({operation:'save',id:'xiao_ke',name:'Local role',content:'A sufficiently long local-only custom personality with example relationships.'})});
 assert.equal(result.status,200);assert.deepEqual(await readFile(join(root,'character_card.json')),original);assert.match(await readFile(join(root,'character_card.local.json'),'utf8'),/local-only/);
});

test('offline demo never imports configured side-effect plugins even after owner setup',async t=>{
 const root=await fixture(t);await mkdir(join(root,'plugins'));await writeFile(join(root,'plugins/network.mjs'),`throw Error('Configured plugin must never run in offline demo');`);
 const extensions=await loadConfiguredExtensions({root,paths:['./plugins/network.mjs'],offline:true});assert.deepEqual(extensions.ids,[]);const g=wrapGenerate(chatGenerator(root,{modelProvider:defaults().modelProvider}),extensions);assert.match((await g({text:'offline'})).reply,/offline/);
});

test('chat provider plugins replace generation, validate their result and cannot deliver a late aborted result',async t=>{
 const root=await fixture(t);await mkdir(join(root,'plugins'));
 await writeFile(join(root,'plugins/chat.mjs'),`export default {apiVersion:1,id:'chat-example',capabilities:['chat'],setup(){return {chat:async input=>({reply:input.text,memories:[]})}}}`);
 const extensions=await loadExtensions({root,paths:['./plugins/chat.mjs']});let baseCalled=false;
 const g=wrapGenerate(async()=>{baseCalled=true;throw Error('base must not run');},extensions);
 assert.equal((await g({text:'from plugin',structured:true})).reply,'from plugin');assert.equal(baseCalled,false);
 const controller=new AbortController();controller.abort();await assert.rejects(g({text:'late',signal:controller.signal}),/model_aborted/);
 await writeFile(join(root,'plugins/invalid.mjs'),`export default {apiVersion:1,id:'bad-chat',capabilities:['chat'],setup(){return {chat:async()=>({reply:'missing memories'})}}}`);
 await assert.rejects(wrapGenerate(()=>{},await loadExtensions({root,paths:['./plugins/invalid.mjs']}))({text:'x',structured:true}),/plugin_chat_result_invalid/);
});

test('actual loopback HTTP model works without any key or Authorization header through the structured generator',async t=>{
 let observed;const baseURL=await service(t,async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;observed={authorization:req.headers.authorization,url:req.url,body:JSON.parse(raw)};res.end(JSON.stringify({choices:[{message:{content:'{"reply":"local model reply","memories":[]}'}}]}));});
 const root=await fixture(t),envKey='UNSET_LOCAL_MODEL_TEST_KEY';delete process.env[envKey];
 const result=await chatGenerator(root,{modelProvider:{...api(baseURL),envKey}})({text:'local model test'});
 assert.equal(result.reply,'local model reply');assert.equal(observed.authorization,undefined);assert.equal(observed.url,'/v1/chat/completions');assert.equal(observed.body.model,'example-model');
});
test('keyless mode is limited to exact loopback HTTP and remote HTTPS still requires an environment key',async()=>{
 for(const url of ['http://localhost:11434/v1','http://127.0.0.1:8000/v1','http://[::1]:8000/v1'])assert.equal(isKeylessLocalApi(url),true);
 for(const url of ['https://example.com/v1','https://localhost/v1','http://localhost.example.com/v1','http://192.0.2.1:11434/v1'])assert.equal(isKeylessLocalApi(url),false);
 let calls=0;const fetcher=async()=>{calls++;return new Response('{"choices":[{"message":{"content":"ok"}}]}');};
 await assert.rejects(createModelProvider(api('https://example.com/v1'),{env:{},fetcher}).complete({prompt:'x',input:{}}),/model_key_missing/);
 await assert.rejects(createModelProvider(api('http://192.0.2.1:11434/v1'),{env:{TEST_MODEL_KEY:'synthetic'},fetcher}).complete({prompt:'x',input:{}}),/model_base_url_invalid/);assert.equal(calls,0);
});
