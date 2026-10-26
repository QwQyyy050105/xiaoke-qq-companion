import {isAbsolute as isPortableAbsolute} from 'node:path';
import {open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {durableWriteFile} from './durable_write.mjs';
import {MAX_SPEECH_CHARACTERS} from './shared_voice_speech.mjs';

const NOTICE='这句我用语音回你，稍等一下。';
const FALLBACK='这句语音没能完成，先用文字说。';
const LIMIT=2*1024*1024;
const MAX_GENERATION_MS=180000;
const statuses=new Set(['reserved','generating','ready','sending','sent','failed','cancelled','expired','delivery_uncertain','interrupted']);
const terminal=new Set(['sent','failed','cancelled','expired','delivery_uncertain','interrupted']);
const notices=new Set(['none','sending','sent','failed','uncertain']);
const sha=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const scopeName=value=>typeof value==='string'&&/^(?:group|private):[a-f0-9]{64}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const failure=code=>Object.assign(new Error(code),{code});
const unaccepted=code=>Object.assign(failure(code),{messageNotSent:true});
const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f]/.test(value);
const receiptId=value=>value?.id||value?.body?.id;
const textValid=text=>typeof text==='string'&&text.trim()&&[...text].length<=MAX_SPEECH_CHARACTERS&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
function scopeOf(event){
  if(!object(event)||!validId(event.id))throw failure('speech_job_event_invalid');
  if(event.group_openid!==undefined){if(!validId(event.group_openid))throw failure('speech_job_event_invalid');return 'group:'+sha(event.group_openid);}
  if(event.chat_type==='group'||!validId(event.author?.user_openid||event.author?.id))throw failure('speech_job_event_invalid');
  return 'private:'+sha(event.author.user_openid||event.author.id);
}
function envelope(text,receipt){
  const id=receiptId(receipt);if(!validId(id))throw failure('speech_job_delivery_unconfirmed');
  const referenceId=receipt?.ext_info?.ref_idx??receipt?.body?.ext_info?.ref_idx;
  return {id,sent_text:text,delivered_messages:[{content:text,messageId:id,...(validId(referenceId)?{referenceId}:{})}]};
}
function empty(record){return {deferredSpeech:{jobId:record.key,status:record.status},sent_text:'',delivered_messages:[]};}
function validateStore(value){
  if(!object(value)||Object.keys(value).some(k=>!['schemaVersion','epochs','jobs'].includes(k))||value.schemaVersion!==1||!object(value.epochs)||!Array.isArray(value.jobs)||value.jobs.length>512)throw failure('speech_job_store_invalid');
  if(Object.keys(value.epochs).length>512||Object.entries(value.epochs).some(([key,n])=>!scopeName(key)||!integer(n)))throw failure('speech_job_store_invalid');
  const keys=new Set();
  for(const item of value.jobs){
    if(!object(item)||Object.keys(item).some(k=>!['key','scope','source','text','textHash','requestId','requested','epoch','createdAt','expiresAt','deadlineMs','status','notice','receipt','noticeReceipt','deliveryKind','recordingFailed'].includes(k))||
      !hex(item.key)||keys.has(item.key)||!scopeName(item.scope)||!hex(item.source)||item.key!==sha(item.scope+':'+item.source)||!hex(item.textHash)||typeof item.text!=='string'||
      (item.text!==''&&(!textValid(item.text)||sha(item.text)!==item.textHash))||item.requestId!=='speech_'+item.key||typeof item.requested!=='boolean'||
      ![item.epoch,item.createdAt,item.expiresAt,item.deadlineMs].every(integer)||!statuses.has(item.status)||!notices.has(item.notice)||
      (item.receipt!==undefined&&!validId(item.receipt))||(item.noticeReceipt!==undefined&&!validId(item.noticeReceipt))||
      (item.deliveryKind!==undefined&&!['voice','text'].includes(item.deliveryKind))||(item.recordingFailed!==undefined&&typeof item.recordingFailed!=='boolean'))throw failure('speech_job_store_invalid');
    if(!Object.hasOwn(value.epochs,item.scope)||item.epoch>value.epochs[item.scope]||item.expiresAt<item.createdAt||item.deadlineMs>item.expiresAt||item.deadlineMs>item.createdAt+MAX_GENERATION_MS)throw failure('speech_job_store_invalid');
    keys.add(item.key);
  }
  return value;
}
async function readStore(file){
  let handle;
  try{
    if(!samePath(await realpath(file),file))throw failure('speech_job_path_invalid');
    handle=await open(file,'r');const before=await handle.stat();if(!before.isFile()||before.size>LIMIT)throw failure('speech_job_store_invalid');
    const bytes=await handle.readFile(),after=await handle.stat();
    if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw failure('speech_job_store_changed');
    return validateStore(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  }catch(error){if(error.code==='ENOENT')return {schemaVersion:1,epochs:{},jobs:[]};throw failure('speech_job_store_invalid');}
  finally{await handle?.close();}
}

// Caller admits spontaneous jobs only for an already resident model. The short
// foreground timeout observes the same job; it never aborts/retries the shared
// request or owns a second send. Progress has a separate, longer delay so a
// normal short synthesis does not produce an unnecessary status message.
export class SpeechJobs{
  constructor({dataDir,synthesize,verifyPrepared,now=Date.now,save=durableWriteFile,foregroundMs=1200,noticeMs=10000,maxPending=2,maxEntries=512,onError=()=>{}}){
    if(typeof dataDir!=='string'||!isPortableAbsolute(dataDir)||!path.isAbsolute(dataDir)||typeof synthesize!=='function'||typeof verifyPrepared!=='function'||
      !Number.isSafeInteger(foregroundMs)||foregroundMs<0||foregroundMs>5000||!Number.isSafeInteger(noticeMs)||noticeMs<foregroundMs||noticeMs>60000||!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>3||
      !Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>512)throw failure('speech_job_options_invalid');
    Object.assign(this,{dataDir,synthesize,verifyPrepared,now,save,foregroundMs,noticeMs,maxPending,maxEntries,onError});
    this.file=path.join(dataDir,'speech_jobs.json');this.state={schemaVersion:1,epochs:{},jobs:[]};this.live=new Map();this.writes=Promise.resolve();this.stopped=false;this.storageFailed=false;
  }
  static async open(options){
    const jobs=new SpeechJobs(options);if(!samePath(await realpath(jobs.dataDir),jobs.dataDir))throw failure('speech_job_path_invalid');
    jobs.state=await readStore(jobs.file);let changed=false;
    for(const entry of jobs.state.jobs){
      if(!terminal.has(entry.status)){entry.status='interrupted';if(entry.notice==='sending')entry.notice='uncertain';changed=true;}
      if(entry.text!==''){entry.text='';changed=true;}
    }
    if(changed)await jobs.persist();return jobs;
  }
  persist(){
    const bytes=JSON.stringify(this.state,null,2)+'\n';
    const write=this.writes.then(async()=>{if(this.storageFailed)throw failure('speech_job_persistence_failed');await this.save(this.file,bytes);});
    this.writes=write.catch(()=>{this.storageFailed=true;for(const job of this.live.values()){job.cancelled=true;job.controller.abort(failure('speech_job_persistence_failed'));}try{this.onError(failure('speech_job_persistence_failed'));}catch{}});
    return write.catch(()=>{throw failure('speech_job_persistence_failed');});
  }
  current(job,{voice=false}={}){
    if(this.stopped||this.storageFailed||job.cancelled||this.state.epochs[job.record.scope]!==job.record.epoch||this.now()>=job.record.expiresAt)return false;
    if(voice&&(job.controller.signal.aborted||this.now()>=job.record.deadlineMs))return false;
    try{return job.callbacks.isCurrent()===true;}catch{return false;}
  }
  async change(job,status){job.record.status=status;if(terminal.has(status))job.record.text='';await this.persist();}
  async locked(job,callback){const task=job.sendTail.then(callback);job.sendTail=task.catch(()=>{});return task;}
  async raceAbort(job,promise){
    let abort;
    try{return await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(failure('speech_job_cancelled'));job.controller.signal.addEventListener('abort',abort,{once:true});if(job.controller.signal.aborted)abort();})]);}
    finally{job.controller.signal.removeEventListener('abort',abort);}
  }
  execute(event,{text,requested,expiresAt}={},callbacks={}){
    // Prior ownership must be checked before any error that permits a caller
    // to fall back. An old notice/uncertain send stays old even after disk failure.
    const scope=scopeOf(event),source=sha(event.id),key=sha(scope+':'+source);
    const existing=this.state.jobs.find(record=>record.key===key);
    if(existing){
      if(typeof text!=='string'||existing.textHash!==sha(text)||existing.requested!==requested)return Promise.reject(failure('speech_job_request_conflict'));
      const live=this.live.get(key);if(live)return live.foreground;
      return Promise.resolve(empty(existing));
    }
    if(this.stopped||this.storageFailed)return Promise.reject(unaccepted('speech_jobs_unavailable'));
    if(typeof requested!=='boolean'||!textValid(text)||!Number.isSafeInteger(expiresAt)||expiresAt<=this.now())return Promise.reject(unaccepted('speech_job_request_invalid'));
    if(['sendVoice','sendText','recordDeferred','isCurrent'].some(key=>typeof callbacks[key]!=='function'))return Promise.reject(unaccepted('speech_job_callbacks_invalid'));
    const current=this.now();
    const retained=this.state.jobs.filter(record=>!terminal.has(record.status)||record.expiresAt>current||this.live.has(record.key));
    if(retained.length>=this.maxEntries||this.live.size>=this.maxPending)return Promise.reject(unaccepted('speech_jobs_busy'));
    // expiresAt remains the original message's trusted delivery deadline. Never
    // refresh it on replay. Retire only terminal expired entries, atomically with
    // this new reservation; no live/unconfirmed eligible action is evicted.
    this.state.jobs=retained;
    const usedScopes=new Set(retained.map(record=>record.scope));
    this.state.epochs=Object.fromEntries(Object.entries(this.state.epochs).filter(([name])=>usedScopes.has(name)));
    this.state.epochs[scope]??=0;
    const textHash=sha(text);
    const createdAt=this.now(),record={key,scope,source,text,textHash,requestId:'speech_'+key,requested,epoch:this.state.epochs[scope],createdAt,expiresAt,deadlineMs:Math.min(expiresAt,createdAt+MAX_GENERATION_MS),status:'reserved',notice:'none'};
    const job={record,text,callbacks,controller:new AbortController(),cancelled:false,detached:false,sendTail:Promise.resolve(),finalClaimed:false};
    this.state.jobs.push(record);this.live.set(key,job);job.foreground=this.start(job);return job.foreground;
  }
  async start(job){
    try{await this.persist();}catch(error){job.record.status='failed';job.record.text='';this.live.delete(job.record.key);throw error;}
    if(!this.current(job)){await this.change(job,this.now()>=job.record.expiresAt?'expired':'cancelled');this.live.delete(job.record.key);return empty(job.record);}
    job.timer=setTimeout(()=>job.controller.abort(failure('speech_job_generation_timeout')),Math.max(1,job.record.deadlineMs-this.now()));
    job.work=this.run(job).catch(async()=>{if(!terminal.has(job.record.status)){job.record.status='failed';job.record.text='';await this.persist().catch(()=>{});}return empty(job.record);}).finally(()=>{clearTimeout(job.timer);clearTimeout(job.noticeTimer);this.live.delete(job.record.key);});
    let timer;
    const result=await Promise.race([job.work.then(value=>({done:true,value})),new Promise(resolve=>{timer=setTimeout(()=>resolve({done:false}),this.foregroundMs);})]);clearTimeout(timer);
    if(result.done)return result.value;
    job.detached=true;
    if(job.record.requested&&!terminal.has(job.record.status)){
      job.noticeTimer=setTimeout(()=>{
        job.noticeWork=this.notice(job).catch(()=>{try{this.onError(failure('speech_job_notice_failed'));}catch{}});
      },Math.max(0,this.noticeMs-(this.now()-job.record.createdAt)));
    }
    return empty(job.record);
  }
  noticeCurrent(job){return job.record.requested&&!job.finalClaimed&&job.record.status==='generating'&&this.current(job,{voice:true});}
  async notice(job){
    if(!this.noticeCurrent(job)||job.record.notice!=='none')return null;
    return this.locked(job,async()=>{
      if(!this.noticeCurrent(job)||job.record.notice!=='none')return null;
      job.record.notice='sending';await this.persist();
      if(!this.noticeCurrent(job)){job.record.notice='none';await this.persist();return null;}
      try{const receipt=await job.callbacks.sendText(NOTICE,{isCurrent:()=>this.noticeCurrent(job)});const result=envelope(NOTICE,receipt);
        job.record.notice='sent';job.record.noticeReceipt=result.id;await this.persist();
        await this.recordDeferred(job,NOTICE,receipt);return result;
      }catch(error){job.record.notice=error?.messageNotSent===true?'failed':'uncertain';await this.persist();return null;}
    });
  }
  async run(job){
    let prepared;
    try{
      await this.change(job,'generating');if(!this.current(job,{voice:true}))throw failure('speech_job_cancelled');
      prepared=await this.raceAbort(job,this.synthesize(job.text,{signal:job.controller.signal,requestId:job.record.requestId,deadlineMs:job.record.deadlineMs}));
      if(!this.current(job,{voice:true})||await this.raceAbort(job,this.verifyPrepared(prepared,{signal:job.controller.signal}))!==true)throw failure('speech_job_not_current');
      await this.change(job,'ready');
    }catch{
      if(!this.current(job))return this.cancelled(job);
      return this.locked(job,()=>this.sendFallback(job));
    }
    return this.locked(job,async()=>{
      if(!this.current(job,{voice:true}))return this.cancelled(job);
      job.finalClaimed=true;job.record.deliveryKind='voice';await this.change(job,'sending');
      if(!this.current(job,{voice:true}))return this.cancelled(job);
      let receipt;
      try{receipt=await job.callbacks.sendVoice(prepared,{isCurrent:()=>this.current(job,{voice:true})});if(!validId(receiptId(receipt)))throw failure('speech_job_delivery_unconfirmed');}
      catch(error){
        if(error?.messageNotSent===true){if(!this.current(job))return this.cancelled(job);return this.sendFallback(job);}
        await this.change(job,'delivery_uncertain');return empty(job.record);
      }
      return this.sent(job,'[发送语音：'+job.text+']',receipt);
    });
  }
  async sendFallback(job){
    if(!this.current(job))return this.cancelled(job);
    job.finalClaimed=true;job.record.deliveryKind='text';await this.change(job,'sending');if(!this.current(job))return this.cancelled(job);
    const text=job.record.requested?FALLBACK+'\n'+job.text:job.text;let receipt;
    try{receipt=await job.callbacks.sendText(text,{isCurrent:()=>this.current(job)});if(!validId(receiptId(receipt)))throw failure('speech_job_delivery_unconfirmed');}
    catch(error){await this.change(job,error?.messageNotSent===true?'failed':'delivery_uncertain');return empty(job.record);}
    return this.sent(job,text,receipt);
  }
  async sent(job,text,receipt){
    const result=envelope(text,receipt);job.record.receipt=result.id;job.record.status='sent';job.record.text='';
    // After a real QQ receipt, persistence failure cannot justify replaying it.
    // The previously durable sending record becomes interrupted on restart.
    try{await this.persist();}catch{result.persistenceFailed=true;}
    await this.recordDeferred(job,text,receipt);
    return result;
  }
  async recordDeferred(job,text,receipt){
    if(job.detached&&this.current(job)){
      try{await job.callbacks.recordDeferred(text,receipt,{isCurrent:()=>this.current(job)});}
      catch{job.record.recordingFailed=true;await this.persist().catch(()=>{});try{this.onError(failure('speech_job_recording_failed'));}catch{}}
    }
  }
  async cancelled(job){
    if(!terminal.has(job.record.status))await this.change(job,this.now()>=job.record.expiresAt?'expired':'cancelled');
    return empty(job.record);
  }
  invalidate(event){
    const scope=scopeOf(event);if(!Object.hasOwn(this.state.epochs,scope))return Promise.resolve();this.state.epochs[scope]++;
    for(const entry of this.state.jobs)if(entry.scope===scope){entry.text='';if(!terminal.has(entry.status))entry.status='cancelled';}
    for(const job of this.live.values())if(job.record.scope===scope){clearTimeout(job.noticeTimer);job.cancelled=true;job.controller.abort(failure('speech_job_cancelled'));}
    return this.persist();
  }
  status(event){const scope=scopeOf(event);return {pending:[...this.live.values()].filter(job=>job.record.scope===scope).length,storageFailed:this.storageFailed,jobs:this.state.jobs.filter(record=>record.scope===scope).slice(-16).map(({key,status,notice,createdAt,receipt,recordingFailed})=>({jobId:key,status,notice,createdAt,...(receipt?{receipt}:{}),...(recordingFailed?{recordingFailed:true}:{})}))};}
  stop(){
    this.stopped=true;
    for(const job of this.live.values()){clearTimeout(job.noticeTimer);job.cancelled=true;job.controller.abort(failure('speech_job_stopped'));if(!terminal.has(job.record.status))job.record.status='cancelled';job.record.text='';}
    return this.persist();
  }
}
