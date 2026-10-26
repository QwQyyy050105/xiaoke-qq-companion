import test from 'node:test';
import assert from 'node:assert/strict';
import { speechCapability, readSpeechCapability, prepareReplySpeech, replySpeechFallback, deliverReplyVoice } from '../src/speech_capability.mjs';
import { conversationPrompt } from '../src/model_client.mjs';
import { Companion, hash } from '../src/core.mjs';
import { QQClient } from '../src/qq.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const ready = { ready: true, paused: false, phase: 'ready' };
const text = '晚安，明天再接着聊。';
const promptData = input => JSON.parse(conversationPrompt('synthetic persona', { structured: true, text: '用语音说晚安', ...input }).split('\n').at(-1));

test('ordinary prompt exposes current synthesis status separately from the approved voice catalog', () => {
  for (const [state, phase, available] of [[ready, 'ready', true], [{ ...ready, paused: true }, 'paused', false],
    [{ ready: false, phase: 'loading_model' }, 'warming', false], [{ ready: false, phase: 'failed' }, 'unavailable', false],
    [undefined, 'unavailable', false]]) {
    const input = { speechStatus: state, voiceCatalog: [{ id: 'approved_goodnight', label: '已有晚安语音' }] };
    const data = promptData(input);
    assert.equal(data.speech_status.phase, phase); assert.equal(data.speech_status.available, available);
    assert.equal(data.voice_catalog[0].id, 'approved_goodnight');
    assert.deepEqual(data.speech_format, {output:'spoken_voice',melodic_singing:false});
    const prompt = conversationPrompt('synthetic persona', input);
    assert.doesNotMatch(prompt, /明确要语音(?:时)?必须/);
    assert.match(prompt, /状态只用于选择表达方式/);
  }
});

test('fresh pause control takes precedence over a stale ready flag without warming or changing the engine', () => {
  let statusReads = 0;
  const engine = { status: () => { statusReads++; return ready; }, readControl: () => ({ paused: true }),
    warm: () => assert.fail('must not warm'), applyResourceControl: () => assert.fail('must not change the engine') };
  const state = readSpeechCapability(engine);
  assert.equal(state.available, false); assert.equal(state.phase, 'paused'); assert.equal(statusReads, 1);
  assert.equal(readSpeechCapability({ ...engine, readControl: () => { throw Error('cannot read control'); } }).available, false);
  assert.equal(readSpeechCapability({ ...engine, readControl: () => ({}) }).available, false);
  assert.equal(readSpeechCapability({ ...engine, readControl: () => ({ paused: false }) }).available, true);
});

test('shared control rejects stale ready and a throwing status read without synthesis side effects',()=>{
  let allowed=true;
  const engine={status:()=>ready,readControl:()=>({paused:false}),readSharedStatus:()=>({inferenceAllowed:allowed,generationImplemented:true,paused:!allowed})};
  assert.equal(readSpeechCapability(engine).available,true);
  allowed=false;assert.equal(readSpeechCapability(engine).available,false);
  engine.readSharedStatus=()=>undefined;assert.equal(readSpeechCapability(engine).available,false);
  engine.readSharedStatus=()=>{throw Error('missing shared control');};
  assert.equal(readSpeechCapability(engine).available,false);
});

test('paused, warming, unavailable and failed status reads never invoke synthesis for an explicit request', async () => {
  for (const status of [() => ({ ...ready, paused: true }), () => ({ phase: 'warming_model' }), () => ({}), () => { throw Error('status unavailable'); }]) {
    const result = await prepareReplySpeech({ content: '准备给你说晚安。', text, requested: true, status,
      synthesize: () => assert.fail('must not synthesize or start a cold model') });
    assert.equal(result.prepared, null); assert.equal(result.replaceMessages, true);
    assert.match(result.content, /文字/); assert.ok(result.content.endsWith(text));
  }
});

test('ordinary conversation falls back silently and a catalog voice does not require dynamic synthesis', async () => {
  const base = { content: '刚才那个梗还挺好笑。', text, status: () => ({ paused: true }),
    synthesize: () => assert.fail('must not synthesize') };
  const casual = await prepareReplySpeech(base);
  assert.equal(casual.content, base.content); assert.equal(casual.replaceMessages, false);
  assert.doesNotMatch(casual.content, /语音|准备|恢复/);
  const catalog = await prepareReplySpeech({ ...base, requested: true, hasMedia: true });
  assert.equal(catalog.content, base.content); assert.equal(catalog.replaceMessages, false); assert.equal(catalog.prepared, null);
});

test('ready speech preserves the generated audio and does not add an unnecessary text notice', async () => {
  const prepared = { buffer: Buffer.from('synthetic audio'), label: text }; let calls = 0;
  const result = await prepareReplySpeech({ content: text, text, requested: true, status: () => ready,
    synthesize: async value => { calls++; assert.equal(value, text); return prepared; } });
  assert.equal(calls, 1); assert.equal(result.prepared, prepared); assert.equal(result.content, text);
  assert.equal(result.replaceMessages, false);
});

test('pause arriving during synthesis discards the prepared audio before delivery', async () => {
  let paused = false; let calls = 0;
  const engine = { status: () => ready, readControl: () => ({ paused }) };
  const result = await prepareReplySpeech({ content: text, text, requested: true, status: () => readSpeechCapability(engine),
    synthesize: async () => { calls++; paused = true; return { buffer: Buffer.from('synthetic audio') }; } });
  assert.equal(calls, 1); assert.equal(result.prepared, null); assert.equal(result.replaceMessages, true);
  assert.match(result.content, /还没恢复/); assert.ok(result.content.endsWith(text));
});

test('a real synthesis failure becomes text once, and an existing truthful explanation is not repeated', async () => {
  let calls = 0;
  const result = await prepareReplySpeech({ content: text, text, requested: true, status: () => ready,
    synthesize: async () => { calls++; throw Error('synthetic failure'); } });
  assert.equal(calls, 1); assert.equal(result.prepared, null); assert.match(result.content, /没生成好/);
  const already = '声音还没恢复，先用文字说晚安。';
  const fallback = replySpeechFallback({ content: already, text: already, requested: true, state: speechCapability({ paused: true }) });
  assert.equal(fallback.content, already); assert.equal(fallback.replaceMessages, true);
});

test('a last-moment pause retains speech-only reply text when the sending adapter must use text', () => {
  const fallback = replySpeechFallback({ content: '', text, requested: false, state: speechCapability({ paused: true }) });
  assert.equal(fallback.content, text); assert.equal(fallback.replaceMessages, false);
});

test('Companion actually retains prepared speech status and the independent voice catalog in generator input', async t => {
  const base = resolve('temp'), dir = await mkdtemp(join(base, 'speech_capability_'));
  const inputs = [], state = speechCapability({ paused: true }), catalog = [{ id: 'approved_goodnight' }];
  const bot = await new Companion({ dataDir: dir, pairingHash: hash('synthetic-pair'),
    prepareInput: async () => ({ speechStatus: state, voiceCatalog: catalog }),
    generate: async input => { inputs.push(input); return { reply: '晚安。' }; } }).init();
  t.after(async () => { await bot.persistence; assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true }); });
  const event = (id, content) => ({ id, content, author: { user_openid: 'synthetic-owner' } });
  await bot.handle(event('pair', '/pair synthetic-pair'), async () => {});
  await bot.handle(event('request', '用语音说晚安'), async () => ({ id: 'synthetic-receipt' }));
  assert.equal(inputs.length, 1); assert.deepEqual(inputs[0].speechStatus, state); assert.deepEqual(inputs[0].voiceCatalog, catalog);
  assert.equal(promptData(inputs[0]).speech_status.phase, 'paused');
});

function wav() {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(16000, 40);
  return buffer;
}
const voiceEvent = { id: 'synthetic-request', group_openid: 'synthetic-room', author: { member_openid: 'synthetic-user' } };

test('pause during upload cancels before messages and permits exactly one text fallback', async () => {
  let current = true, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const upload = new Promise(resolve => { release = resolve; });
  const calls = [], client = new QQClient('synthetic-app', 'synthetic-secret');
  client.api = async path => { calls.push(path); entered(); await upload; return { file_info: 'synthetic-upload' }; };
  let fallbackCalls = 0;
  const work = deliverReplyVoice({ sendVoice: () => client.replyVoice(voiceEvent, { buffer: wav() }, 1, { isCurrent: () => current }),
    onCancelled: () => { fallbackCalls++; return replySpeechFallback({ content: text, text, requested: true, state: { phase: 'paused' } }); } });
  await started; current = false; release();
  const result = await work;
  assert.equal(result.cancelled, true); assert.equal(result.delivery, null); assert.equal(fallbackCalls, 1);
  assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('/files')); assert.match(result.fallback.content, /文字/);
});

test('already paused dynamic delivery never uploads, while an existing catalog voice remains independent', async () => {
  const calls = [], client = new QQClient('synthetic-app', 'synthetic-secret');
  client.api = async path => { calls.push(path); return path.endsWith('/files') ? { file_info: 'synthetic-upload' } : { id: 'synthetic-receipt' }; };
  const cancelled = await deliverReplyVoice({ sendVoice: () => client.replyVoice(voiceEvent, { buffer: wav() }, 1, { isCurrent: () => false }), onCancelled: () => text });
  assert.equal(cancelled.cancelled, true); assert.equal(calls.length, 0);
  const catalog = await deliverReplyVoice({ sendVoice: () => client.replyVoice(voiceEvent, { buffer: wav() }, 1), onCancelled: () => assert.fail('catalog is independent') });
  assert.equal(catalog.delivery.id, 'synthetic-receipt'); assert.equal(calls.length, 2);
});

test('uncertain messages failure or absent receipt never calls the fallback or sends a second text', async () => {
  for (const uncertain of [() => { throw Error('synthetic network timeout'); }, () => ({})]) {
    const calls = [], client = new QQClient('synthetic-app', 'synthetic-secret');
    client.api = async path => { calls.push(path); return path.endsWith('/files') ? { file_info: 'synthetic-upload' } : uncertain(); };
    await assert.rejects(deliverReplyVoice({ sendVoice: () => client.replyVoice(voiceEvent, { buffer: wav() }, 1),
      onCancelled: () => assert.fail('uncertain voice cannot be replayed as text') }), error => error.deliveryUncertain === true);
    assert.equal(calls.length, 2); assert.ok(calls[1].endsWith('/messages'));
  }
});

test('upload failure and invalid file_info are known unsent failures and fall back to text exactly once', async () => {
  for (const upload of [() => { throw Error('synthetic upload timeout'); }, () => ({}), () => ({ file_info: '' }), () => null]) {
    const calls = [], client = new QQClient('synthetic-app', 'synthetic-secret'); let fallbacks = 0;
    client.api = async path => { calls.push(path); assert.ok(path.endsWith('/files')); return upload(); };
    const result = await deliverReplyVoice({ sendVoice: () => client.replyVoice(voiceEvent, { buffer: wav() }, 1),
      onCancelled: error => { fallbacks++; assert.equal(error.messageNotSent, true);
        return replySpeechFallback({ content: text, text, requested: true, state: ready, deliveryFailed: true }); } });
    assert.equal(result.cancelled, true); assert.equal(result.delivery, null); assert.equal(fallbacks, 1); assert.equal(calls.length, 1);
    assert.match(result.fallback.content, /没发出去/); assert.doesNotMatch(result.fallback.content, /没生成好/);
  }
});

test('an invalid target is never marked as a safe text fallback', async () => {
  const client = new QQClient('synthetic-app', 'synthetic-secret');
  client.api = async () => assert.fail('invalid target cannot send');
  await assert.rejects(deliverReplyVoice({ sendVoice: () => client.replyVoice({ id: 'valid-message' }, { buffer: wav() }, 1),
    onCancelled: () => assert.fail('do not retry an invalid target') }), error => error.message === 'qq_invalid_reply_target' && !error.messageNotSent);
});

test('pause after message submission does not discard its confirmed receipt or emit replacement text', async () => {
  let current = true;
  const client = new QQClient('synthetic-app', 'synthetic-secret');
  client.api = async path => {
    if (path.endsWith('/files')) return { file_info: 'synthetic-upload' };
    current = false; return { id: 'already-submitted-receipt' };
  };
  const result = await deliverReplyVoice({ sendVoice: () => client.replyVoice(voiceEvent, { buffer: wav() }, 1, { isCurrent: () => current }),
    onCancelled: () => assert.fail('submitted message is not cancelled') });
  assert.equal(result.delivery.id, 'already-submitted-receipt'); assert.equal(result.cancelled, false);
});
