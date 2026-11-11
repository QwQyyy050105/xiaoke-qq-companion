import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceInput} from '../src/incoming_voice.mjs';
import {observedContent} from '../src/conversation_input.mjs';
import {hasVoiceTranscript} from '../src/rich_context.mjs';
import {conversationPrompt} from '../src/model_client.mjs';

const event = {id:'voice-1', author:{user_openid:'owner'}, attachments:[
  {content_type:'voice', url:'https://gchat.qpic.cn/original', voice_wav_url:'https://gchat.qpic.cn/converted'}
]};
test('uncertain voice names and times are distinguished from typed permission', () => {
  const voice = {attachments:[{content_type:'voice', asr_refer_text:'明天下午四点给小陈'}]};
  assert.equal(hasVoiceTranscript({turn_messages:[voice]}), true);
  assert.equal(hasVoiceTranscript({content:'普通文字'}), false);
  const display = observedContent({...voice, content:'/approve 12345'});
  assert.ok(display.startsWith('[语音转写'));
  assert.match(display, /随语音发送的文字/);
  assert.equal(observedContent({...voice,content:display}), display);
  const transcript = {transcripts:['明天下午四点给小陈']};
  const prompt = conversationPrompt('示例角色', {history:[], memory:[], text:display, richContext:[transcript]});
  assert.match(prompt, /人名、时间、金额/);
  assert.match(prompt, /审批及本机操作需要另发文字指令/);
  assert.doesNotMatch(conversationPrompt('示例角色',{history:[],memory:[],text:'早上好'}), /这是机器转写/);
});

const audio = {buffer:Buffer.from('test'), mime:'audio/wav', fileName:'voice.wav'};
function setup(overrides = {}) {
  const urls = [];
  const voice = createVoiceInput({enabled:() => true, download:async url => { urls.push(url); return audio; },
    recognize:async () => ({status:'ok',text:'今天一起吃饭'}), ...overrides});
  return {voice, urls};
}
test('existing QQ transcript, self events and disabled recognition never download audio', async () => {
  const {voice, urls} = setup();
  const native = {...event, attachments:[{...event.attachments[0], asr_refer_text:'来自平台'}]};
  assert.equal(await voice.apply(native), native);
  assert.match(observedContent(native), /来自平台/);
  assert.equal((await voice.apply({...event, is_self:true})).is_self, true);
  assert.deepEqual(urls, []);
  const disabled = setup({enabled:() => false});
  assert.equal(await disabled.voice.apply(event), event);
  assert.deepEqual(disabled.urls, []);
});
test('duplicate events share transcription, preserve the original object and isolate another room', async () => {
  const {voice, urls} = setup();
  const [first, second] = await Promise.all([voice.apply(event), voice.apply(event)]);
  assert.deepEqual(first, second);
  assert.deepEqual(urls, [event.attachments[0].voice_wav_url]);
  assert.equal(event.attachments[0].asr_refer_text, undefined);
  assert.match(observedContent(first), /语音转写，可能有识别误差.*今天一起吃饭/);
  await voice.apply(event);
  await voice.apply({...event, group_openid:'other-room'});
  assert.equal(urls.length, 2);
});
test('revocation during download prevents audio from reaching the provider', async () => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const old = new AbortController();
  let calls = 0;
  const {voice} = setup({download:async () => {entered.resolve(); return gate.promise;}, recognize:() => {calls++;}});
  const pending = voice.apply(event, old.signal);
  await entered.promise;
  old.abort();
  gate.resolve(audio);
  assert.equal(await pending, event);
  assert.equal(calls, 0);
});
test('a timed-out provider and a reset cannot attach late text to the event', async () => {
  for (const mode of ['timeout', 'reset']) {
    const started = Promise.withResolvers();
    const result = Promise.withResolvers();
    const timer = setTimeout(() => {}, 1000);
    try {
      const {voice} = setup({timeoutMs:25, recognize:() => { started.resolve(); return result.promise; }});
      const pending = voice.apply(event);
      await started.promise;
      if (mode === 'reset') voice.reset();
      assert.equal(await pending, event);
      result.resolve({status:'ok', text:'too late'});
      assert.match(observedContent(event), /没有可用的转写/);
    } finally { clearTimeout(timer); }
  }
});
test('original audio URL is used when QQ supplies no WAV; an unsupported codec keeps the text caption', async () => {
  const {voice, urls} = setup({recognize:async () => ({status:'unsupported'})});
  const raw = {...event, content:'顺便听听这条', attachments:[{content_type:'voice',url:event.attachments[0].url}]};
  assert.equal(await voice.apply(raw), raw);
  assert.deepEqual(urls, [raw.attachments[0].url]);
  assert.equal(observedContent(raw), raw.content);
});
