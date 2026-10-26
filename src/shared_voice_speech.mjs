import {isAbsolute as isPortableAbsolute} from 'node:path';
import {openSync, closeSync, fstatSync, readSync, realpathSync} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {inspectVoice} from './voice_library.mjs';
import {readSharedVoiceStatus} from './shared_voice_status.mjs';

const SHARED_ROOT=process.env.XIAOKE_SHARED_VOICE_ROOT || path.resolve(import.meta.dirname,'..','runtime','shared_voice');
const CLIENT = path.join(SHARED_ROOT,'client.mjs');
const CLIENT_SHA = '3866e1f493c6ed9b6819ae002a781c4b0cf700c946893f3a1e45c8940744b55b';
const CACHE = path.join(SHARED_ROOT,'runtime','cache');
const MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const MAX_AUDIO = 3 * 1024 * 1024;
export const MAX_SPEECH_CHARACTERS = 120;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = code => Object.assign(new Error(code), {code});
const denied = reason => ({characterId:'xiaoke',ready:false,available:false,paused:true,phase:'unavailable',reason});

function stableRead(file, limit) {
  let handle;
  try {
    if (!isPortableAbsolute(file) || !samePath(realpathSync(file),file)) throw failure('voice_path_invalid');
    handle=openSync(file,'r'); const before=fstatSync(handle);
    if(!before.isFile() || before.size<1 || before.size>limit) throw failure('voice_file_invalid');
    const bytes=Buffer.alloc(before.size+1); let used=0;
    while(used<bytes.length){const count=readSync(handle,bytes,used,bytes.length-used,null);if(!count)break;used+=count;}
    const after=fstatSync(handle);
    if(used!==before.size || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs) throw failure('voice_file_changed');
    return bytes.subarray(0,used);
  } finally {if(handle!==undefined)closeSync(handle);}
}
function readObject(file){const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stableRead(file,128*1024)).replace(/^\uFEFF/,''));if(!object(value))throw failure('voice_control_invalid');return value;}
function verifyClient(){if(digest(stableRead(CLIENT,128*1024))!==CLIENT_SHA)throw failure('voice_client_unreviewed');}
function readLocalControl(root){try{const value=readObject(path.join(root,'data/gpu_voice_control.json'));return {paused:value.paused!==false};}catch{return {paused:true};}}
function readRuntimeControl(){
  try{const value=readObject(path.join(SHARED_ROOT,'runtime_config.json'));return {allowed:value.schemaVersion===1 && value.enabled===true && value.host==='127.0.0.1' && value.port===3103 && value.modelIdentity===MODEL && value.maxTextCharacters===120 && value.maxRequestMs===180000};}
  catch{return {allowed:false};}
}

function projectStatus(value){
  if(!object(value) || value.characterId!=='xiaoke' || value.implementation!=='shared_base_v1' || value.runtimeImplemented!==true ||
    !['enabled','available','ready','paused','serviceReady','halted'].every(key=>typeof value[key]==='boolean')) throw failure('voice_status_invalid');
  const permitted=value.enabled && value.available && value.ready && !value.paused && value.serviceReady && !value.halted;
  if(permitted && (value.phase!=='ready' || value.selectionStatus!=='approved' || value.transportSupported!==true ||
    value.modelIdentity!==MODEL || !hash(value.profileHash) || !Array.isArray(value.blockers) || value.blockers.length!==0 ||
    typeof value.modelResident!=='boolean' || !['idle','loading','ready','generating','stopping','stopped'].includes(value.workerPhase))) throw failure('voice_status_invalid');
  return Object.freeze({characterId:'xiaoke',implementation:'shared_base_v1',runtimeImplemented:true,
    enabled:value.enabled,serviceReady:value.serviceReady,ready:permitted,available:permitted,paused:!permitted,
    phase:permitted?'ready':'paused',reason:permitted?'ready':'voice_shared_unavailable',
    profileHash:hash(value.profileHash)?value.profileHash:null,modelIdentity:value.modelIdentity===MODEL?MODEL:null,
    modelResident:value.modelResident===true,workerPhase:['idle','loading','ready','generating','stopping','stopped','halted'].includes(value.workerPhase)?value.workerPhase:'unknown'});
}

async function verifiedAudio(audio,cacheRoot){
  if(!object(audio)||typeof audio.path!=='string'||!hash(audio.sha256)||!hash(audio.profileHash)||audio.modelIdentity!==MODEL ||
    !Number.isInteger(audio.sampleRate)||audio.sampleRate<8000||audio.sampleRate>48000||!Number.isFinite(audio.durationSeconds)||audio.durationSeconds<=0||audio.durationSeconds>60) throw failure('voice_audio_invalid');
  const expected=path.join(cacheRoot,'xiaoke');
  if(!isPortableAbsolute(audio.path)||!samePath(path.dirname(audio.path),expected)||!/^[a-f0-9]{64}\.wav$/.test(path.basename(audio.path))) throw failure('voice_audio_path_invalid');
  if(!isPortableAbsolute(cacheRoot)||!samePath(await realpath(cacheRoot),cacheRoot)||!samePath(await realpath(expected),expected)||!samePath(await realpath(audio.path),audio.path)) throw failure('voice_audio_path_invalid');
  const handle=await open(audio.path,'r');let bytes;
  try{
    const before=await handle.stat();if(!before.isFile()||before.size<44||before.size>MAX_AUDIO)throw failure('voice_audio_invalid');
    bytes=Buffer.alloc(before.size+1);let used=0;
    while(used<bytes.length){const result=await handle.read(bytes,used,bytes.length-used,null);if(!result.bytesRead)break;used+=result.bytesRead;}
    const after=await handle.stat();if(used!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw failure('voice_audio_changed');
    bytes=bytes.subarray(0,used);
  }finally{await handle.close();}
  if(digest(bytes)!==audio.sha256)throw failure('voice_audio_hash_mismatch');
  const inspected=inspectVoice(bytes);
  if(inspected.mime!=='audio/wav'||bytes.readUInt32LE(4)!==bytes.length-8)throw failure('voice_audio_invalid');
  let rate=0,formats=0;
  for(let p=12;p+8<=bytes.length;){const size=bytes.readUInt32LE(p+4);if(bytes.toString('ascii',p,p+4)==='fmt '&&size>=16){rate=bytes.readUInt32LE(p+12);formats++;}p+=8+size+(size%2);}
  if(formats!==1||rate!==audio.sampleRate||Math.abs(inspected.duration-audio.durationSeconds)>Math.max(0.002,1/rate))throw failure('voice_audio_metadata_mismatch');
  return Buffer.from(bytes);
}

// Options are dependency injection for isolated tests only. The production
// factory supplies just its verified project root; chat cannot select a role,
// module, endpoint, cache, credential, implementation or permission source.
export class SharedVoiceSpeech {
  constructor(root,{clientFactory,verifyModule=verifyClient,readControl=()=>readLocalControl(root),readSharedStatus=readSharedVoiceStatus,
    readBrokerControl=readRuntimeControl,cacheRoot=CACHE,now=Date.now,requestMs=180000,statusMs=3000,freshMs=5000,maxPending=2,isEnabled=()=>true}={}){
    if(typeof root!=='string'||!isPortableAbsolute(root)||!samePath(realpathSync(root),root)||
      !Number.isSafeInteger(requestMs)||requestMs<1||requestMs>180000||!Number.isSafeInteger(statusMs)||statusMs<1||statusMs>3000||
      !Number.isSafeInteger(freshMs)||freshMs<1||freshMs>10000||!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>3)throw failure('voice_options_invalid');
    Object.assign(this,{root,verifyModule,readControl,readSharedStatus,readBrokerControl,cacheRoot,now,requestMs,statusMs,freshMs,maxPending,isEnabled});
    this.clientFactory=clientFactory|| (async()=>{const module=await import(pathToFileURL(CLIENT).href);return module.createVoiceClient({characterId:'xiaoke',baseUrl:'http://127.0.0.1:3103'});});
    this.client=null;this.snapshot=null;this.snapshotAt=0;this.lastRefreshAttempt=-Infinity;this.refreshSerial=0;
    this.pending=0;this.tail=Promise.resolve();this.closed=false;this.operations=new Set();this.generationControllers=new Set();this.lastError=null;
  }
  controls(){
    try{if(!this.isEnabled())return {allowed:false,shared:denied('tts_disabled')};this.verifyModule();const local=this.readControl(),shared=this.readSharedStatus(),broker=this.readBrokerControl();
      return {allowed:!this.closed&&local?.paused===false&&shared?.inferenceAllowed===true&&shared?.generationImplemented===true&&shared?.paused===false&&broker?.allowed===true,shared};
    }catch{return {allowed:false,shared:denied('voice_control_unavailable')};}
  }
  status(){
    const control=this.controls(),fresh=this.snapshot&&this.now()>=this.snapshotAt&&this.now()-this.snapshotAt<this.freshMs;
    const ready=Boolean(control.allowed&&fresh&&this.snapshot.ready);
    return {provider:'shared_qwen_base',ready,available:ready,paused:!control.allowed||Boolean(this.snapshot?.paused),phase:ready?'ready':!control.allowed?'paused':'unavailable',
      pending:this.pending,max_chars:MAX_SPEECH_CHARACTERS,last_error:this.lastError,shared_status:control.shared,
      broker_status:this.snapshot?{...this.snapshot}:null,model_resident:this.snapshot?.modelResident===true,worker_phase:this.snapshot?.workerPhase||'unknown'};
  }
  async getClient(){
    this.verifyModule();if(!this.client)this.client=Promise.resolve(this.clientFactory()).then(client=>{
      this.verifyModule();if(client?.characterId!=='xiaoke'||typeof client.status!=='function'||typeof client.generate!=='function')throw failure('voice_client_invalid');return client;
    }).catch(()=>{this.client=null;throw failure('voice_client_unavailable');});
    return this.client;
  }
  operation(deadlineMs,signal){
    if(signal!==undefined&&!(signal instanceof AbortSignal))throw failure('voice_request_invalid');
    const controller=new AbortController();this.operations.add(controller);
    const abort=()=>controller.abort(failure('voice_cancelled'));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let rejectAbort;
    const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(controller.signal.reason||failure('voice_cancelled'));controller.signal.addEventListener('abort',rejectAbort,{once:true});if(controller.signal.aborted)rejectAbort();});
    // A handler exists even if an early gate rejects before race() is used.
    cancelled.catch(()=>{});
    const timer=setTimeout(()=>controller.abort(failure('voice_deadline_exceeded')),Math.max(1,deadlineMs-this.now()));
    const check=()=>{if(this.closed)throw failure('voice_stopped');if(controller.signal.aborted)throw controller.signal.reason;if(this.now()>=deadlineMs)throw failure('voice_deadline_exceeded');};
    return {controller,check,race:promise=>Promise.race([promise,cancelled]),finish:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',rejectAbort);this.operations.delete(controller);}};
  }
  async refreshStatus({signal}={}){
    if(this.closed)throw failure('voice_stopped');
    if(!this.isEnabled())throw failure('voice_paused');
    const serial=++this.refreshSerial;this.lastRefreshAttempt=this.now();const op=this.operation(this.now()+this.statusMs,signal);
    try{op.check();const client=await op.race(this.getClient());op.check();const value=projectStatus(await op.race(client.status({signal:op.controller.signal})));op.check();this.verifyModule();
      if(serial===this.refreshSerial){this.snapshot=value;this.snapshotAt=this.now();this.lastError=null;}return value;
    }catch{if(serial===this.refreshSerial){this.snapshot=null;this.snapshotAt=0;this.lastError='voice_status_unavailable';}throw failure('voice_status_unavailable');}
    finally{op.finish();}
  }
  async warm(){await this.refreshStatus();if(!this.status().ready)throw failure('voice_paused');}
  applyResourceControl(){
    if(this.closed)return;
    if(!this.isEnabled()){this.snapshot=null;for(const controller of this.operations)controller.abort(failure('voice_paused'));return;}
    if(!this.controls().allowed)for(const controller of this.generationControllers)controller.abort(failure('voice_paused'));
    if(this.now()-this.lastRefreshAttempt>=2000)void this.refreshStatus().catch(()=>{});
  }
  requireAllowed(){if(!this.controls().allowed)throw failure('voice_paused');}
  async generate(text,{signal,deadlineMs,requestId=randomUUID()}={}){
    if(typeof text!=='string'||!text.trim()||[...text].length>MAX_SPEECH_CHARACTERS||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw failure('voice_text_limit');
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))throw failure('voice_request_invalid');
    if(this.closed)throw failure('voice_stopped');this.requireAllowed();
    if(this.pending>=this.maxPending)throw failure('voice_busy');
    const started=this.now();deadlineMs??=started+this.requestMs;
    if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=started||deadlineMs>started+180000)throw failure('voice_request_invalid');
    const op=this.operation(deadlineMs,signal);this.generationControllers.add(op.controller);this.pending++;
    const task=this.tail.then(async()=>{
      op.check();this.requireAllowed();
      const before=await op.race(this.refreshStatus({signal:op.controller.signal}));op.check();this.requireAllowed();
      if(!before.ready)throw failure('voice_paused');
      const client=await op.race(this.getClient());op.check();this.requireAllowed();
      const audio=await op.race(client.generate({text,requestId,deadlineMs,signal:op.controller.signal}));op.check();this.requireAllowed();
      const after=await op.race(this.refreshStatus({signal:op.controller.signal}));op.check();this.requireAllowed();
      if(!after.ready||after.profileHash!==before.profileHash||audio?.profileHash!==before.profileHash||audio?.modelIdentity!==MODEL)throw failure('voice_profile_changed');
      const buffer=await op.race(verifiedAudio(audio,this.cacheRoot));op.check();this.requireAllowed();
      if(!this.isCurrent({profileHash:before.profileHash,modelIdentity:MODEL}))throw failure('voice_profile_changed');
      return Object.freeze({buffer,sha256:audio.sha256,sampleRate:audio.sampleRate,durationSeconds:audio.durationSeconds,
        profileHash:before.profileHash,modelIdentity:MODEL,elapsed_ms:this.now()-started});
    });
    // An aborted queued job stays chained until its predecessor exits, so it
    // can never overtake a live operation or send a later request in its place.
    this.tail=task.catch(()=>{});
    try{return await op.race(task);}catch(error){this.lastError=['voice_paused','voice_busy','voice_text_limit','voice_cancelled','voice_deadline_exceeded','voice_profile_changed','voice_stopped'].includes(error?.code)?error.code:'voice_shared_failed';throw failure(this.lastError);}
    finally{op.finish();this.generationControllers.delete(op.controller);this.pending--;}
  }
  isCurrent(identity){return object(identity)&&identity.modelIdentity===MODEL&&hash(identity.profileHash)&&this.status().ready&&this.snapshot.profileHash===identity.profileHash;}
  async verifyCurrent(identity,{signal}={}){
    try{this.requireAllowed();const value=await this.refreshStatus({signal});this.requireAllowed();return value.ready&&this.isCurrent(identity);}catch{return false;}
  }
  stop(){this.closed=true;this.snapshot=null;this.refreshSerial++;for(const controller of this.operations)controller.abort(failure('voice_stopped'));}
}
