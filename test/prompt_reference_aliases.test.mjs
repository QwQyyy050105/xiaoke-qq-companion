import test from 'node:test';
import assert from 'node:assert/strict';
import { compactReferences } from '../src/prompt_references.mjs';
import { conversationPrompt } from '../src/model_client.mjs';

test('image and quote reference spellings share one reversible alias without changing media IDs or source prose', () => {
  const messageId = 'qq-message-' + 'm'.repeat(260), referenceId = 'qq-reference-' + 'r'.repeat(260);
  const original = {
    roomHistory: [{ messageId, referenceId, content: '原话保留 ' + messageId }],
    mediaCatalog: [{ id: 'received_image_123', message_id: messageId, reference_id: referenceId }],
    quotes: [{ messageId, reference_id: referenceId, sourceMessageId: messageId, content: '合成引用原文' }],
    referenceDiagnostics: [{ reference_id: referenceId, sourceMessageId: messageId, status: 'reference_images_loaded' }]
  };
  const before = structuredClone(original), projected = compactReferences(original);
  assert.equal(projected.referenceCount, 2);
  assert.equal(projected.input.mediaCatalog[0].message_id, projected.input.roomHistory[0].messageId);
  assert.equal(projected.input.mediaCatalog[0].reference_id, projected.input.roomHistory[0].referenceId);
  assert.equal(projected.input.quotes[0].sourceMessageId, projected.input.roomHistory[0].messageId);
  assert.equal(projected.input.referenceDiagnostics[0].reference_id, projected.input.roomHistory[0].referenceId);
  assert.deepEqual(projected.restore(projected.input), original);
  assert.deepEqual(original, before);
  const reply = { delivery: { reply_to_message_id: projected.input.mediaCatalog[0].message_id },
    media: { send_id: 'received_image_123' }, reply: '原话 ' + projected.input.roomHistory[0].messageId };
  assert.deepEqual(projected.restore(reply), { ...reply, delivery: { reply_to_message_id: messageId } });
});

test('an original ID in a newly covered field cannot collide with a generated alias', () => {
  const original = { roomHistory: [{ messageId: 'actual-message' }], mediaCatalog: [{ id: 'image_1', reference_id: 'ref_local_1' }],
    referenceDiagnostics: [{ sourceMessageId: '', reference_id: null }], metadata: { message_id: 42 } };
  const projected = compactReferences(original);
  assert.notEqual(projected.input.roomHistory[0].messageId, 'ref_local_1');
  assert.notEqual(projected.input.mediaCatalog[0].reference_id, projected.input.roomHistory[0].messageId);
  assert.deepEqual(projected.restore(projected.input), original);
  assert.deepEqual(projected.restore({ delivery: { reply_to_message_id: 'unrecognized_reference' } }),
    { delivery: { reply_to_message_id: 'unrecognized_reference' } });
});

test('a representative image quote prompt sheds repeated long references with every input body retained', t => {
  const id = (kind, index) => `${kind}_${index}_${'x'.repeat(260)}`;
  const roomHistory = Array.from({ length: 59 }, (_, index) => ({ role: index % 3 === 0 ? 'assistant' : 'user',
    speaker: index % 3 === 0 ? 'xiao_ke' : 'member_aaaaaaaaaaaaaaaa', messageId: id('m', index), referenceId: id('r', index),
    content: `合成消息 ${index}：仅用于引用压缩夹具。`, at: '2026-10-23T15:30:00.000Z' }));
  const original = { structured: true, backgroundMemory: true, speaker: 'member_aaaaaaaaaaaaaaaa', text: '这张图片是什么意思？', roomHistory,
    mediaCatalog: Array.from({ length: 12 }, (_, index) => ({ id: `image_${index}`, source: 'received', message_id: id('m', index), reference_id: id('r', index), label: '合成图片' })),
    quotes: Array.from({ length: 3 }, (_, index) => ({ messageId: id('m', index), reference_id: id('r', index), sourceMessageId: id('m', 58), content: '仅供合成引用' })),
    referenceDiagnostics: Array.from({ length: 3 }, (_, index) => ({ reference_id: id('r', index), sourceMessageId: id('m', 58), status: 'reference_images_loaded' })) };
  const projected = compactReferences(original), previous = structuredClone(projected.input);
  // Reconstruct the prior omission, keeping all other prompt fields identical.
  for (const key of ['mediaCatalog', 'quotes', 'referenceDiagnostics']) for (let index = 0; index < original[key].length; index++) {
    for (const field of ['message_id', 'reference_id', 'sourceMessageId']) {
      if (Object.hasOwn(original[key][index], field)) previous[key][index][field] = original[key][index][field];
    }
  }
  const now = new Date('2026-10-23T16:00:00Z');
  const before = conversationPrompt('小柯。', previous, now), after = conversationPrompt('小柯。', projected.input, now);
  assert.deepEqual(projected.restore(projected.input), original);
  assert.ok(before.length - after.length > 8000);
  for (const { content } of roomHistory) assert.ok(after.includes(content));
  for (const { id: mediaId } of original.mediaCatalog) assert.ok(after.includes(mediaId));
  t.diagnostic(JSON.stringify({ before_prompt_chars: before.length, after_prompt_chars: after.length, saved_chars: before.length - after.length }));
});
