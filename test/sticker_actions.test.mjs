import test from 'node:test';
import assert from 'node:assert/strict';
import { stickerCreationRequest, hasExplicitStickerCreationRequest, resolveStickerCreation, rankStickerCatalog } from '../src/sticker_actions.mjs';

test('current direct creation and edit instructions authorize image work, including a quoted caption', () => {
  for (const content of ['先制作这题我会', '小柯，先制作这题我会', '<@1234> 柯霜，帮我画一张表情包',
    '请小柯制作一张“这题我会”的表情包', '制作“这题我会”', '帮我画一只白色龙娘', '你直接制作一套表情包',
    '我想让你画一张头像', '我需要你帮我画一张头像', '给你自己设计一款QQ头像',
    '改图，把背景改成紫色', '把这张图改成漫画', '> 别人说：你不能画\n帮我生成一张笑脸']) {
    assert.equal(hasExplicitStickerCreationRequest({ id: 'real', content }), true, content);
  }
});

test('capability questions, quotations, descriptions, negations and existing-image sends do not authorize generation', () => {
  for (const content of ['你会画图吗', '能不能制作表情包', '你有没有画图能力', '你可以制作表情包吗？',
    '你能不能帮我画一张表情包', '请问你能制作表情包吗', '先别制作表情包', '不用画了', '下次帮我画一张',
    '如果可以就制作一张表情包', '他说：制作一张表情包', '他说“小柯制作一张表情包”',
    '“帮我制作一张表情包”', '> 帮我制作一张表情包', '```text\n帮我画一张表情包\n```',
    '`制作表情包`是什么意思', '发个自己的表情包', '发“这题我会”的表情包', '找张小柯的表情',
    '制作表情包的步骤是什么', '画图要多久', '生成表情包要多少钱', '改图吗',
    '生成一个随机数', '画过表情包吗', '小柯画得真好', '画画真好玩', '画图需要很多时间', '制作表情包很有趣',
    '画风很可爱', '画室今天不开门', '画质不错']) {
    assert.equal(hasExplicitStickerCreationRequest({ content }), false, content);
  }
  for (const input of [{ text: '你好', history: [{ role: 'user', content: '制作表情包' }] },
    { content: '不错', quote: { content: '帮我画表情包' }, msg_elements: [{ content: '帮我画表情包' }] },
    { content: '', text: '帮我画表情包' }, { mode: 'proactive', text: '帮我画一张' },
    { mode: 'routing', text: '帮我画一张' }, { content: '帮我画一张', role: 'assistant' }]) {
    assert.equal(hasExplicitStickerCreationRequest(input), false);
  }
});

test('multi-member batches use each real current request and preserve source IDs without reading stale fallback text', () => {
  const input = { group_openid: 'room-a', content: 'stale fallback', turn_messages: [
    { id: 'a', author: { member_openid: 'alice' }, content: '先制作这题我会' },
    { id: 'b', author: { member_openid: 'bob' }, content: '你会画吗？' },
    { id: 'c', author: { member_openid: 'carol' }, content: '帮我制作一张晚安表情' },
    { id: 'other', group_openid: 'room-b', content: '画张图' },
    { id: 'bot', role: 'assistant', content: '画张图' }
  ] };
  const result = stickerCreationRequest(input);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.sourceIds, ['a', 'c']);
  assert.deepEqual(result.requests, [{ messageId: 'a', content: '先制作这题我会' }, { messageId: 'c', content: '帮我制作一张晚安表情' }]);
  assert.equal(hasExplicitStickerCreationRequest({ content: '画张图', turn_messages: [] }), false);
  assert.equal(hasExplicitStickerCreationRequest({ text: '画张图', turnMessages: [{ messageId: 'last', content: '你好' }] }), false);
  assert.deepEqual(stickerCreationRequest({ text: '你好', turnMessages: [{ messageId: 'first', speaker: 'member_a', content: '制作一张表情包' }] }).sourceIds, ['first']);
});

test('model creation proposals are reauthorized and bounded, without treating paths or media IDs as authority', () => {
  const suggestion = { create_prompt: '白发紫眼龙娘举手，字幕“这题我会”，可爱表情包', title: '这题我会', send_id: 'invented' };
  assert.deepEqual(resolveStickerCreation({ id: 'm1', content: '先制作这题我会' }, suggestion), {
    prompt: suggestion.create_prompt, title: '这题我会', sourceIds: ['m1']
  });
  for (const input of ['你会画图吗', '发个自己的表情包', '你好']) assert.equal(resolveStickerCreation(input, suggestion), null);
  assert.equal(resolveStickerCreation('制作这题我会', { create_prompt: ' ' }), null);
  assert.equal(resolveStickerCreation('制作这题我会', { create_prompt: '字'.repeat(4001) }), null);
  assert.equal(resolveStickerCreation('制作这题我会', { create_prompt: '图', title: '字'.repeat(90) }).title.length, 80);
  assert.equal(resolveStickerCreation('制作这题我会', { create_prompt: '图' }).title, '小柯专属表情');
});

const catalog = [
  { id: 'approved_xiao_ke', type: 'avatar', label: '小柯本人头像，白发龙娘', title: '小柯头像' },
  { id: 'received_cat', type: 'sticker', label: '猫咪表情', title: '这题我会', tags: ['自信'] },
  { id: 'approved_xiao_ke_confident', type: 'sticker', label: '小柯专属表情', title: '这题我会', tags: ['自信', '得意', '交给我'] },
  { id: 'approved_xiao_ke_sleep', type: 'sticker', label: '小柯专属晚安表情', title: '晚安', tags: ['睡觉', '困'] }
];

test('the requested own sticker ranks ahead of avatar and other-character exact-title matches without changing catalog', () => {
  const before = structuredClone(catalog);
  for (const text of ['发个自己的“这题我会”表情包', '小柯发这题我会', '发个自己的表情包']) {
    assert.equal(rankStickerCatalog(catalog, text)[0].id, 'approved_xiao_ke_confident', text);
  }
  assert.deepEqual(catalog, before);
  assert.notEqual(rankStickerCatalog(catalog, ''), catalog);
  assert.equal(rankStickerCatalog(catalog, '')[0], catalog[0]);
});

test('title, optional tags, label-only legacy catalog and semantic alternatives contribute stable relevance', () => {
  assert.equal(rankStickerCatalog(catalog, '发张你的头像')[0].id, 'approved_xiao_ke');
  assert.equal(rankStickerCatalog(catalog, '我来看看你的头像')[0].id, 'approved_xiao_ke');
  assert.equal(rankStickerCatalog(catalog, '发张你困了的表情')[0].id, 'approved_xiao_ke_sleep');
  assert.equal(rankStickerCatalog(catalog, '发张交给我的表情')[0].id, 'approved_xiao_ke_confident');
  const legacy = [{ id: 'avatar', label: '小柯头像' }, { id: 'sticker', label: '小柯这题我会表情包' }];
  assert.equal(rankStickerCatalog(legacy, '发自己的这题我会表情包')[0].id, 'sticker');
  const tied = [{ id: 'a', title: '笑一下', tags: '开心,高兴' }, { id: 'b', title: '笑一下', tags: ['开心'] }];
  assert.deepEqual(rankStickerCatalog(tied, '高兴'), tied);
  assert.deepEqual(rankStickerCatalog(tied, '完全无关'), tied);
  assert.deepEqual(rankStickerCatalog(null, '发张图'), []);
});
