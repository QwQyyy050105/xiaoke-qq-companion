import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {QwenSpeech} from '../src/qwen_speech.mjs';

function fixture(options={}){
  const children=[];
  const engine=new QwenSpeech(process.cwd(),{startupMs:200,requestMs:300,retryMs:0,readControl:()=>({paused:false}),readSharedStatus:()=>({inferenceAllowed:true,generationImplemented:true,paused:false}),...options,spawnWorker:()=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.requests=[];child.stdin.on('data',data=>child.requests.push(JSON.parse(data)));
    child.respond=data=>child.stdout.write(JSON.stringify(data)+'\n');
    child.kill=()=>{child.killed=true;child.emit('close',0);};children.push(child);return child;
  }});
  return {engine,children};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function ready(f){const started=f.engine.warm();f.children.at(-1).respond({ready:true});await started;}

test('two rooms are serialized and responses are matched to their own request',async t=>{
  const f=fixture();t.after(()=>f.engine.stop());await ready(f);
  const child=f.children[0];const a=f.engine.generate('第一位','a.wav');const b=f.engine.generate('第二位','b.wav');
  await tick();assert.equal(child.requests.length,1);
  child.respond({id:child.requests[0].id,ok:true,duration:1});assert.equal((await a).duration,1);
  await tick();assert.equal(child.requests.length,2);assert.equal(child.requests[1].text,'第二位');
  child.respond({id:child.requests[1].id,ok:true,duration:2});assert.equal((await b).duration,2);
});

test('cold voice returns immediately for text fallback and busy queue stays bounded',async t=>{
  const f=fixture();t.after(()=>f.engine.stop());
  await assert.rejects(f.engine.generate('冷启动','x.wav'),/warming/);
  const started=f.engine.warm();assert.equal(f.children.length,1);f.children[0].respond({ready:true});await started;
  const a=f.engine.generate('a','a.wav');const b=f.engine.generate('b','b.wav');
  const settled=Promise.allSettled([a,b]);await assert.rejects(f.engine.generate('c','c.wav'),/busy/);
  f.engine.stop();const results=await settled;assert.ok(results.every(result=>result.status==='rejected'));
});

test('generation timeout kills its worker and a later warmup recovers',async t=>{
  const f=fixture({requestMs:25});t.after(()=>f.engine.stop());await ready(f);
  await assert.rejects(f.engine.generate('never returns','x.wav'),/timeout/);
  assert.equal(f.children[0].killed,true);assert.equal(f.engine.status().ready,false);
  await ready(f);assert.equal(f.children.length,2);assert.equal(f.engine.status().ready,true);
});

test('wrong response ID is never delivered to another room',async t=>{
  const f=fixture();t.after(()=>f.engine.stop());await ready(f);
  const a=f.engine.generate('hello','x.wav');const rejected=assert.rejects(a,/protocol/);await tick();
  f.children[0].respond({id:'another-room',ok:true});await rejected;assert.equal(f.children[0].killed,true);
});

test('startup failure and malformed output settle waiters instead of hanging',async t=>{
  const f=fixture();t.after(()=>f.engine.stop());let start=f.engine.warm();let rejected=assert.rejects(start,/unavailable/);
  f.children[0].respond({ready:false});await rejected;
  start=f.engine.warm();rejected=assert.rejects(start,/protocol/);f.children[1].stdout.write('invalid\n');await rejected;
});

test('cold model phases are observable and a failed warmup recovers automatically',async t=>{
  const f=fixture({retryMs:10,autoRetryLimit:1});t.after(()=>f.engine.stop());
  const starting=f.engine.warm(),failed=assert.rejects(starting,/unavailable/);
  f.children[0].respond({phase:'loading_model'});assert.equal(f.engine.status().phase,'loading_model');
  f.children[0].respond({ready:false});await failed;
  assert.equal(f.engine.status().failed_phase,'loading_model');
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(f.children.length,2);
  f.children[1].respond({ready:true,load_ms:53000});await tick();
  assert.equal(f.engine.status().ready,true);assert.equal(f.engine.status().load_ms,53000);
});

test('an explicit GPU coordination pause unloads only voice and blocks warmup and retries until resumed',async t=>{
  let paused=false;const f=fixture({retryMs:5,readControl:()=>({paused})});t.after(()=>f.engine.stop());
  await ready(f);paused=true;f.engine.applyResourceControl();
  assert.equal(f.children[0].killed,true);assert.equal(f.engine.status().paused,true);
  await assert.rejects(f.engine.warm(),/voice_paused/);await assert.rejects(f.engine.generate('test','x.wav'),/voice_paused/);
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.children.length,1);
  paused=false;f.engine.applyResourceControl();assert.equal(f.children.length,2);
  f.children[1].respond({ready:true});await tick();assert.equal(f.engine.status().ready,true);
});

test('shared readiness-only state and unreadable controls prevent any worker from starting',async t=>{
  for(const readSharedStatus of [()=>({paused:true,generationImplemented:false,inferenceAllowed:false}),()=>{throw Error('unreadable');},()=>null]){
    const f=fixture({readSharedStatus});t.after(()=>f.engine.stop());
    await assert.rejects(f.engine.warm(),/voice_paused/);
    await assert.rejects(f.engine.generate('synthetic','x.wav'),/voice_paused/);
    assert.equal(f.children.length,0);assert.equal(f.engine.status().ready,false);
  }
});

test('shared pause is reread before dequeuing a second room and suppresses its stdin request',async t=>{
  let allowed=true;
  const f=fixture({readSharedStatus:()=>({inferenceAllowed:allowed,generationImplemented:true,paused:!allowed})});
  t.after(()=>f.engine.stop());await ready(f);const child=f.children[0];
  const a=f.engine.generate('first','a.wav');const b=f.engine.generate('second','b.wav');
  const rejected=assert.rejects(b,/voice_paused/);await tick();assert.equal(child.requests.length,1);
  allowed=false;child.respond({id:child.requests[0].id,ok:true});await a;await rejected;
  assert.equal(child.requests.length,1);assert.equal(child.killed,true);assert.equal(f.engine.status().ready,false);
});

test('a shared pause arriving during warmup cannot publish a stale ready signal or retry',async t=>{
  let allowed=true;
  const f=fixture({retryMs:5,readSharedStatus:()=>({inferenceAllowed:allowed,generationImplemented:true,paused:!allowed})});
  t.after(()=>f.engine.stop());const start=f.engine.warm();const rejected=assert.rejects(start,/voice_paused/);
  allowed=false;f.children[0].respond({ready:true});await rejected;
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.children.length,1);assert.equal(f.engine.status().ready,false);
});
