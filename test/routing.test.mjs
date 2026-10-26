import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GroupRouter } from '../src/routing.mjs';

const now = Date.parse('2026-10-22T20:00:00+08:00');
const speaker = (group = 'group-a', member = 'member-a') => `member_${createHash('sha256').update(JSON.stringify([group, member])).digest('hex').slice(0, 16)}`;
let counter = 0;
const event = (content, extra = {}) => ({ id: `m-${++counter}`, group_openid: 'group-a', content, author: { member_openid: 'member-a' }, ...extra });
const bot = (extra = {}) => ({ role: 'assistant', speaker: 'xiao_ke', content: '刚才在聊游戏', messageId: 'bot-message', at: new Date(now - 30_000).toISOString(), reply_to: speaker(), ...extra });

test('explicit official mentions are accepted, but self and bot events are ignored first', async () => {
  const router = new GroupRouter({ now: () => now });
  assert.equal((await router.decide(event('好', { explicit_mention: true }))).addressed, true);
  assert.equal((await router.decide(event('', { event_type: 'GROUP_AT_MESSAGE_CREATE' }))).addressed, true);
  for (const metadata of [{ is_self: true }, { author: { member_openid: 'member-a', bot: true } }, { from_self: true }]) {
    assert.equal((await router.decide(event('你好', { explicit_mention: true, ...metadata }))).addressed, false);
  }
});

test('clear names including the chosen full name route, without forcing unrelated discussion to reply', async () => {
  const router = new GroupRouter({ now: () => now, classify: () => false });
  for (const text of ['柯霜，你在吗', '@柯霜 你好', '小柯，你在吗', '小珂帮我看看', 'Codex 你好', 'GPT娘，出来聊聊', '请小柯帮忙', '你觉得呢，小柯？']) {
    assert.equal((await router.decide(event(text))).addressed, true, text);
  }
  for (const text of ['我觉得小柯挺可爱', '小柯挺可爱', '他说“小柯，你在吗”', '> 小柯，你在吗', '“Codex 帮我”', '昨天有人讨论GPT娘', '大家准备玩什么？']) {
    assert.equal((await router.decide(event(text))).addressed, false, text);
  }
});

test('confirmed other-member mentions are conservative while unknown mention metadata is classified', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return true; } });
  for (const text of ['<@123> 小柯说得怎么样', '@阿明 你刚才说什么', '<@!456> 继续说']) {
    assert.equal((await router.decide(event(text, { mentions_other_members: true }), [bot()])).addressed, false);
  }
  assert.equal(calls.length, 0);
  assert.equal((await router.decide(event('<@123> 这个话题我也参加', { mentions: [{ id: '123' }] }), [bot()])).addressed, true);
  assert.equal((await router.decide(event('@阿明 我们一起问问她吧'), [bot()])).addressed, true);
  assert.equal(calls.length, 2);
});

test('request-shaped verbs after a name bypass classification without treating third-person descriptions as calls', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return false; } });
  for (const text of ['柯霜发个头像', '小柯看看这张图', '小柯讲个笑话', '小柯说说你的想法',
    '小柯读一下这段', '小柯解答这道题', '小柯算一下这个', '请小柯发张图', '小柯发图']) {
    assert.deepEqual(await router.decide(event(text), [bot()]), { addressed: true, reason: 'called_by_name' }, text);
  }
  assert.equal(calls.length, 0);
  for (const text of ['小柯看起来挺可爱', '小柯发了张图', '小柯讲过这个笑话', '小柯说她喜欢猫',
    '小柯说的挺好', '小柯读过这本书', '小柯解答过这道题', '小柯算是个好朋友', '他说“小柯看看这张图”']) {
    assert.equal((await router.decide(event(text), [bot()])).addressed, false, text);
  }
  assert.equal(calls.length, 9);
});

test('clear recent continuations from any member bypass the model while generic you-statements still require it', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return false; } });
  for (const member of ['member-a', 'member-b']) {
    for (const text of ['接着讲', '继续说下去', '那，继续聊刚才那个', '你刚才说的是哪款', '刚才你推荐的那个呢']) {
      assert.deepEqual(await router.decide(event(text, { author: { member_openid: member } }), [bot()]),
        { addressed: true, reason: 'clear_continuation' }, `${member}: ${text}`);
    }
  }
  assert.equal(calls.length, 0);
  for (const text of ['你要吃饭吗', '你有空没', '你觉得今天会下雨吗', '接着讲话的人是谁', '继续说话会被老师发现', '“你刚才说的是哪款”']) {
    assert.equal((await router.decide(event(text), [bot()])).addressed, false, text);
  }
  assert.equal(calls.length, 6);
});

test('the fast continuation window is short while older and pending-only topics retain semantic classification', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return true; } });
  assert.equal((await router.decide(event('接着讲'), [bot({ at: now - 120_000 })])).reason, 'clear_continuation');
  assert.equal((await router.decide(event('接着讲'), [bot({ at: now - 120_001 })])).reason, 'classified_continuation');
  assert.equal((await router.decide(event('你刚才说的那个呢'), [bot({ at: now - 19 * 60_000 })])).reason, 'classified_continuation');
  assert.equal((await router.decide(event('接着讲', { group_openid: 'pending-room' }), [], { pendingMessages: [{ content: '小柯讲个笑话', speaker: speaker(), messageId: 'pending' }] })).reason, 'classified_continuation');
  assert.equal(calls.length, 3);
  const inactive = new GroupRouter({ now: () => now, classify: () => assert.fail('no eligible topic') });
  assert.equal((await inactive.decide(event('接着讲'), [bot({ at: now - 1_200_001 })])).addressed, false);
});

test('clear continuations quoting other or unknown messages do not fast-path and confirmed other-member mentions remain ignored', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return false; } });
  const history = [bot(), { role: 'user', speaker: 'another-member', content: '我来讲故事', messageId: 'human-story', referenceId: 'human-index', at: now - 10_000 }];
  for (const metadata of [
    { message_reference: { message_id: 'human-story' } },
    { message_scene: { ext: ['ref_msg_idx=human-index'] } },
    { reply_to: 'unknown-message' }
  ]) assert.equal((await router.decide(event('接着讲', metadata), history)).reason, 'classified_unrelated');
  assert.equal(calls.length, 3);
  assert.equal((await router.decide(event('接着讲', { mentions_other_members: true }), history)).reason, 'mentions_other_member');
  assert.equal(calls.length, 3);
  assert.equal((await router.decide(event('接着讲', { message_reference: { message_id: 'bot-message' } }), history)).reason, 'references_bot_reply');
  assert.equal(calls.length, 3);
});

test('short responses and emojis receive contextual decisions instead of a blanket exclusion', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return ['好', '😂🐉'].includes(input.text); } });
  for (const text of ['哈哈', '好', '好的！', '嗯嗯', '收到', '😂🐉', 'ok', '谢谢']) {
    assert.equal((await router.decide(event(text), [bot()])).addressed, ['好', '😂🐉'].includes(text), text);
  }
  assert.equal(calls.length, 8);
  assert.equal((await router.decide(event('  '), [bot()])).addressed, false);
  assert.equal(calls.length, 8);
});

test('known QQ bot message references route while unknown references stay unrelated', async () => {
  const router = new GroupRouter({ now: () => now });
  const oldBot = bot({ at: new Date(now - 10 * 60_000).toISOString() });
  assert.equal((await router.decide(event('具体是什么', { message_reference: { message_id: 'bot-message' } }), [oldBot])).addressed, true);
  assert.equal((await router.decide(event('具体是什么', { reply_to: 'bot-message' }), [oldBot])).addressed, true);
  assert.equal((await router.decide(event('具体是什么', { reply_to: 'other-message' }), [oldBot])).addressed, false);
});

test('official QQ scene references match sent ref_idx, preserving equals padding', async () => {
  const router = new GroupRouter({ now: () => now, classify: () => assert.fail('old quote must not need classification') });
  const oldBot = bot({ at: new Date(now - 10 * 60_000).toISOString(), referenceId: 'REFIDX_reply==' });
  const referenced = event('具体是什么', {
    message_type: 103,
    message_scene: { source: 'default', ext: ['msg_idx=REFIDX_incoming==', 'auth_token=opaque', 'ref_msg_idx=REFIDX_reply=='] }
  });
  const decision = await router.decide(referenced, [oldBot]);
  assert.deepEqual(decision, { addressed: true, reason: 'references_bot_reply' });
  for (const ext of [
    ['msg_idx=REFIDX_reply=='], ['auth_token=REFIDX_reply=='], ['ref_msg_idx=unknown'],
    ['ref_msg_idx='], [null, 42, { ref_msg_idx: 'REFIDX_reply==' }], { ref_msg_idx: 'REFIDX_reply==' }
  ]) {
    assert.equal((await router.decide(event('具体是什么', { message_scene: { source: 'default', ext } }), [oldBot])).addressed, false);
  }
  assert.equal((await router.decide({ ...referenced, id: 'quote-to-other', mentions_other_members: true }, [oldBot])).addressed, true);
});

test('fallback followups need a recent eligible bot turn and an actual continuation signal', async () => {
  const router = new GroupRouter({ now: () => now });
  for (const text of ['你刚才说的是什么游戏', '接着讲', '那你怎么看', '这个例子可以展开吗']) {
    assert.equal((await router.decide(event(text), [bot()])).addressed, true, text);
  }
  for (const text of ['晚上吃什么？', '我今天看了个视频', '有人想玩游戏吗？', '我想继续玩游戏', '我们接着打游戏']) {
    assert.equal((await router.decide(event(text), [bot()])).addressed, false, text);
  }
  assert.equal((await router.decide(event('接着讲'), [bot({ at: new Date(now - 241_000).toISOString() })])).addressed, true);
  assert.equal((await new GroupRouter({ now: () => now }).decide(event('接着讲'), [bot({ at: now - 1_201_000 })])).addressed, false);
  const others = [bot({ reply_to: speaker('group-a', 'someone-else') }), { role: 'user', speaker: 'third-member', content: '我们去吃饭', at: now }];
  assert.equal((await router.decide(event('你刚才说什么'), others)).addressed, true);
});

test('classifier sees only eligible bounded public context and the correctly hashed member', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: async input => { calls.push(input); return input.text === '后来呢'; } });
  assert.equal((await router.decide(event('后来呢'), [bot()])).addressed, true);
  assert.equal(calls[0].speaker, speaker());
  assert.equal(calls[0].roomHistory[0].role, 'assistant');
  assert.equal((await router.decide(event('那边正在下雨'), [bot()])).addressed, false);
  assert.equal((await router.decide(event('后来呢'), [bot({ at: now - 300_000 })])).addressed, true);
  assert.equal((await router.decide(event('后来呢', { group_openid: 'inactive-group' }), [bot({ at: now - 1_201_000 })])).addressed, false);
  assert.equal(calls.length, 3);
});

test('classifier failure falls back conservatively, and bare commands need a reply window', async () => {
  const router = new GroupRouter({ now: () => now, classify: async () => { throw new Error('offline'); } });
  assert.equal((await router.decide(event('继续讲'), [bot()])).addressed, true);
  assert.equal((await router.decide(event('今天好热'), [bot()])).addressed, false);
  assert.equal((await router.decide(event('/quiet', { group_openid: 'unrelated-room' }))).addressed, false);
  assert.equal((await router.decide(event('/wake'), [bot()])).addressed, true);
  assert.equal((await router.decide(event('小柯 /quiet'))).addressed, true);
});

test('duplicate gateway variants allow ignored-to-mentioned upgrade, then no second reply', async () => {
  const router = new GroupRouter({ now: () => now });
  const plain = event('你好');
  assert.equal((await router.decide(plain)).addressed, false);
  const mentioned = { ...plain, explicit_mention: true };
  const result = await Promise.all([router.decide(mentioned), router.decide(mentioned)]);
  assert.deepEqual(result.map(item => item.addressed), [true, false]);
  assert.equal((await router.decide({ ...mentioned, group_openid: 'another-group' })).addressed, true);
});

test('third-person name discussion receives context classification, and ignored duplicates are not reclassified', async () => {
  let calls = 0;
  const router = new GroupRouter({ now: () => now, classify: async () => { calls++; return false; } });
  assert.equal((await router.decide(event('我觉得小柯挺可爱'), [bot()])).addressed, false);
  assert.equal(calls, 1);
  const plain = event('这个天气真热');
  assert.equal((await router.decide(plain, [bot()])).addressed, false);
  assert.equal((await router.decide(plain, [bot()])).addressed, false);
  assert.equal(calls, 2);
  assert.equal((await router.decide({ ...plain, explicit_mention: true }, [bot()])).addressed, true);
});

test('members A and B can alternate without the last reply recipient excluding either member', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return !input.text.includes('吃饭'); } });
  const history = [bot({ reply_to: speaker('group-a', 'member-a') }),
    { role: 'user', speaker: speaker(), content: '我的问题还有一个部分', at: now }];
  assert.equal((await router.decide(event('我也想问这个游戏支不支持联机', { author: { member_openid: 'member-b' } }), history)).addressed, true);
  history.push(bot({ reply_to: speaker('group-a', 'member-b') }),
    { role: 'user', speaker: speaker('group-a', 'member-b'), content: '我有两个人', at: now });
  assert.equal((await router.decide(event('那我的问题也一起看看'), history)).addressed, true);
  assert.equal((await router.decide(event('阿明你吃饭了没', { author: { member_openid: 'member-b' } }), history)).addressed, false);
  assert.deepEqual(calls.map(call => call.speaker), [speaker('group-a', 'member-b'), speaker(), speaker('group-a', 'member-b')]);
});

test('another member can join before the first bot answer, using only whitelisted pending context', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return true; } });
  const pending = {
    pendingSpeakers: [speaker()],
    pendingMessages: [{ text: '柯霜，帮我们推荐两个人玩的游戏', speaker: speaker(), messageId: 'first', at: now, message_scene: { auth_token: 'must-not-forward' }, secret: 'must-not-forward' }]
  };
  const second = event('我们还希望能本地双人玩', { author: { member_openid: 'member-b' } });
  assert.equal((await router.decide(second, [], pending)).addressed, true);
  assert.equal(calls[0].speaker, speaker('group-a', 'member-b'));
  assert.deepEqual(calls[0].pendingSpeakers, [speaker()]);
  assert.deepEqual(calls[0].pendingMessages, [{ content: '柯霜，帮我们推荐两个人玩的游戏', speaker: speaker(), messageId: 'first', at: now }]);
  assert.doesNotMatch(JSON.stringify(calls[0]), /must-not-forward|auth_token/);
});

test('an addressed user topic or a recent accepted call opens semantic participation for every member', async () => {
  const calls = [];
  const router = new GroupRouter({ now: () => now, classify: input => { calls.push(input); return true; } });
  assert.equal((await router.decide(event('这个我也想听', { author: { member_openid: 'member-b' } }), [
    { role: 'user', speaker: speaker(), content: '聊聊最近的游戏吧', addressed: true, at: now - 5 * 60_000 }
  ])).addressed, true);
  await router.decide(event('柯霜，我先问一个问题', { group_openid: 'new-room' }));
  assert.equal((await router.decide(event('我也补充一点', { group_openid: 'new-room', author: { member_openid: 'member-b' } }))).addressed, true);
  assert.equal(calls.length, 2);
});

test('ambient production participation can assess a new topic after idle without extending a reply window or forcing a response', async () => {
  const router=new GroupRouter({now:()=>now,decideWithReply:true,ambientParticipation:true});
  const old=[bot({at:now-24*60*60_000})];
  for(const text of ['今天终于通关了！','这只猫的表情也太得意了','我先去拿快递']){
    assert.deepEqual(await router.decide(event(text),old),{addressed:true,reason:'ambient_candidate'});
  }
  assert.equal(router.groupActivity.size,0,'being assessed is not evidence of an active exchange');
  for(const text of ['/forget','/wake','/remember 他的信息'])assert.equal((await router.decide(event(text),old)).addressed,false);
  assert.equal((await router.decide(event('阿明来看看',{mentions_other_members:true}),old)).addressed,false);
  assert.equal((await router.decide(event('小柯，你看这个'),old)).reason,'called_by_name');
  assert.equal((await router.decide(event('我也觉得'),old)).reason,'contextual_candidate');
  assert.equal((await new GroupRouter({now:()=>now,ambientParticipation:true}).decide(event('我先去拿快递'),old)).addressed,false,
    'ambient permission requires the combined pass that can choose silence');
});
