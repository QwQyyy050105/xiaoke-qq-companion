import test from 'node:test';
import assert from 'node:assert/strict';
import {planReplySpeech,residentSpeechStatus,speechReplyDeadline} from '../src/reply_speech_route.mjs';
const base={event:{content:'用语音说一句晚安'},content:'晚安',options:{chatReply:true},capability:{available:true,phase:'ready'},state:{model_resident:false},settings:{spontaneousStickers:true},now:500000};
test('explicit cold speech goes to a job, spontaneous cold speech stays text',()=>{
  assert.deepEqual(planReplySpeech(base).job,{text:'晚安',requested:true});
  const spontaneous={...base,event:{content:'晚上好'},content:'',options:{chatReply:true,speech:{text:'晚上好'}}};
  assert.equal(planReplySpeech(spontaneous).job,undefined);
  assert.equal(planReplySpeech(spontaneous).content,'晚上好');
  assert.deepEqual(planReplySpeech({...spontaneous,state:{model_resident:true}}).job,{text:'晚上好',requested:false});
});
test('pause, decline, media, cooldown and disabled unsolicited speech do not create a job',()=>{
  const paused=planReplySpeech({...base,capability:{available:false,phase:'paused'}});
  assert.equal(paused.job,undefined);assert.match(paused.content,/先用文字/);
  for(const overrides of [{event:{content:'不要用语音'}},{options:{chatReply:true,media:{send_id:'synthetic-image'}}},{options:{chatReply:true,math_document:{}}}])assert.equal(planReplySpeech({...base,...overrides}).job,undefined);
  const unsolicited={...base,event:{content:'晚上好'},state:{model_resident:true},options:{chatReply:true,speech:{text:'晚上好'}}};
  assert.equal(planReplySpeech({...unsolicited,lastSentAt:499000}).job,undefined);
  assert.equal(planReplySpeech({...unsolicited,settings:{spontaneousStickers:false}}).job,undefined);
});
test('service progress cannot reserve the voice job before the actual answer',()=>{
  assert.equal(planReplySpeech({...base,content:'我收到啦，正在想你的问题，稍等我一下。',options:{}}).job,undefined);
  assert.deepEqual(planReplySpeech(base).job,{text:'晚安',requested:true});
});
test('redelivery cannot renew the original QQ voice deadline',()=>{
  const timestamp='2026-10-24T12:00:00Z';
  const event={group_openid:'synthetic-room',timestamp,_receivedAt:1};
  const expiry=speechReplyDeadline(event);
  assert.equal(expiry,Date.parse(timestamp)+270000);
  assert.equal(speechReplyDeadline({...event,_receivedAt:expiry+10000}),expiry);
  assert.equal(speechReplyDeadline({_receivedAt:Date.now()}),null);
  assert.equal(speechReplyDeadline({timestamp:'invalid'}),null);
});
test('proactive readiness requires an actually resident shared model',()=>{
  assert.equal(residentSpeechStatus({ready:true}).ready,false);
  assert.equal(residentSpeechStatus({ready:true,model_resident:false}).ready,false);
  assert.equal(residentSpeechStatus({ready:true,model_resident:true}).ready,true);
});
