import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverProactiveSpeech } from '../src/proactive_speech.mjs';

function fixture(overrides={}) {
  const calls=[];
  const args={group:'synthetic-room',text:'晚风还挺舒服。',spoken:{text:'晚风还挺舒服。'},now:()=>500000,
    status:()=>({ready:true,paused:false,pending:0}),settings:()=>({spontaneousStickers:true,proactiveEnabled:true}),
    lastSent:new Map(),synthesize:async text=>{calls.push(['synthesize',text]);return {fixture:true};},
    sendVoice:async()=>{calls.push(['voice']);return {id:'voice-receipt'};},
    sendText:async(group,text)=>{calls.push(['text',text]);return {id:'text-receipt'};},...overrides};
  return {calls,args,run:()=>deliverProactiveSpeech(args)};
}
test('paused or unavailable voice never starts synthesis and falls back to one text',async()=>{
  for(const state of [{ready:false},{ready:true,paused:true},{ready:true,pending:1}]) {
    const f=fixture({status:()=>state});const result=await f.run();
    assert.deepEqual(f.calls,[['text',f.args.text]]);assert.equal(result.delivery.id,'text-receipt');assert.equal(f.args.lastSent.size,0);
  }
});
test('successful dynamic voice has actual receipt and shared room cooldown',async()=>{
  const f=fixture();const first=await f.run();
  assert.equal(first.actual,'[发送语音：晚风还挺舒服。]');assert.equal(f.args.lastSent.get('synthetic-room'),500000);
  await f.run();assert.deepEqual(f.calls.map(x=>x[0]),['synthesize','voice','text']);
});
test('synthesis failure and a pause arriving during synthesis may fall back before QQ send',async()=>{
  const failed=fixture({synthesize:async()=>{throw Error('local synthesis failed');}});await failed.run();assert.equal(failed.calls[0][0],'text');
  let paused=false;const f=fixture({status:()=>({ready:true,paused}),synthesize:async()=>{paused=true;return {fixture:true};}});
  await f.run();assert.deepEqual(f.calls.map(x=>x[0]),['text']);
});
test('uncertain voice delivery never retries or emits fallback text',async()=>{
  for(const sendVoice of [async()=>undefined,async()=>{throw Error('network timeout');}]) {
    const f=fixture({sendVoice});await assert.rejects(f.run());
    assert.deepEqual(f.calls.map(x=>x[0]),['synthesize']);assert.equal(f.args.lastSent.size,0);
  }
});
test('quiet preference arriving during synthesis cancels the send',async()=>{
  let enabled=true;const f=fixture({settings:()=>({spontaneousStickers:true,proactiveEnabled:enabled}),synthesize:async()=>{enabled=false;return {};}});
  await assert.rejects(f.run(),/proactive_disabled/);assert.equal(f.calls.length,0);
});
test('a forgotten or superseded conversation during synthesis cancels before QQ send',async()=>{
  let current=true;const f=fixture({isCurrent:()=>current,synthesize:async()=>{current=false;return {};}});
  await assert.rejects(f.run(),/proactive_stale/);assert.equal(f.calls.length,0);assert.equal(f.args.lastSent.size,0);
});

test('broker verification rejection or failure falls back to one text before any voice upload',async()=>{
  for(const verifyPrepared of [async()=>false,async()=>{throw Error('broker unavailable');}]){
    const f=fixture({verifyPrepared});const result=await f.run();
    assert.deepEqual(f.calls.map(x=>x[0]),['synthesize','text']);
    assert.equal(result.delivery.id,'text-receipt');assert.equal(f.args.lastSent.size,0);
  }
});
test('a valid broker check precedes the one voice send',async()=>{
  const order=[];
  const f=fixture({verifyPrepared:async prepared=>{assert.equal(prepared.fixture,true);order.push('verify');return true;},
    sendVoice:async()=>{order.push('send');return {id:'voice-receipt'};}});
  const result=await f.run();assert.deepEqual(order,['verify','send']);assert.equal(result.delivery.id,'voice-receipt');
});
test('conversation cancellation or quiet preference during broker verification prevents all sends',async()=>{
  for(const change of ['forget','quiet']){
    let current=true,enabled=true;
    const f=fixture({isCurrent:()=>current,settings:()=>({spontaneousStickers:true,proactiveEnabled:enabled}),
      verifyPrepared:async()=>{if(change==='forget')current=false;else enabled=false;return true;}});
    await assert.rejects(f.run(),change==='forget'?/proactive_stale/:/proactive_disabled/);
    assert.deepEqual(f.calls.map(x=>x[0]),['synthesize']);assert.equal(f.args.lastSent.size,0);
  }
});
test('lost broker readiness during verification sends text once and leaves voice cooldown unused',async()=>{
  let ready=true;
  const f=fixture({status:()=>({ready,paused:false,pending:0}),verifyPrepared:async()=>{ready=false;return true;}});
  await f.run();assert.deepEqual(f.calls.map(x=>x[0]),['synthesize','text']);assert.equal(f.args.lastSent.size,0);
});
