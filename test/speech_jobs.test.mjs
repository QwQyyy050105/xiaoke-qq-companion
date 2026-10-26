import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {SpeechJobs} from '../src/speech_jobs.mjs';
import {durableWriteFile} from '../src/durable_write.mjs';

const event=(id='request',group='room')=>group?{id,group_openid:group,author:{member_openid:'member'}}:{id,author:{user_openid:'owner'}};
const request=text=>({text:text||'晚安，明天接着聊。',requested:true,expiresAt:Date.now()+60000});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,options={}){
  const base=await realpath(path.resolve('temp')),dataDir=await mkdtemp(path.join(base,'speech_jobs_'));
  const state={synthesis:[],voices:[],texts:[],recorded:[],errors:[],current:true};
  const jobs=await SpeechJobs.open({dataDir,foregroundMs:500,synthesize:async(text,opts)=>{state.synthesis.push({text,...opts});return state.synth?state.synth(text,opts):{synthetic:true};},
    verifyPrepared:async()=>state.verified!==false,onError:e=>state.errors.push(e.code),...options});
  const callbacks={isCurrent:()=>state.current,
    sendVoice:async(prepared,opts)=>{state.voices.push(opts);return state.voice?state.voice(prepared,opts):{id:'voice_'+state.voices.length};},
    sendText:async(text,opts)=>{state.texts.push({text,...opts});return state.sendText?state.sendText(text,opts):{id:'text_'+state.texts.length};},
    recordDeferred:async(text,receipt,opts)=>{state.recorded.push({text,receipt,...opts});if(state.record)await state.record(text,receipt,opts);}};
  t.after(async()=>{const live=[...jobs.live.values()];await jobs.stop().catch(()=>{});await Promise.allSettled(live.flatMap(job=>[job.work||job.foreground,job.noticeWork]).filter(Boolean));await jobs.writes;
    const actual=await realpath(dataDir);assert.ok(actual.toLowerCase().startsWith((base+path.sep).toLowerCase()));assert.ok(path.basename(actual).startsWith('speech_jobs_'));await rm(actual,{recursive:true});});
  return {jobs,state,callbacks,dataDir};
}
async function waitStarted(f,count=1){for(let i=0;i<200&&f.state.synthesis.length<count;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(f.state.synthesis.length,count);}
async function waitSettled(f){for(let i=0;i<200&&f.jobs.live.size;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(f.jobs.live.size,0);await f.jobs.writes;}

test('fast completion has a real receipt and no deferred recorder or progress',async t=>{
  const f=await fixture(t),result=await f.jobs.execute(event(),request(),f.callbacks);
  assert.equal(result.id,'voice_1');assert.match(result.sent_text,/发送语音/);assert.equal(result.deferredSpeech,undefined);
  assert.equal(f.state.synthesis.length,1);assert.equal(f.state.texts.length,0);assert.equal(f.state.recorded.length,0);
  assert.match(f.state.synthesis[0].requestId,/^speech_[a-f0-9]{64}$/);assert.equal(f.jobs.status(event()).jobs[0].status,'sent');
});

test('ordinary synthesis past foreground deadline delivers voice without a redundant notice',async t=>{
  const f=await fixture(t,{foregroundMs:5}),pending=defer();f.state.synth=()=>pending.promise;
  let normalChatPassed=false;const result=await f.jobs.execute(event(),request(),f.callbacks).then(value=>{normalChatPassed=true;return value;});
  assert.equal(normalChatPassed,true);assert.ok(result.deferredSpeech.jobId);assert.equal(result.sent_text,'');assert.equal(f.state.texts.length,0);
  await waitStarted(f);
  assert.equal(f.state.synthesis[0].signal.aborted,false);assert.equal(f.state.voices.length,0);assert.equal(f.state.synthesis.length,1);
  pending.resolve({synthetic:true});await waitSettled(f);
  assert.equal(f.state.voices.length,1);assert.equal(f.state.recorded.length,1);assert.equal(f.state.texts.length,0);assert.equal(f.state.recorded[0].isCurrent(),true);
});

test('genuinely slow synthesis gives one background notice without blocking foreground on its send',{timeout:5000},async t=>{
  const f=await fixture(t,{foregroundMs:5,noticeMs:20}),synth=defer(),notice=defer(),entered=defer();f.state.synth=()=>synth.promise;
  f.state.sendText=async()=>{entered.resolve();await notice.promise;return {id:'progress'};};
  const result=await f.jobs.execute(event(),request(),f.callbacks);assert.ok(result.deferredSpeech);assert.equal(result.sent_text,'');
  await entered.promise;synth.resolve({synthetic:true});await tick();
  assert.equal(f.state.voices.length,0);notice.resolve();await waitSettled(f);
  assert.equal(f.state.texts.length,1);assert.equal(f.state.voices.length,1);assert.equal(f.state.recorded.length,2);
  assert.doesNotMatch(f.state.texts[0].text,/先接着聊|没能|还在准备/);
  assert.equal(f.state.recorded[0].receipt.id,'progress');assert.match(f.state.recorded[1].text,/发送语音/);
});

test('already dispatching final voice never adds a competing progress notice',async t=>{
  const f=await fixture(t,{foregroundMs:20}),send=defer(),entered=defer();f.state.voice=async()=>{entered.resolve();await send.promise;return {id:'voice'};};
  const execution=f.jobs.execute(event(),request(),f.callbacks);await entered.promise;const result=await execution;
  assert.ok(result.deferredSpeech);assert.equal(result.sent_text,'');assert.equal(f.state.texts.length,0);
  send.resolve();await waitSettled(f);assert.equal(f.state.voices.length,1);assert.equal(f.state.recorded.length,1);
});

test('a notice queued in transport is cancelled when the voice becomes ready',{timeout:5000},async t=>{
  const f=await fixture(t,{foregroundMs:5,noticeMs:20}),synth=defer(),entered=defer(),release=defer();
  f.state.synth=()=>synth.promise;let deliveredNotices=0;
  f.state.sendText=async(text,{isCurrent})=>{entered.resolve();await release.promise;if(!isCurrent())throw Object.assign(Error('cancelled'),{messageNotSent:true});deliveredNotices++;return {id:'notice'};};
  await f.jobs.execute(event(),request(),f.callbacks);await entered.promise;synth.resolve({synthetic:true});
  for(let i=0;i<200&&f.jobs.status(event()).jobs[0].status!=='ready';i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(f.jobs.status(event()).jobs[0].status,'ready');release.resolve();await waitSettled(f);
  assert.equal(deliveredNotices,0);assert.equal(f.state.voices.length,1);assert.equal(f.state.recorded.length,1);
});

test('synthesis completion during notice persistence suppresses its transport entirely',{timeout:5000},async t=>{
  const entered=defer(),release=defer(),synth=defer();let pausedOnce=false;
  const f=await fixture(t,{foregroundMs:5,noticeMs:20,save:async(file,bytes)=>{
    if(!pausedOnce&&JSON.parse(bytes).jobs[0]?.notice==='sending'){pausedOnce=true;entered.resolve();await release.promise;}
    await durableWriteFile(file,bytes);
  }});f.state.synth=()=>synth.promise;
  await f.jobs.execute(event(),request(),f.callbacks);await entered.promise;synth.resolve({synthetic:true});
  for(let i=0;i<200&&f.jobs.status(event()).jobs[0].status!=='ready';i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(f.jobs.status(event()).jobs[0].status,'ready');release.resolve();await waitSettled(f);
  assert.equal(f.state.texts.length,0);assert.equal(f.state.voices.length,1);assert.equal(f.state.recorded.length,1);
});

test('same source deduplicates, changed text conflicts, and group/private sources are distinct',async t=>{
  const f=await fixture(t,{foregroundMs:5,maxPending:3}),pending=defer();f.state.synth=()=>pending.promise;
  const first=f.jobs.execute(event('same','room-a'),request('同一句'),f.callbacks);
  const duplicate=f.jobs.execute(event('same','room-a'),request('同一句'),f.callbacks);
  await assert.rejects(f.jobs.execute(event('same','room-a'),request('改一句'),f.callbacks),/conflict/);
  await f.jobs.execute(event('same','room-b'),request('同一句'),f.callbacks);await f.jobs.execute(event('same',null),request('同一句'),f.callbacks);
  assert.deepEqual(await first,await duplicate);await waitStarted(f,3);assert.equal(new Set(f.state.synthesis.map(item=>item.requestId)).size,3);
  await f.jobs.invalidate(event('clear','room-a'));pending.resolve({synthetic:true});await waitSettled(f);
  assert.equal(f.state.voices.length,2);assert.equal(f.jobs.status(event('x','room-a')).jobs[0].status,'cancelled');
});

test('forget invalidates synchronously during generation and scrubs persisted short text',async t=>{
  const f=await fixture(t,{foregroundMs:5}),pending=defer();f.state.synth=()=>pending.promise;
  await f.jobs.execute(event(),request('不能在清空后复活'),f.callbacks);await waitStarted(f);const invalidate=f.jobs.invalidate(event('forget'));
  assert.equal(f.state.synthesis[0].signal.aborted,true);await invalidate;pending.resolve({synthetic:true});await waitSettled(f);
  assert.equal(f.state.voices.length,0);assert.equal(f.state.recorded.length,0);assert.equal(f.state.texts.length,0);
  const disk=JSON.parse(await readFile(path.join(f.dataDir,'speech_jobs.json'),'utf8'));assert.equal(disk.jobs[0].text,'');assert.equal(disk.jobs[0].status,'cancelled');
});

test('quiet/stop invalidation during upload blocks messages and forbids a late text fallback',async t=>{
  for(const stop of [false,true]){const f=await fixture(t,{foregroundMs:5}),uploaded=defer(),release=defer();
    f.state.voice=async(prepared,{isCurrent})=>{uploaded.resolve();await release.promise;if(!isCurrent())throw Object.assign(Error('cancelled before messages'),{messageNotSent:true});return {id:'should_not_send'};};
    const execution=f.jobs.execute(event(),request(),f.callbacks);await uploaded.promise;const textsBeforeCancel=f.state.texts.length;
    if(stop)await f.jobs.stop();else await f.jobs.invalidate(event('quiet'));release.resolve();await execution;await waitSettled(f);
    assert.equal(f.state.recorded.length,0);assert.equal(f.state.texts.length,textsBeforeCancel);assert.equal(f.jobs.status(event()).jobs[0].status,'cancelled');
  }
});

test('uncertain voice outcome has no retry or fallback; known pre-message failure falls back once',async t=>{
  for(const known of [false,true]){const f=await fixture(t);f.state.voice=()=>{throw Object.assign(Error('private upstream details'),known?{messageNotSent:true}:{});};
    const result=await f.jobs.execute(event(),request(),f.callbacks);assert.equal(f.state.voices.length,1);assert.equal(f.state.synthesis.length,1);
    assert.equal(f.state.texts.length,known?1:0);assert.equal(f.jobs.status(event()).jobs[0].status,known?'sent':'delivery_uncertain');
    assert.equal(JSON.stringify(result).includes('private upstream details'),false);
  }
});

test('generation failure and failed validation become one safe text response with no raw error',async t=>{
  for(const validation of [false,true]){const f=await fixture(t);if(validation)f.state.verified=false;else f.state.synth=()=>{throw Error('secret-provider-body');};
    const result=await f.jobs.execute(event(),request(),f.callbacks);assert.equal(f.state.voices.length,0);assert.equal(f.state.texts.length,1);
    assert.match(result.sent_text,/先用文字/);assert.equal(result.sent_text.includes('secret-provider-body'),false);
  }
});

test('expired source and external epoch changes suppress deferred dispatch',async t=>{
  for(const expire of [false,true]){let clock=Date.now();const f=await fixture(t,{foregroundMs:5,now:()=>clock}),pending=defer();f.state.synth=()=>pending.promise;
    await f.jobs.execute(event(),{...request(),expiresAt:clock+1000},f.callbacks);
    if(expire)clock+=1000;else f.state.current=false;pending.resolve({synthetic:true});await waitSettled(f);
    assert.equal(f.state.voices.length,0);assert.equal(f.state.recorded.length,0);assert.equal(f.state.texts.length,0);
  }
});

test('restart marks unfinished ledger interrupted and cannot replay it',async t=>{
  const f=await fixture(t,{foregroundMs:5}),pending=defer();f.state.synth=()=>pending.promise;
  await f.jobs.execute(event(),request(),f.callbacks);await f.jobs.writes;const snapshot=await readFile(path.join(f.dataDir,'speech_jobs.json'));
  const restored=await fixture(t);await writeFile(path.join(restored.dataDir,'speech_jobs.json'),snapshot);
  const restarted=await SpeechJobs.open({dataDir:restored.dataDir,synthesize:()=>assert.fail('restart must not synthesize'),verifyPrepared:()=>true});
  const result=await restarted.execute(event(),request(),restored.callbacks);assert.equal(result.deferredSpeech.status,'interrupted');assert.equal(restored.state.texts.length,0);
  await restarted.stop();pending.resolve({synthetic:true});await waitSettled(f);
});

test('persistence failure before generation or send prevents corresponding side effect',async t=>{
  for(const failAt of [1,4]){let saves=0;const f=await fixture(t,{save:async(file,bytes)=>{if(++saves===failAt)throw Error('synthetic disk failure');await durableWriteFile(file,bytes);}});
    const outcome=await f.jobs.execute(event(),request(),f.callbacks).catch(error=>({error:error.code}));
    assert.equal(f.state.synthesis.length,failAt===1?0:1);assert.equal(f.state.voices.length,0);assert.equal(f.state.texts.length,0);assert.equal(f.jobs.storageFailed,true);
    assert.equal(f.jobs.live.size,0);assert.ok(outcome.error||outcome.deferredSpeech);
  }
});

test('receipt followed by save failure never sends again and preserves a recoverable reservation',async t=>{
  let saves=0;const f=await fixture(t,{save:async(file,bytes)=>{if(++saves===5)throw Error('disk full after send');await durableWriteFile(file,bytes);}});
  const result=await f.jobs.execute(event(),request(),f.callbacks);assert.equal(result.id,'voice_1');assert.equal(result.persistenceFailed,true);
  assert.equal(f.state.voices.length,1);assert.equal(f.state.texts.length,0);assert.equal(JSON.parse(await readFile(path.join(f.dataDir,'speech_jobs.json'),'utf8')).jobs[0].status,'sending');
  const duplicate=await f.jobs.execute(event(),request(),f.callbacks);assert.ok(duplicate.deferredSpeech);assert.equal(duplicate.sent_text,'');
  await assert.rejects(f.jobs.execute(event('new-source'),request(),f.callbacks),error=>error.code==='speech_jobs_unavailable'&&error.messageNotSent===true);
});

test('recording failure after deferred delivery does not replay a delivered voice',async t=>{
  const f=await fixture(t,{foregroundMs:5}),pending=defer();f.state.synth=()=>pending.promise;f.state.record=()=>{throw Error('memory save failed');};
  await f.jobs.execute(event(),request(),f.callbacks);pending.resolve({synthetic:true});await waitSettled(f);
  assert.equal(f.state.voices.length,1);assert.equal(f.state.recorded.length,1);assert.equal(f.jobs.status(event()).jobs[0].recordingFailed,true);
});

test('invalid store and invalid requests fail without repair or generation',async t=>{
  const f=await fixture(t);for(const input of [{...request(),requested:'yes'},{...request(),text:'a'.repeat(121)}])await assert.rejects(f.jobs.execute(event(),input,f.callbacks),/request_invalid/);
  assert.equal(f.state.synthesis.length,0);const file=path.join(f.dataDir,'speech_jobs.json');await writeFile(file,'{"schemaVersion":1,"epochs":{},"jobs":[],"extra":true}');
  await assert.rejects(SpeechJobs.open({dataDir:f.dataDir,synthesize:()=>{},verifyPrepared:()=>true}),/store_invalid/);
  assert.equal((await readFile(file,'utf8')).includes('extra'),true);
});

test('slow spontaneous job has no notice and only records its eventual real delivery',{timeout:5000},async t=>{
  const f=await fixture(t,{foregroundMs:5}),pending=defer(),started=defer();f.state.synth=()=>{started.resolve();return pending.promise;};
  const result=await f.jobs.execute(event(),{...request(),requested:false},f.callbacks);
  assert.ok(result.deferredSpeech);assert.equal(result.sent_text,'');assert.equal(f.state.texts.length,0);
  // Releasing the foreground does not promise the durable job write finished
  // within five milliseconds. Observe actual synthesis admission, not a timer.
  await started.promise;assert.equal(f.state.synthesis[0].signal.aborted,false);
  pending.resolve({synthetic:true});await waitSettled(f);assert.equal(f.state.voices.length,1);assert.equal(f.state.recorded.length,1);
  const disk=JSON.parse(await readFile(path.join(f.dataDir,'speech_jobs.json'),'utf8'));assert.equal(disk.jobs[0].requested,false);
});

test('spontaneous generation failure falls back with original text and no voice explanation',async t=>{
  const f=await fixture(t);f.state.synth=()=>{throw Error('upstream details');};
  const result=await f.jobs.execute(event(),{...request('刚才那个梗好好笑。'),requested:false},f.callbacks);
  assert.equal(result.sent_text,'刚才那个梗好好笑。');assert.equal(f.state.texts.length,1);assert.equal(f.state.recorded.length,0);
});

test('accepted source is checked before unavailable/invalid and never grants a fallback replay',async t=>{
  const f=await fixture(t);await f.jobs.execute(event(),request(),f.callbacks);await f.jobs.stop();
  const duplicate=await f.jobs.execute(event(),request(),f.callbacks);assert.ok(duplicate.deferredSpeech);assert.equal(f.state.voices.length,1);
  await assert.rejects(f.jobs.execute(event(),{...request(),text:'x'.repeat(121)},f.callbacks),error=>error.code==='speech_job_request_conflict'&&error.messageNotSent!==true);
  await assert.rejects(f.jobs.execute(event('new'),request(),f.callbacks),error=>error.code==='speech_jobs_unavailable'&&error.messageNotSent===true);
});

test('terminal records scrub source text and restart retains only deduplication evidence',async t=>{
  const f=await fixture(t);await f.jobs.execute(event(),request('只需短暂保存的语音内容'),f.callbacks);
  const bytes=await readFile(path.join(f.dataDir,'speech_jobs.json'),'utf8');assert.equal(bytes.includes('只需短暂保存的语音内容'),false);
  const disk=JSON.parse(bytes);assert.equal(disk.jobs[0].text,'');assert.match(disk.jobs[0].textHash,/^[a-f0-9]{64}$/);
  const reopened=await SpeechJobs.open({dataDir:f.dataDir,synthesize:()=>assert.fail('must not replay'),verifyPrepared:()=>true});
  const replay=await reopened.execute(event(),request('只需短暂保存的语音内容'),f.callbacks);assert.ok(replay.deferredSpeech);await reopened.stop();
});

test('capacity recovers after terminal expiry and unused epochs retire with the next reservation',async t=>{
  let clock=Date.now();const f=await fixture(t,{now:()=>clock,maxEntries:1});
  const oldEvent=event('old','old-room'),oldRequest={...request('旧请求'),expiresAt:clock+1000};
  await f.jobs.execute(oldEvent,oldRequest,f.callbacks);await waitSettled(f);
  await assert.rejects(f.jobs.execute(event('new','new-room'),{...request(),expiresAt:clock+60000},f.callbacks),error=>error.code==='speech_jobs_busy'&&error.messageNotSent===true);
  clock+=1000;await f.jobs.execute(event('new','new-room'),{...request(),expiresAt:clock+60000},f.callbacks);await waitSettled(f);
  const disk=JSON.parse(await readFile(path.join(f.dataDir,'speech_jobs.json'),'utf8'));
  assert.equal(disk.jobs.length,1);assert.equal(Object.keys(disk.epochs).length,1);assert.equal(f.jobs.status(oldEvent).jobs.length,0);
  await assert.rejects(f.jobs.execute(oldEvent,oldRequest,f.callbacks),error=>error.code==='speech_job_request_invalid'&&error.messageNotSent===true);
  assert.equal(f.state.synthesis.length,2);
  const reopened=await SpeechJobs.open({dataDir:f.dataDir,now:()=>clock,synthesize:()=>assert.fail('expired replay cannot generate'),verifyPrepared:()=>true});
  await assert.rejects(reopened.execute(oldEvent,oldRequest,f.callbacks),/request_invalid/);await reopened.stop();
});
