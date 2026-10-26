import test from 'node:test';
import assert from 'node:assert/strict';
import { rankStickerCatalog, stickerSelectionRequests } from '../src/sticker_actions.mjs';
import { validateStickerSelection } from '../src/sticker_context.mjs';

const catalog = [
  { id: 'approved_xiao_ke_avatar', type: 'avatar', source: 'approved', title: '小柯头像', label: '白发龙娘头像' },
  { id: 'approved_xiao_ke_answer', type: 'sticker', source: 'approved', title: '这题我会', label: '小柯举手抢答', tags: ['自信', '抢答'] },
  { id: 'collected_pause', type: 'sticker', source: 'collected', title: '猫猫靠近', label: '猫猫反应图', recently_used: true,
    local_note: '小猫安静地靠在另一只猫旁边，没有大笑。', usage_hint: '朋友失落时陪着对方，安慰而不嘲笑。' },
  { id: 'collected_win', type: 'sticker', source: 'collected', title: '小猫击掌', label: '猫猫反应图',
    local_note: '两只猫伸爪击掌。', usage_hint: '获得录取或拿到好成绩，彼此庆祝。' }
];
const media = (send_id, message_id, evidence, options = {}) => ({ send_id,
  selection: { fit: 'contextual', message_id, catalog_evidence: evidence, intent: '用安静陪伴的画面接住这位朋友的失落。', ...options } });
const validate = (input, selected, options = {}) => validateStickerSelection({ catalog, input, media: selected, ...options });

test('retrieval considers notes and local conversation while recent use never outranks relevance', () => {
  const input = { id: 'ask', content: '小柯，发一个适合现在气氛的表情' };
  const roomMessages = [{ messageId: 'previous', role: 'user', content: '今天有点失落，能安静陪着我就好了。' }];
  const before = structuredClone(catalog);
  const ranked = rankStickerCatalog(catalog, input, { roomMessages });
  assert.equal(ranked[0].id, 'collected_pause');
  assert.deepEqual(catalog, before);
  assert.equal(ranked.length, catalog.length);
  assert.equal(ranked[0].usage_hint, catalog[2].usage_hint);
  assert.equal(ranked[0].local_note, catalog[2].local_note);
  const equal = [{ id: 'used', type: 'sticker', title: '猫咪', recently_used: true }, { id: 'unused', type: 'sticker', title: '猫咪' }];
  assert.equal(rankStickerCatalog(equal, '发个表情')[0].id, 'unused');
});

test('asking 小柯 for collected images does not become a request for her fixed character stickers', () => {
  const input = { id: 'ask', content: '小柯，发一个你收藏过、适合现在气氛的表情' };
  const ranked = rankStickerCatalog(catalog, input);
  assert.equal(ranked[0].source, 'collected');
  assert.equal(stickerSelectionRequests(catalog, input)[0].own, false);
  assert.equal(validate(input, media('approved_xiao_ke_answer', 'ask', '这题我会')).reason, 'selection_request_mismatch');
  assert.equal(validate(input, media('collected_pause', 'ask', '安慰而不嘲笑')).allowed, true);
});

test('natural requests after chat clauses use their own preferences rather than the whole message', () => {
  for (const content of [
    '终于忙完了，好累，发个你收藏的表情',
    '这题我会不好看，发个你收藏的表情',
    '别再发“这题我会”了。小柯，发个你收藏的表情',
    '终于忙完了，发个表情，最好是你收藏的',
    '他说“发这题我会”，不过发个你收藏的表情'
  ]) {
    const input = { id: 'ask', content };
    const [request] = stickerSelectionRequests(catalog, input);
    assert.ok(request, content);
    assert.deepEqual(request.titles, [], content);
    assert.equal(request.collected, true, content);
    assert.equal(rankStickerCatalog(catalog, input)[0].source, 'collected', content);
    assert.equal(validate(input, media('collected_pause', 'ask', '安慰而不嘲笑', { fit: 'requested' })).allowed, true, content);
    assert.equal(validate(input, media('approved_xiao_ke_answer', 'ask', '这题我会', { fit: 'requested' })).allowed, false, content);
  }
  const quotedCaption = stickerSelectionRequests(catalog, { id: 'ask', content: '刚忙完，好了，发“猫猫靠近”吧' });
  assert.deepEqual(quotedCaption[0].titles, ['猫猫靠近']);
});

test('quoted or reported requests are not current sender preferences', () => {
  for (const content of [
    '他说“发这题我会”，我看到了',
    '他说：发“这题我会”的表情',
    '他说，发“这题我会”的表情',
    '今天他问我，原话是，发“这题我会”的表情',
    '> 发个你收藏的表情\n我觉得这句话很奇怪',
    '“发个你收藏的表情”',
    '`发个你收藏的表情`是什么意思'
  ]) assert.deepEqual(stickerSelectionRequests(catalog, { id: 'reported', content }), [], content);
  const input = { id: 'actual', content: '他说，发“这题我会”的表情。不过发个你收藏的表情。' };
  const [request] = stickerSelectionRequests(catalog, input);
  assert.deepEqual(request.titles, []);
  assert.equal(request.collected, true);
});

test('a trailing negative caption preference excludes that image rather than requesting it', () => {
  const input = { id: 'ask', content: '发个表情，不要再发“这题我会”' };
  const [request] = stickerSelectionRequests(catalog, input);
  assert.deepEqual(request.titles, []);
  assert.deepEqual(request.excludedTitles, ['这题我会']);
  assert.notEqual(rankStickerCatalog(catalog, input)[0].id, 'approved_xiao_ke_answer');
  assert.equal(validate(input, media('approved_xiao_ke_answer', 'ask', '这题我会', { fit: 'requested' })).allowed, false);
  assert.equal(validate(input, media('collected_pause', 'ask', '安慰而不嘲笑', { fit: 'requested' })).allowed, true);
});

test('semantic no-fit verdict sends no sticker instead of falling back to first or unused catalog item', () => {
  const input = { id: 'ask', content: '小柯，发一个适合现在气氛的表情' };
  const result = validate(input, media('approved_xiao_ke_answer', 'ask', '这题我会', { fit: 'none' }));
  assert.deepEqual(result, { allowed: false, sendId: '', reason: 'selection_no_fit' });
  assert.equal(validate(input, { send_id: 'approved_xiao_ke_answer' }).reason, 'selection_missing');
});

test('same-turn brief selection evidence must belong to the selected sticker and an observed target', () => {
  const input = { id: 'ask', content: '今天有点难过' };
  assert.equal(validate(input, media('collected_pause', 'ask', '安慰而不嘲笑')).allowed, true);
  assert.equal(validate(input, media('collected_pause', 'ask', '赢了所以庆祝')).reason, 'selection_evidence_mismatch');
  assert.equal(validate(input, media('collected_pause', 'not-observed', '安慰而不嘲笑')).reason, 'selection_target_unknown');
  assert.equal(validate(input, media('collected_pause', '', '安慰而不嘲笑')).reason, 'selection_target_missing');
  assert.equal(validate(input, media('collected_pause', 'ask', '安慰而不嘲笑', { intent: '' })).reason, 'selection_intent_missing');
  assert.equal(validate(input, media('collected_pause', 'ask', '安慰而不嘲笑', { fit: 'requested' })).reason, 'selection_request_missing');
});

test('explicit title preference wins over neighboring topic and exact user repetition remains allowed', () => {
  const input = { id: 'ask', content: '再发一次“这题我会”的表情' };
  const roomMessages = [{ messageId: 'previous', content: '录取了，庆祝一下' }];
  assert.equal(rankStickerCatalog(catalog, input, { roomMessages })[0].id, 'approved_xiao_ke_answer');
  assert.equal(validate(input, media('approved_xiao_ke_answer', 'ask', '这题我会', { fit: 'requested' })).allowed, true);
  assert.equal(validate(input, media('collected_win', 'ask', '彼此庆祝')).reason, 'selection_request_mismatch');
});

test('concurrent different requests retain their target instead of merging into one group mood', () => {
  const input = { group_openid: 'same-room', content: 'ignored fallback', turn_messages: [
    { id: 'sad', content: '发“猫猫靠近”陪陪我' },
    { id: 'happy', content: '发“小猫击掌”庆祝我收到录取' }
  ] };
  assert.equal(validate(input, media('collected_pause', 'sad', '安慰而不嘲笑')).allowed, true);
  assert.equal(validate(input, media('collected_pause', 'happy', '安慰而不嘲笑')).reason, 'selection_request_mismatch');
  assert.equal(validate(input, media('collected_win', 'happy', '彼此庆祝')).allowed, true);
  assert.equal(validate(input, media('collected_win', 'previous', '彼此庆祝'), {
    roomMessages: [{ messageId: 'previous', content: '刚才聊的其他话题' }]
  }).reason, 'selection_request_target_required');
});

test('caller-scoped recent targets work but foreign scope and unrelated fallback are not inferred', () => {
  const input = { group_openid: 'here', id: 'fallback', content: '发这题我会', turn_messages: [{ id: 'current', content: '你继续' }] };
  assert.equal(stickerSelectionRequests(catalog, input).length, 0);
  const selection = media('collected_pause', 'prior', '安慰而不嘲笑');
  assert.equal(validate(input, selection, { roomMessages: [{ messageId: 'prior', content: '有点失落', group_openid: 'elsewhere' }] }).allowed, false);
  assert.equal(validate(input, selection, { roomMessages: [{ messageId: 'prior', content: '有点失落', group_openid: 'here' }] }).allowed, true);
  assert.equal(stickerSelectionRequests(catalog, { id: 'reported', content: '他刚给我发了“这题我会”的表情' }).length, 0);
});

test('proactive fresh thought can have no message target, while avatars/raw images keep original permission checks', () => {
  assert.equal(validate({ mode: 'proactive' }, media('collected_pause', '', '安慰而不嘲笑')).allowed, true);
  assert.equal(validate({ mode: 'proactive' }, media('collected_pause', '', '安慰而不嘲笑', { fit: 'none' })).allowed, false);
  for (const send_id of ['approved_xiao_ke_avatar', 'not_in_catalog']) {
    assert.deepEqual(validate({ id: 'a', content: '把头像发我' }, { send_id }), {
      allowed: true, sendId: send_id, reason: 'not_sticker_unverified'
    });
  }
  assert.deepEqual(validate({}, {}), { allowed: true, sendId: '', reason: 'no_image' });
});

test('captionless current private image can anchor a sticker without inventing a target or request', () => {
  const input = { id: 'private-image', content: '', attachments: [{ content_type: 'image/png' }] };
  assert.equal(validate(input, media('collected_pause', input.id, '安慰而不嘲笑')).allowed, true);
  assert.equal(validate(input, media('collected_pause', 'not-observed', '安慰而不嘲笑')).reason, 'selection_target_unknown');
  assert.equal(validate(input, media('collected_pause', input.id, '安慰而不嘲笑', { fit: 'requested' })).reason, 'selection_request_missing');
  assert.equal(validate({ ...input, attachments: [] }, media('collected_pause', input.id, '安慰而不嘲笑')).reason, 'selection_target_unknown');
  assert.equal(validate({ ...input, id: '' }, media('collected_pause', 'private-image', '安慰而不嘲笑')).reason, 'selection_target_unknown');
});

test('captionless current group sticker retains actual batch identity and group scope checks', () => {
  const input = { group_openid: 'here', turn_messages: [
    { id: 'group-image', content: '', group_openid: 'here', attachments: [{ content_type: 'image/gif' }] },
    { id: 'other-room-image', content: '', group_openid: 'elsewhere', attachments: [{ content_type: 'image/gif' }] }
  ] };
  assert.equal(validate(input, media('collected_pause', 'group-image', '安慰而不嘲笑')).allowed, true);
  assert.equal(validate(input, media('collected_pause', 'other-room-image', '安慰而不嘲笑')).reason, 'selection_target_unknown');
  assert.equal(validate(input, media('collected_pause', 'group-image', '不属于目录的用途')).reason, 'selection_evidence_mismatch');
  assert.equal(validate(input, media('collected_pause', 'not-observed', '安慰而不嘲笑')).reason, 'selection_target_unknown');
});

test('the model-visible 41st through 60th recent room entries remain valid reply and proactive anchors', () => {
  const roomMessages = Array.from({ length: 65 }, (_, index) => ({ messageId: `room-${index}`, content: '我刚才也有点失落', group_openid: 'here' }));
  for (const input of [{ id: 'current', content: '接着刚才聊吧', group_openid: 'here' }, { mode: 'proactive', group_openid: 'here' }]) {
    for (let index = 5; index < 25; index++) {
      assert.equal(validate(input, media('collected_pause', `room-${index}`, '安慰而不嘲笑'), { roomMessages }).allowed, true, `index ${index}`);
    }
    assert.equal(validate(input, media('collected_pause', 'room-4', '安慰而不嘲笑'), { roomMessages }).reason, 'selection_target_unknown');
    assert.equal(validate(input, media('collected_pause', 'invented', '安慰而不嘲笑'), { roomMessages }).reason, 'selection_target_unknown');
  }
});
