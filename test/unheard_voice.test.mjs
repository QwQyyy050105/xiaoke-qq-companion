import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Companion, hash} from '../src/core.mjs';
import {observedContent} from '../src/conversation_input.mjs';
import {conversationPrompt} from '../src/model_client.mjs';
import {GroupRouter} from '../src/routing.mjs';
import {hasOnlyUntranscribedVoice, richMessageContext} from '../src/rich_context.mjs';

const temp = fileURLToPath(new URL('../temp/', import.meta.url));
const owner = {user_openid:'fixture-owner'};
const member = {member_openid:'fixture-member'};
const voice = {content_type:'voice',url:'https://example.invalid/voice'};
const publicVoice = (id, additions={}) => ({id,group_openid:'fixture-group',author:member,attachments:[voice],...additions});

async function runtime(t) {
  await mkdir(temp,{recursive:true});
  const dataDir = await mkdtemp(join(temp,'unheard_voice_'));
  t.after(() => rm(dataDir,{recursive:true,force:true}));
  const prepared = [], generated = [], sent = [];
  const config = {dataDir, pairingHash:hash('fixture-phrase'), progressDelayMs:0,
    prepareInput:async event => {prepared.push(event.id); return {richContext:[richMessageContext(event)]};},
    generate:async input => {generated.push(input); return {reply:'模型根据文字作答'};}};
  const chat = await new Companion(config).init();
  await chat.handle({id:'pair',author:owner,content:'/pair fixture-phrase'}, async () => {});
  const deliver = async content => {sent.push(content); return {id:'receipt-'+sent.length};};
  return {chat,config,prepared,generated,sent,deliver};
}

test('unheard private voice gets one local clarification, persists and deduplicates across restart', async t => {
  const f = await runtime(t);
  const event = {id:'voice', author:owner, attachments:[voice], reference_id:'own-idx'};
  const result = await f.chat.handle({...event, content:observedContent(event)}, f.deliver);
  assert.equal(result.status,'replied');
  assert.match(f.sent[0],/语音.*打几个字/);
  assert.deepEqual(f.prepared,[]); assert.deepEqual(f.generated,[]);
  const reopened = await new Companion(f.config).init();
  assert.equal(reopened.state.history.at(-1).content, f.sent[0]);
  await reopened.handle(event,f.deliver);
  assert.equal(f.sent.length,1);
});

test('unaddressed audio does not ask a whole group to repeat; a real mention upgrades the same event once', async t => {
  const f = await runtime(t);
  const raw = publicVoice('group-voice', {allow_silence:true});
  const event = {...raw, content:observedContent(raw)};
  const router = new GroupRouter({classify:async () => assert.fail('heard no words to classify')});
  assert.equal((await router.decide(event)).addressed,false);
  assert.equal((await f.chat.handle(event,f.deliver)).status,'silent');
  assert.equal(f.sent.length,0);
  const mention = {...event, explicit_mention:true, allow_silence:false};
  assert.equal((await router.decide(mention)).addressed,true);
  assert.equal((await f.chat.handle(mention,f.deliver)).status,'replied');
  await f.chat.handle(mention,f.deliver);
  assert.equal(f.sent.length,1); assert.match(f.sent[0],/语音/);
  assert.deepEqual(f.generated,[]);
});

test('a typed question bundled with unheard audio reaches the model and identifies the exact missing input', async t => {
  const f = await runtime(t);
  const event = {id:'caption',author:owner,content:'今天怎么安排？',attachments:[voice]};
  await f.chat.handle(event,f.deliver);
  const [input] = f.generated;
  assert.equal(input.text,event.content);
  assert.deepEqual(f.prepared,['caption']);
  assert.equal(input.richContext[0].untranscribed_voice_count,1);
  assert.equal(input.richContext[0].message_id,'caption');
  const prompt = conversationPrompt('合成角色',input);
  assert.match(prompt,/有语音没转写出来/);
  assert.doesNotMatch(prompt,/example\.invalid/);
  assert.deepEqual(f.sent,['模型根据文字作答']);
});

test('unheard audio keeps actual transcripts, pictures, quotes, and multi-person text turns on the usual route', () => {
  const unheard = publicVoice('audio');
  assert.equal(hasOnlyUntranscribedVoice({...unheard,message_scene:{ext:['msg_idx=my-own-idx']}}),true);
  assert.equal(hasOnlyUntranscribedVoice({...unheard,content:'[语音]'}),true);
  assert.equal(hasOnlyUntranscribedVoice({content:'[语音]'}),false);
  for (const addition of [
    {attachments:[{...voice,asr_refer_text:'小柯晚上好'}]}, {attachments:[voice,{content_type:'image/png'}]},
    {message_reference:{message_id:'quoted-msg'}}, {message_scene:{ext:['ref_msg_idx=quoted']}},
    {turn_messages:[unheard,{id:'msg2',author:{member_openid:'another'},content:'这个问题怎么做？'}]},
    {msg_elements:[{content:'转发的正文'}]}, {ark_data:{ark_type:'map'}}
  ]) assert.equal(hasOnlyUntranscribedVoice({...unheard,...addition}),false);
  assert.equal(hasOnlyUntranscribedVoice({content:observedContent(unheard)}),false);
});

test('an unpaired stranger receives no private clarification or context', async t => {
  const f = await runtime(t);
  await f.chat.handle({id:'stranger',author:{user_openid:'other'},attachments:[voice]},f.deliver);
  assert.deepEqual(f.sent,[]); assert.deepEqual(f.generated,[]); assert.deepEqual(f.prepared,[]);
});
