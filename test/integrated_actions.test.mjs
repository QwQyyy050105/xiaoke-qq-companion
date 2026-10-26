import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Companion, hash } from '../src/core.mjs';
import { conversationPrompt, parseChatResponse } from '../src/model_client.mjs';
import { deliveryPlan } from '../src/delivery_plan.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const event = id => ({ id, group_openid: 'actions-group', author: { member_openid: 'member-a' }, content: '小柯，回应一下' });
async function bot(t, generate, prepareInput = async () => ({})) {
  const dataDir = await fs.mkdtemp(path.join(ROOT, 'temp', 'actions_test_'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return new Companion({ dataDir, pairingHash: hash('fixture'), generate, prepareInput }).init();
}

test('delivery, voice and seen-image annotation metadata cross core with bounded fields; unseen-image notes do not', async t => {
  const generate = async () => ({ reply: '接住。', memories: [], media: { voice_id: 'voice_hello', note_id: 'image-1', note: '白发龙娘', tags: ['小柯'], usage: '打招呼' },
    delivery: { reply_to_message_id: 'actual-observed-message' }, feedback: { level: 'warning', message: '图片传输等待时间较长。' },
    social: { action: 'say', wait: { mode: 'condition', keywords: ['回来'], speakers: ['member_0123456789abcdef', 'secret-invalid-id'], match: 'all' } } });
  const seen = await bot(t, generate, async () => ({ visionFiles: [{ id: 'image-1', path: 'unused-offline-fixture' }] }));
  let metadata;
  const result = await seen.handle(event('seen'), async (text, options) => { metadata = options; return { id: 'reply-seen', sent_text: text }; });
  assert.equal(metadata.media.voice_id, 'voice_hello'); assert.equal(metadata.media.note_id, 'image-1');
  assert.equal(metadata.delivery.reply_to_message_id, 'actual-observed-message'); assert.equal(metadata.feedback.level, 'warning');
  assert.deepEqual(result.social.wait, { mode: 'condition', keywords: ['回来'], speakers: ['member_0123456789abcdef'], match: 'all' });
  const unseen = await bot(t, generate);
  await unseen.handle(event('unseen'), async (text, options) => { assert.equal(options.media.note_id, undefined); return { id: 'reply-unseen', sent_text: text }; });
});

test('a natural image-only reaction is a real replied turn and stores only actual receipt text', async t => {
  const parsed = parseChatResponse(JSON.stringify({ reply: '', memories: [], media: { send_id: 'actual-image' }, social: { action: 'say' } }));
  const instance = await bot(t, async () => parsed);
  const result = await instance.handle(event('image-only'), async (text, options) => {
    assert.equal(text, ''); assert.equal(options.media.send_id, 'actual-image');
    return { id: 'qq-image', sent_text: '', delivered_messages: [{ content: '[发送图片：这题我会]', messageId: 'qq-image' }] };
  });
  assert.equal(result.status, 'replied');
  assert.equal(instance.groupContext('actions-group').at(-1).content, '[发送图片：这题我会]');
  assert.deepEqual(deliveryPlan('', { image: true, used: 4 }), { texts: [], image: true });
  const twoMediaPlan = deliveryPlan('语音和图', { image: true, used: 2 + 1 });
  assert.equal(twoMediaPlan.texts.length, 1); // two prior replies + two media + one text = five.
  assert.throws(() => deliveryPlan('超额', { image: true, used: 3, limit: 4 }), /reply_limit/);
  assert.deepEqual(deliveryPlan('', { image: true, used: 3, limit: 4 }), { texts: [], image: true });
});

test('prompts expose only observed context, actual animation samples and real voice choices with explicit limits', () => {
  const prompt = conversationPrompt('角色', { structured: true, speaker: 'member_0123456789abcdef', text: '看这个',
    visionFiles: [{ id: 'animated', path: 'D:/SECRET_PATH', animation_note: 'Only sampled frames', frame_index: 2, frame_count: 8, source_mime: 'image/gif' }],
    richContext: [{ entries: [{ kind: 'forwarded_message', text: 'quoted evidence' }] }],
    conversationContext: { coverage: 'Only observed group history', active_members: [{ speaker: 'member_0123456789abcdef' }] },
    voiceCatalog: [{ id: 'voice_hello', title: '已批准问候' }] });
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  assert.equal(data.rich_context[0].entries[0].text, 'quoted evidence');
  assert.equal(data.image_inputs[0].frame_index, 2); assert.equal(data.image_inputs[0].frame_count, 8);
  assert.equal(data.voice_catalog[0].id, 'voice_hello'); assert.doesNotMatch(prompt, /SECRET_PATH/);
  assert.equal(data.speech_status.available, false); assert.equal(data.speech_status.phase, 'unavailable');
  assert.match(data.capabilities.media, /当前能力以speech_status为准/);
  assert.match(data.capabilities.media, /已有语音目录独立判断/); assert.match(prompt, /不是完整QQ群成员名单/);
  assert.match(prompt, /旧历史.*不能覆盖/); assert.match(prompt, /note_id只能选本轮image_inputs实际看过/);
  assert.match(prompt, /delivery.reply_to_message_id/); assert.match(prompt, /social.wait/);
});

test('schema describes every supported action without expanding ordinary agent execution tools', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT, 'src/chat_response.schema.json'), 'utf8'));
  for (const key of ['voice_id', 'note_id', 'note', 'tags', 'usage', 'create_prompt', 'title']) assert.ok(schema.properties.media.required.includes(key));
  assert.deepEqual(schema.properties.room_memories.items.properties.operation.enum, ['remember', 'resolve', 'update', 'delete']);
  assert.deepEqual(schema.properties.social.properties.wait.properties.mode.enum, ['timer', 'condition', 'indefinite']);
  assert.equal(schema.properties.delivery.additionalProperties, false);
});
