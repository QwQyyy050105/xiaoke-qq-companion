import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SharedVoiceSpeech} from '../src/shared_voice_speech.mjs';
import {speechEngine,stopSpeech,QwenSpeech} from '../src/qwen_speech.mjs';
import {synthesizeSpeech,validateSpeechText} from '../src/speech.mjs';

const MODEL='Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const PROFILE='a'.repeat(64),digest=value=>createHash('sha256').update(value).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function wav(){
  const bytes=Buffer.alloc(44+4800);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);
  bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4800,40);return bytes;
}
function ready(overrides={}){return {characterId:'xiaoke',implementation:'shared_base_v1',runtimeImplemented:true,enabled:true,
  available:true,ready:true,paused:false,phase:'ready',reason:'ready',blockers:[],selectionStatus:'approved',transportSupported:true,
  profileHash:PROFILE,modelIdentity:MODEL,mode:'on_demand',fallback:'text',serviceReady:true,halted:false,
  modelResident:false,workerPhase:'idle',...overrides};}
async function fixture(t,options={}){
  const base=await realpath(path.resolve('temp')),root=await mkdtemp(path.join(base,'shared_speech_'));
  const cacheRoot=path.join(root,'cache');await mkdir(path.join(cacheRoot,'xiaoke'),{recursive:true});await mkdir(path.join(root,'data'));
  const bytes=wav(),file=path.join(cacheRoot,'xiaoke','b'.repeat(64)+'.wav');await writeFile(file,bytes);
  const audio={path:file,sha256:digest(bytes),sampleRate:24000,durationSeconds:0.1,profileHash:PROFILE,modelIdentity:MODEL};
  const state={local:true,shared:true,broker:true,status:ready(),statusCalls:0,generateCalls:[],verifyCalls:0};
  const client={characterId:'xiaoke',status:async args=>{state.statusCalls++;return state.onStatus?state.onStatus(args):state.status;},
    generate:async request=>{state.generateCalls.push(request);return state.onGenerate?state.onGenerate(request):audio;}};
  const engine=new SharedVoiceSpeech(root,{cacheRoot,clientFactory:()=>client,verifyModule:()=>{state.verifyCalls++;if(state.badModule)throw Error('changed');},
    readControl:()=>({paused:!state.local}),readSharedStatus:()=>({paused:!state.shared,generationImplemented:state.shared,inferenceAllowed:state.shared}),
    readBrokerControl:()=>({allowed:state.broker}),...options});
  t.after(async()=>{engine.stop();await tick();const actual=await realpath(root);assert.ok(actual.toLowerCase().startsWith((base+path.sep).toLowerCase()));assert.ok(path.basename(actual).startsWith('shared_speech_'));await rm(actual,{recursive:true});});
  return {engine,state,audio,bytes,file,root,cacheRoot,client};
}

test('production factory creates only shared transport, and missing actual local gate denies',async t=>{
  const f=await fixture(t);const engine=speechEngine(f.root);t.after(()=>stopSpeech(f.root));
  assert.ok(engine instanceof SharedVoiceSpeech);assert.ok(!(engine instanceof QwenSpeech));assert.equal(engine.status().ready,false);
  const local=new SharedVoiceSpeech(f.root,{clientFactory:()=>f.client,verifyModule:()=>{},readSharedStatus:()=>({inferenceAllowed:true,generationImplemented:true,paused:false}),readBrokerControl:()=>({allowed:true})});t.after(()=>local.stop());
  await assert.rejects(local.generate('测试'),/paused/);assert.equal(f.state.generateCalls.length,0);
  await writeFile(path.join(f.root,'data/gpu_voice_control.json'),'{broken');assert.equal(local.controls().allowed,false);
  await writeFile(path.join(f.root,'data/gpu_voice_control.json'),JSON.stringify({paused:false}));assert.equal(local.controls().allowed,true);
});

test('warm and idle polling are status-only; permitted first on-demand request works without a resident model',async t=>{
  const f=await fixture(t);await f.engine.warm();f.engine.applyResourceControl();
  assert.equal(f.state.generateCalls.length,0);assert.equal(f.engine.status().ready,true);assert.equal(f.engine.status().model_resident,false);
  const result=await f.engine.generate('这是第一条按需语音。');
  assert.equal(f.state.generateCalls.length,1);assert.deepEqual(result.buffer,f.bytes);assert.equal(result.profileHash,PROFILE);
  assert.ok(f.state.generateCalls[0].deadlineMs>Date.now()+170000);assert.equal(await stat(f.file).then(s=>s.size),f.bytes.length);
});

test('readiness_only, runtime disabled, malformed module and local stop cannot authorize generation',async t=>{
  for(const field of ['local','shared','broker']){const f=await fixture(t);await f.engine.warm();f.state[field]=false;
    assert.equal(f.engine.status().ready,false);await assert.rejects(f.engine.generate('测试'),/paused/);assert.equal(f.state.generateCalls.length,0);}
  const f=await fixture(t);f.state.badModule=true;await assert.rejects(f.engine.warm(),/status_unavailable/);
  await assert.rejects(f.engine.generate('测试'),/paused/);assert.equal(f.state.statusCalls,0);assert.equal(f.state.generateCalls.length,0);
});

test('status is strictly projected; malformed or expired readiness fails closed',async t=>{
  let clock=1000;const f=await fixture(t,{now:()=>clock});f.state.status={...ready(),secret:'not for projection'};
  await f.engine.warm();assert.equal(JSON.stringify(f.engine.status()).includes('not for projection'),false);
  clock+=5000;assert.equal(f.engine.status().ready,false);
  f.state.status=ready({ready:'true'});await assert.rejects(f.engine.refreshStatus(),/status_unavailable/);assert.equal(f.engine.status().ready,false);
  f.state.status=ready({runtimeImplemented:true,selectionStatus:'pending'});await assert.rejects(f.engine.refreshStatus(),/status_unavailable/);
  f.state.status=ready({characterId:'fatfish'});await assert.rejects(f.engine.refreshStatus(),/status_unavailable/);
});

test('120 code points are accepted unchanged and 121 reject without silent truncation',async t=>{
  const f=await fixture(t);const text='😀'.repeat(120);assert.equal(validateSpeechText(text),text);
  await f.engine.generate(text);assert.equal(f.state.generateCalls[0].text,text);
  await assert.rejects(f.engine.generate(text+'好'),/voice_text_limit/);assert.throws(()=>validateSpeechText(text+'好'),/voice_text_limit/);
  assert.equal(f.state.generateCalls.length,1);
});

test('job identity and absolute deadline reach the single shared generation call unchanged',async t=>{
  const f=await fixture(t),deadlineMs=Date.now()+10000;
  await f.engine.generate('测试',{requestId:'speech_stable_job',deadlineMs});
  assert.equal(f.state.generateCalls.length,1);assert.equal(f.state.generateCalls[0].requestId,'speech_stable_job');assert.equal(f.state.generateCalls[0].deadlineMs,deadlineMs);
  await assert.rejects(f.engine.generate('测试',{requestId:'not a valid id'}),/request_invalid/);assert.equal(f.state.generateCalls.length,1);
});

test('profile change or pause while generation is pending discards its result',async t=>{
  for(const mutation of [f=>{f.state.status=ready({profileHash:'c'.repeat(64)});},f=>{f.state.local=false;},f=>{f.state.broker=false;}]){
    const f=await fixture(t);f.state.onGenerate=async()=>{mutation(f);return f.audio;};
    await assert.rejects(f.engine.generate('测试'),/voice_(?:profile_changed|paused)/);assert.equal(f.state.generateCalls.length,1);
  }
});

test('changed bytes, cross-role paths, wrong model and misleading WAV metadata are rejected',async t=>{
  const mutations=[async f=>{await writeFile(f.file,Buffer.alloc(f.bytes.length));},
    async f=>{f.audio.path=path.join(f.cacheRoot,'fatfish',path.basename(f.file));},
    async f=>{f.audio.modelIdentity='wrong-model';},async f=>{f.audio.profileHash='c'.repeat(64);},
    async f=>{f.audio.sampleRate=16000;},async f=>{f.audio.durationSeconds=0.5;},
    async f=>{const bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.write('WAVE',8);await writeFile(f.file,bytes);f.audio.sha256=digest(bytes);}];
  for(const mutate of mutations){const f=await fixture(t);f.state.onGenerate=async()=>{await mutate(f);return f.audio;};await assert.rejects(f.engine.generate('测试'));assert.equal(f.state.generateCalls.length,1);}
});

test('queued requests recheck gates and never reach the client after a pause',async t=>{
  const f=await fixture(t);let release,entered;const started=new Promise(r=>entered=r);
  f.state.onGenerate=()=>new Promise(resolve=>{release=resolve;entered();});
  const a=f.engine.generate('第一句'),b=f.engine.generate('第二句');const results=Promise.allSettled([a,b]);await started;
  await assert.rejects(f.engine.generate('第三句'),/voice_busy/);f.state.shared=false;release(f.audio);
  assert.ok((await results).every(result=>result.status==='rejected'));assert.equal(f.state.generateCalls.length,1);assert.equal(f.engine.pending,0);
});

test('cancel and deadline bound calls even if mock service ignores signal; neither retries',async t=>{
  for(const timeout of [false,true]){const f=await fixture(t,{requestMs:timeout?40:1000});let entered;const started=new Promise(r=>entered=r);
    f.state.onGenerate=()=>{entered();return new Promise(()=>{});};const controller=new AbortController();
    const call=f.engine.generate('测试',{signal:controller.signal}),rejected=assert.rejects(call,/voice_(?:cancelled|deadline_exceeded)/);await started;
    if(!timeout)controller.abort();await rejected;assert.equal(f.state.generateCalls.length,1);assert.equal(f.state.generateCalls[0].signal.aborted,true);assert.equal(f.engine.pending,0);
  }
});

test('stop cancels only owned requests without a worker control or fallback',async t=>{
  const f=await fixture(t);let entered;const started=new Promise(r=>entered=r);f.state.onGenerate=()=>{entered();return new Promise(()=>{});};
  const call=f.engine.generate('测试'),rejected=assert.rejects(call,/voice_stopped/);await started;f.engine.stop();await rejected;
  assert.equal(f.state.generateCalls[0].signal.aborted,true);assert.equal(f.state.generateCalls.length,1);assert.equal(f.engine.status().ready,false);
  await assert.rejects(f.engine.generate('再试'),/voice_stopped/);
});

test('failed service and unresponsive status clear usability with no retry or raw-error leakage',async t=>{
  const f=await fixture(t,{statusMs:30});await f.engine.warm();f.state.onStatus=()=>new Promise(()=>{});
  await assert.rejects(f.engine.refreshStatus(),/voice_status_unavailable/);assert.equal(f.engine.status().ready,false);assert.equal(f.state.generateCalls.length,0);
  f.state.onStatus=null;f.state.onGenerate=()=>{throw Error('secret arbitrary upstream text');};
  await assert.rejects(f.engine.generate('测试'),error=>error.message==='voice_shared_failed');assert.equal(f.state.generateCalls.length,1);
});

test('delivery checks bind fresh profile and local gate and make no inference requests',async t=>{
  const f=await fixture(t);const audio=await f.engine.generate('测试');const identity={profileHash:audio.profileHash,modelIdentity:audio.modelIdentity};
  assert.equal(await f.engine.verifyCurrent(identity),true);assert.equal(f.engine.isCurrent(identity),true);
  f.state.status=ready({profileHash:'d'.repeat(64)});assert.equal(await f.engine.verifyCurrent(identity),false);
  f.state.local=false;assert.equal(f.engine.isCurrent(identity),false);assert.equal(f.state.generateCalls.length,1);
});

test('SILK pipeline uses verified bytes, retains shared identity and never deletes shared cache',async t=>{
  const f=await fixture(t);let encoded=0;const deadlineMs=Date.now()+10000;
  const result=await synthesizeSpeech(f.root,'短句',{engine:f.engine,requestId:'speech_pipeline_job',deadlineMs,encoder:async bytes=>{encoded++;assert.deepEqual(bytes,f.bytes);return {data:Buffer.from('#!SILK_V3\nsynthetic payload'),duration:100};}});
  assert.equal(encoded,1);assert.equal(result.sharedVoice.profileHash,PROFILE);assert.equal(result.synthetic,true);assert.deepEqual(await readFile(f.file),f.bytes);
  assert.equal(f.state.generateCalls[0].requestId,'speech_pipeline_job');assert.equal(f.state.generateCalls[0].deadlineMs,deadlineMs);
  const rejected=await fixture(t);await assert.rejects(synthesizeSpeech(rejected.root,'短句',{engine:rejected.engine,encoder:async()=>{rejected.state.broker=false;return {data:Buffer.from('#!SILK_V3\nsynthetic payload'),duration:100};}}),/voice_paused/);
  assert.deepEqual(await readFile(rejected.file),rejected.bytes);
});
