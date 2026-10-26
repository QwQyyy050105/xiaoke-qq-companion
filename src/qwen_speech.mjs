import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readSharedVoiceStatus} from './shared_voice_status.mjs';
import {SharedVoiceSpeech} from './shared_voice_speech.mjs';

function resourceControl(root){
  try{const value=JSON.parse(readFileSync(join(root,'data','gpu_voice_control.json'),'utf8'));return {paused:value.paused!==false};}
  catch{return {paused:true};}
}

// One resident model, request IDs and a bounded queue: concurrent rooms never
// receive each other's audio, and a wedged GPU cannot hold chat indefinitely.
// Legacy worker implementation retained for isolated transition tests only.
// Production speechEngine below never constructs or falls back to this class.
export class QwenSpeech {
  constructor(root,{spawnWorker=spawn,startupMs=300000,requestMs=20000,maxPending=2,retryMs=60000,autoRetryLimit=2,readControl=()=>resourceControl(root),readSharedStatus=readSharedVoiceStatus}={}) {
    Object.assign(this,{root,spawnWorker,startupMs,requestMs,maxPending,retryMs,autoRetryLimit});
    this.readControl=readControl;
    this.readSharedStatus=readSharedStatus;
    this.tail=Promise.resolve();this.pending=0;this.worker=null;this.starting=null;this.active=null;this.ready=false;this.closed=false;this.retryAfter=0;
  }
  controls(){
    try{
      const local=this.readControl(),shared=this.readSharedStatus();
      const allowed=local?.paused===false&&shared?.inferenceAllowed===true&&shared?.generationImplemented===true&&shared?.paused===false;
      return {allowed,shared};
    }catch{return {allowed:false,shared:{available:false,ready:false,paused:true,phase:'unavailable',generationImplemented:false,inferenceAllowed:false,reason:'shared_voice_status_unavailable'}};}
  }
  status(){const control=this.controls(),paused=Boolean(this.paused)||!control.allowed;return {provider:'qwen3_local_gpu',ready:this.ready&&!paused,pending:this.pending,phase:paused?'paused':this.phase||'idle',paused,last_error:this.lastError||null,failed_phase:this.failedPhase||null,load_ms:this.loadMs??null,shared_status:control.shared};}
  applyResourceControl(){
    const paused=!this.controls().allowed;
    if(paused){this.paused=true;clearTimeout(this.retryTimer);this.failWorker?.('voice_paused');this.ready=false;return;}
    if(this.paused){this.paused=false;this.retryAfter=0;void this.warm().catch(()=>{});}
  }
  warm(){
    if(this.closed)return Promise.reject(Error('voice_stopped'));
    if(!this.controls().allowed){this.applyResourceControl();return Promise.reject(Error('voice_paused'));}
    this.paused=false;
    if(this.ready)return Promise.resolve();
    if(this.starting)return this.starting;
    if(Date.now()<this.retryAfter)return Promise.reject(Error('voice_retry_later'));
    clearTimeout(this.retryTimer);
    const env={...process.env,TEMP:join(this.root,'temp'),TMP:join(this.root,'temp'),PYTHONDONTWRITEBYTECODE:'1'};
    for(const key of Object.keys(env))if(/(?:SECRET|TOKEN|API_KEY|PASSWORD|QQ_APP_ID)/i.test(key))delete env[key];
    this.starting=new Promise((resolve,reject)=>{
      this.phase='starting';this.lastError=null;
      let child;
      try{child=this.spawnWorker(join(this.root,'runtime','qwen_voice','Scripts','python.exe'),['-B',join(this.root,'scripts','qwen_voice_worker.py')],{cwd:this.root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});}
      catch{reject(Error('voice_model_unavailable'));return;}
      this.worker=child;
      const timer=setTimeout(()=>fail('voice_startup_timeout'),this.startupMs);
      const lines=createInterface({input:child.stdout});
      const fail=reason=>{
        clearTimeout(timer);lines.close();
        if(this.worker!==child)return;
        const wasReady=this.ready;
        this.worker=null;this.ready=false;this.retryAfter=Date.now()+this.retryMs;
        this.failedPhase=this.phase;
        this.lastError=reason;this.phase='failed';
        const active=this.active;this.active=null;active?.reject(Error(reason));
        reject(Error(reason));child.stdin.destroy();
        // On Windows the venv redirector has a separate Python child. Retire
        // this owned worker tree so a timed-out model cannot retain GPU memory.
        if(process.platform==='win32'&&Number.isSafeInteger(child.pid)&&child.exitCode===null&&!child.killed){
          const kill=spawn(join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          kill.on('error',()=>child.kill());
        }else child.kill();
        if(!wasReady&&!this.closed&&!this.paused&&!['voice_stopped','voice_paused'].includes(reason)&&(this.autoRetries||0)<this.autoRetryLimit){
          this.autoRetries=(this.autoRetries||0)+1;
          this.retryTimer=setTimeout(()=>{this.retryTimer=null;void this.warm().catch(()=>{});},this.retryMs+10);
          this.retryTimer.unref?.();
        }
      };
      child.stderr.resume(); // No text/paths or model diagnostics go to QQ logs.
      child.stdin.on('error',()=>fail('voice_worker_closed'));
      child.on('error',()=>fail('voice_model_unavailable'));
      child.on('close',()=>fail('voice_worker_closed'));
      lines.on('line',line=>{
        if(this.worker!==child)return;
        if(line.length>16000){fail('voice_protocol_error');return;}
        let result;try{result=JSON.parse(line);}catch{fail('voice_protocol_error');return;}
        if(typeof result.phase==='string'&&['importing','loading_model','warming_model'].includes(result.phase)&&!this.ready){this.phase=result.phase;return;}
        if(typeof result.ready==='boolean'){
          if(!result.ready){fail(['voice_paused','voice_gpu_unavailable','voice_gpu_memory','voice_dependency_unavailable','voice_files_unavailable'].includes(result.error)?result.error:'voice_model_unavailable');return;}
          if(!this.controls().allowed){this.paused=true;fail('voice_paused');return;}
          clearTimeout(timer);this.ready=true;this.phase='ready';this.lastError=null;this.failedPhase=null;this.autoRetries=0;this.loadMs=Number.isFinite(result.load_ms)?result.load_ms:null;resolve();return;
        }
        const request=this.active;
        if(!request||result.id!==request.id){fail('voice_protocol_error');return;}
        this.active=null;
        result.ok?request.resolve(result):request.reject(Error('voice_synthesis_failed'));
      });
      this.failWorker=fail;
    }).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async generate(text,output){
    if(this.closed)throw Error('voice_stopped');
    if(!this.controls().allowed){this.applyResourceControl();throw Error('voice_paused');}
    if(this.pending>=this.maxPending)throw Error('voice_busy');
    this.pending++;
    const queuedAt=Date.now();
    const task=this.tail.then(async()=>{
      if(this.closed)throw Error('voice_stopped');
      // A queued request must re-read both controls; a previously allowed turn
      // cannot carry permission across a shared pause or broken control file.
      if(!this.controls().allowed){this.applyResourceControl();throw Error('voice_paused');}
      // While warming, caller gets text promptly. Warmup continues in background.
      if(!this.ready){void this.warm().catch(()=>{});throw Error('voice_warming');}
      const remaining=this.requestMs-(Date.now()-queuedAt);
      if(remaining<=0)throw Error('voice_queue_timeout');
      return new Promise((resolve,reject)=>{
        const id=randomUUID();
        const timer=setTimeout(()=>this.failWorker?.('voice_synthesis_timeout'),remaining);
        this.active={id,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
        this.worker.stdin.write(JSON.stringify({id,text,output})+'\n');
      });
    });
    this.tail=task.catch(()=>{});
    try{return await task;}finally{this.pending--;}
  }
  stop(){this.closed=true;clearTimeout(this.retryTimer);this.failWorker?.('voice_stopped');}
}

const engines=new Map();
export function speechEngine(root,options={}){if(!engines.has(root))engines.set(root,new SharedVoiceSpeech(root,options));return engines.get(root);}
export function stopSpeech(root){engines.get(root)?.stop();engines.delete(root);}
