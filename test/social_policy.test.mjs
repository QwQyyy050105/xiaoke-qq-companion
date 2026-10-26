import test from 'node:test';
import assert from 'node:assert/strict';
import { socialDecision, restoreSocialPlan, applySocialPlan, socialSnapshot, publicRoomMemory, publicMediaCatalog, proactiveMediaSelection, repeatsRecentReply, SOCIAL_NOTE_TTL } from '../src/social_policy.mjs';

const now = Date.parse('2026-10-22T20:00:00+08:00');

test('spontaneous image selection requires a classified sticker and cannot republish a question photo or avatar',()=>{
  const catalog=publicMediaCatalog([{id:'received_question',source:'received',label:'题图'},
    {id:'received_photo',source:'received',type:'photo'},
    {id:'approved_avatar',source:'approved',type:'avatar'},
    {id:'collected_sticker',source:'collected',type:'sticker'}]);
  for(const id of ['received_question','received_photo','approved_avatar'])
    assert.equal(proactiveMediaSelection({media:{send_id:id}},catalog).mediaId,'');
  assert.equal(proactiveMediaSelection({media:{send_id:'collected_sticker'}},catalog).mediaId,'collected_sticker');
});

test('social decisions keep only bounded intentions and cannot grant runtime permissions', () => {
  const decision = socialDecision({ social: { action: 'silent', next_wake_ms: 1, active_topic: '话'.repeat(400), pending_thought: '之后再问', clear_topic: true, quietUntil: 0, blocked: false, arbitrary: 'ignore' } });
  assert.equal(decision.action, 'silent');
  assert.equal(decision.nextWakeMs, 60_000);
  assert.equal(decision.activeTopic.length, 200);
  assert.equal('quietUntil' in decision, false);
  assert.equal('blocked' in decision, false);
  assert.equal(socialDecision({ social: { next_wake_ms: Number.MAX_VALUE } }).nextWakeMs, SOCIAL_NOTE_TTL);
  for (const value of [null, -1, '60000', NaN, Infinity]) assert.equal(socialDecision({ social: { next_wake_ms: value } }).nextWakeMs, null);
});

test('temporary plans expire, ignore forged future lifetimes, and never extend unchanged notes forever', () => {
  const room = restoreSocialPlan({}, now);
  const decision = socialDecision({ social: { action: 'silent', next_wake_ms: 60_000, active_topic: '想聊双人游戏', pending_thought: '问合作还是竞争' } });
  applySocialPlan(room, decision, now, 30 * 60_000, { silent: true });
  const expiry = room.activeTopic.expiresAt;
  applySocialPlan(room, decision, now + 60_000, 30 * 60_000, { silent: true });
  assert.equal(room.activeTopic.expiresAt, expiry);
  assert.equal(room.nextAt, now + 180_000);
  assert.equal(restoreSocialPlan(room, now + SOCIAL_NOTE_TTL + 1).activeTopic, null);
  assert.equal(restoreSocialPlan({ activeTopic: { text: '永远', createdAt: now, expiresAt: now + SOCIAL_NOTE_TTL + 1 } }, now).activeTopic, null);
});

test('repeat detection is time bounded and distinguishes substantially new content', () => {
  const text = '突然想到你们上次说的那个双人合作游戏，后来通关了吗';
  const room = { recentSent: [{ text, at: now - 60_000 }] };
  assert.equal(repeatsRecentReply(text + '？', room, [], now), true);
  assert.equal(repeatsRecentReply('突然想到你们上次说的那个双人合作游戏，后来通关了嘛', room, [], now), true);
  assert.equal(repeatsRecentReply('这次想聊的是做饭，最近谁试过自己烤面包', room, [], now), false);
  assert.equal(repeatsRecentReply(text, room, [], now + SOCIAL_NOTE_TTL), false);
  assert.equal(repeatsRecentReply('早上好', { recentSent: [] }, [{ role: 'assistant', content: '早上好！', at: new Date(now).toISOString() }], now), true);
});

test('public memory and participation snapshots preserve context without importing credentials or private fields', () => {
  const memory = publicRoomMemory([{ kind: 'slang', text: '开黑=联机', source: '我们把联机叫开黑', speaker: 'member_x', id: 'note', at: now, token: 'private-token', privateHistory: ['do-not-copy'] }, '群里欢迎新游戏话题']);
  assert.deepEqual(memory[0], { kind: 'slang', text: '开黑=联机', source: '我们把联机叫开黑', speaker: 'member_x', id: 'note', at: now });
  assert.doesNotMatch(JSON.stringify(memory), /private-token|privateHistory/);
  const state = socialSnapshot({ lastInteractionAt: now - 1000, lastSentAt: 0, activeTopic: { text: '想法', expiresAt: now + 5000 } }, now, [
    { role: 'user', speaker: 'a', at: now - 1000 }, { role: 'user', speaker: 'b', at: now - 2000 }, { role: 'assistant', at: now - 500 }
  ]);
  assert.deepEqual(state.recentParticipation, { userMessages: 2, speakers: 2, assistantMessages: 1 });
  assert.match(state.intentNotice, /不能当作群友/);
});

test('proactive sticker choices retain learned meaning and successful-use recency without leaking transport data', () => {
  const items=publicMediaCatalog([
    {id:'collected_a',group_openid:'room-a',type:'sticker',label:'收藏的表情',local_note:'摇头的小猫',usage_hint:'轻轻表示不同意',
      tags:['摇头'],use_count:3,recently_used:true,format_note:'只看过三张采样帧',url:'https://private-cdn.invalid/image',path:'private-file',scopeHash:'private-scope'},
    {id:'collected_b',group_openid:'room-b',type:'sticker',local_note:'another room'}
  ],{groupOpenid:'room-a'});
  assert.equal(items.length,1);
  assert.equal(items[0].local_note,'摇头的小猫');
  assert.equal(items[0].usage_hint,'轻轻表示不同意');
  assert.equal(items[0].use_count,3);assert.equal(items[0].recently_used,true);
  assert.equal(items[0].format_note,'只看过三张采样帧');
  assert.doesNotMatch(JSON.stringify(items),/private-cdn|private-file|private-scope|another room/);
});
