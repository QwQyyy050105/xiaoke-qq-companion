import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Companion, hash } from '../src/core.mjs';
import { GroupRouter } from '../src/routing.mjs';
import { ProactiveCompanion } from '../src/proactive.mjs';
import { GroupInbox, OrderedGroupDispatch } from '../src/inbox.mjs';
import { conversationPrompt } from '../src/model_client.mjs';

const group = (id, content, member = 'alice', groupId = 'group-a', extra = {}) => ({
  id, content, group_openid: groupId, author: { member_openid: member }, chat_type: 'group', explicit_mention: false, ...extra
});

async function fixture(t, generate = async () => ({ reply: '猫像面包这个比喻还真挺贴切。', memories: [] })) {
  const tempRoot = resolve(process.cwd(), 'temp');
  const dir = await mkdtemp(join(tempRoot, 'chat_integration_'));
  let now = Date.parse('2026-10-22T10:00:00+08:00');
  let companion, router, social, deliverySequence = 0;
  const inputs = [], sent = [], proactiveInputs = [];
  const send = async (event, content, kind = 'reply') => {
    const id = `real-bot-message-${++deliverySequence}`;
    sent.push({ id, kind, groupOpenid: event.group_openid, incomingId: event.id, content });
    return { id };
  };
  const restart = async () => {
    social?.stop();
    companion = await new Companion({ dataDir: dir, pairingHash: hash('test-code'), now: () => now, generate: async input => {
      inputs.push(structuredClone(input)); return generate(input);
    } }).init();
    router = new GroupRouter({ now: () => now });
    social = await new ProactiveCompanion({
      dataDir: dir, now: () => now, random: () => 0, isBusy: () => companion.pending > 0,
      getRoomHistory: id => companion.groupContext(id),
      generate: async input => { proactiveInputs.push(structuredClone(input)); return '刚才那个面包猫，现在想想还是很好笑。'; },
      send: async (groupOpenid, text) => {
        const delivery = await send({ group_openid: groupOpenid }, text, 'proactive');
        await companion.recordGroupAssistant(groupOpenid, text, { messageId: delivery.id });
      }
    }).init();
  };
  await restart();
  t.after(async () => {
    social.stop();
    await companion.persistence; await social.writeQueue;
    const target = resolve(dir);
    assert.ok(target.startsWith(tempRoot + sep));
    await rm(target, { recursive: true, force: true });
    await assert.rejects(access(target), error => error.code === 'ENOENT');
  });
  const processAddressed = async event => {
    const control = await social.observe(event, { addressed: true });
    if (control.handled) {
      if (control.reply) {
        const delivery = await send(event, control.reply);
        await companion.recordGroupAssistant(event.group_openid, control.reply, { messageId: delivery.id, originId: event.id });
      }
      return { status: 'controlled' };
    }
    const result = await companion.handle(event, content => send(event, content));
    if (result?.status === 'replied') await social.markReplied(event.group_openid);
    return result;
  };
  const receive = async event => {
    const decision = await router.decide(event, companion.groupContext(event.group_openid));
    if (['invalid_group_event', 'bot_or_self'].includes(decision.reason)) return { status: 'ignored', decision };
    await companion.observeGroup(event);
    await social.observe(event, { addressed: false });
    return decision.addressed ? { ...await processAddressed(event), decision } : { status: 'ignored', decision };
  };
  return { dir, inputs, sent, proactiveInputs, restart, receive, processAddressed,
    advance: ms => { now += ms; }, get companion() { return companion; }, get router() { return router; }, get social() { return social; } };
}

test('ordinary unrelated messages are observed without replying; a name call sees the whole public room', async t => {
  const f = await fixture(t);
  assert.equal((await f.receive(group('ordinary-a', '这只猫长得像面包', 'bob'))).status, 'ignored');
  assert.equal((await f.receive(group('ordinary-b', '尤其那个耳朵', 'carol'))).status, 'ignored');
  await f.receive(group('other-room', 'OTHER_ROOM_SENTINEL', 'bob', 'group-b'));
  assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.companion.groupContext('group-a').length, 2);
  const result = await f.receive(group('name-call', '小柯，你怎么看'));
  assert.equal(result.decision.reason, 'called_by_name');
  assert.equal(result.status, 'replied');
  assert.deepEqual(f.inputs[0].roomHistory.map(item => item.content), ['这只猫长得像面包', '尤其那个耳朵']);
  assert.equal(new Set(f.inputs[0].roomHistory.map(item => item.speaker)).size, 2);
  assert.doesNotMatch(JSON.stringify(f.inputs[0]), /OTHER_ROOM_SENTINEL/);
  const prompt = conversationPrompt('角色说明', f.inputs[0]);
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  assert.deepEqual(data.room_messages, f.inputs[0].roomHistory);
  assert.equal(data.speaker, f.inputs[0].speaker);
  assert.equal(data.user_message, '小柯，你怎么看');
});

test('the same member can continue a recent bot conversation without another mention', async t => {
  const f = await fixture(t);
  await f.receive(group('start', '小柯，你觉得猫为什么喜欢纸箱'));
  f.advance(1000);
  const reply = await f.receive(group('followup', '你刚才说的那个例子，再展开一点'));
  assert.equal(reply.decision.reason, 'clear_continuation');
  assert.equal(reply.status, 'replied');
  assert.equal(f.sent.length, 2);
  assert.ok(f.inputs[1].roomHistory.some(item => item.role === 'assistant' && item.messageId === f.sent[0].id));
  const ignored = await f.receive(group('unrelated', '我去拿个快递'));
  assert.equal(ignored.status, 'ignored');
  assert.equal(f.sent.length, 2);
});

test('mixed ambient and addressed tasks keep their own attention evidence through the inbox and model input',async t=>{
 const f=await fixture(t);
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const inbox=new GroupInbox({batchParticipants:true,delayMs:350,gapMs:0,now:()=>0,sleep:()=>gate,handle:event=>f.processAddressed(event)});
 const first=inbox.enqueue(group('other-task','小鲸鱼算36乘7','alice','group-a',{allow_silence:true}));
 const second=inbox.enqueue(group('own-task','小柯算19乘23','alice','group-a',{allow_silence:false}));
 release();await Promise.all([first,second]);
 assert.equal(f.inputs.length,1);
 const turn=f.inputs[0].turnMessages;
 assert.equal(turn[0].attention,'ambient');assert.equal(turn[1].attention,'addressed');
 assert.equal(turn[0].content,'小鲸鱼算36乘7');assert.equal(turn[1].content,'小柯算19乘23');
 const data=JSON.parse(conversationPrompt('角色说明',f.inputs[0]).split('\n').at(-1));
 assert.deepEqual(data.group_turn,turn);
});

test('reply references recognize an actual QQ bot ID and do not mistake the originating user ID for one', async t => {
  const f = await fixture(t);
  await f.receive(group('user-start', '小柯，聊聊这个配色'));
  const botId = f.sent[0].id;
  const referenced = await f.receive(group('quote-bot', '这个配色挺特别', 'bob', 'group-a', { message_reference: { message_id: botId } }));
  assert.equal(referenced.decision.reason, 'references_bot_reply');
  assert.equal(referenced.status, 'replied');
  const wrongReference = await f.receive(group('quote-user', '这个配色挺特别', 'carol', 'group-a', { message_reference: { message_id: 'user-start' } }));
  assert.equal(wrongReference.status, 'ignored');
  assert.equal(f.sent.length, 2);
});

test('a nickname learned from a name call survives restart and remains that member memory', async t => {
  const f = await fixture(t, async input => ({ reply: input.text.includes('以后叫我') ? '好，阿白。' : '阿白，我接着呢。', memories: input.text.includes('以后叫我')
    ? [{ text: '以后叫我阿白。', source: '以后叫我阿白。' }] : [] }));
  await f.receive(group('nickname', '小柯，以后叫我阿白。'));
  await f.restart();
  await f.receive(group('after-restart', '小柯，还记得怎么叫我吗'));
  assert.deepEqual(f.inputs.at(-1).memory, ['以后叫我阿白。']);
  await f.receive(group('other-member', '小柯，你认识我吗', 'bob'));
  assert.deepEqual(f.inputs.at(-1).memory, []);
  assert.equal(f.inputs.at(-1).roomHistory.some(item => item.content === '小柯，以后叫我阿白。'), true, 'the nickname statement was public, but must not become Bob\'s personal memory');
});

test('proactive generation receives the canonical cross-member public history and records only its successful reply', async t => {
  const f = await fixture(t);
  await f.receive(group('ordinary', '这只猫长得像面包', 'bob'));
  await f.receive(group('called', '小柯，你怎么看'));
  f.advance(31 * 60_000);
  assert.equal(await f.social.tick(), true);
  assert.equal(f.proactiveInputs.length, 1);
  assert.deepEqual(f.proactiveInputs[0].memory, []);
  assert.deepEqual(f.proactiveInputs[0].history, []);
  assert.ok(f.proactiveInputs[0].roomHistory.some(item => item.role === 'user' && item.content === '这只猫长得像面包'));
  assert.ok(f.proactiveInputs[0].roomHistory.some(item => item.role === 'assistant'));
  const proactiveReply = f.sent.at(-1);
  assert.equal(proactiveReply.kind, 'proactive');
  assert.equal(f.companion.groupContext('group-a').at(-1).messageId, proactiveReply.id);
});

test('pre-observed consecutive bubbles merge into one reply without duplicating their source text in the model context', async t => {
  const f = await fixture(t);
  const one = group('bubble-1', '小柯，我在想一个问题');
  const two = group('bubble-2', '猫会不会觉得人很吵');
  await f.companion.observeGroup(one); await f.companion.observeGroup(two);
  const inbox = new GroupInbox({ handle: f.processAddressed, delayMs: 0, gapMs: 0, sleep: async () => { await new Promise(resolve => setImmediate(resolve)); } });
  await Promise.all([inbox.enqueue(one), inbox.enqueue(two)]);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].text, '小柯，我在想一个问题\n猫会不会觉得人很吵');
  assert.deepEqual(f.inputs[0].roomHistory, []);
  assert.equal(f.sent.length, 1);
});

test('a concurrent A request and B addition reach one group turn without assigning both to the last speaker', async t => {
  const f = await fixture(t);
  const a = group('a-ask', '小柯，讲个笑话', 'alice');
  const b = group('b-add', '要和猫有关', 'bob');
  await f.companion.observeGroup(a); await f.companion.observeGroup(b);
  const inbox = new GroupInbox({ handle: f.processAddressed, batchParticipants: true, delayMs: 1000, gapMs: 0,
    sleep: async () => { await new Promise(resolve => setImmediate(resolve)); } });
  await Promise.all([inbox.enqueue(a), inbox.enqueue(b)]);
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.inputs[0].turnMessages.map(message => message.content), ['小柯，讲个笑话', '要和猫有关']);
  assert.equal(new Set(f.inputs[0].turnMessages.map(message => message.speaker)).size, 2);
  assert.equal(f.inputs[0].participants.length, 2);
  assert.equal(f.sent[0].incomingId, 'b-add');
  assert.equal(f.companion.groupContext('group-a').at(-1).reply_to_speakers.length, 2);
});

test('a fast forget decision cannot run before an earlier slow-classified preference and resurrect cleared memory', async t => {
  let releaseReply, startedReply, decidePreference;
  const replyGate = new Promise(resolve => { releaseReply = resolve; });
  const replyStarted = new Promise(resolve => { startedReply = resolve; });
  const slowDecision = new Promise(resolve => { decidePreference = resolve; });
  const f = await fixture(t, async () => {
    startedReply(); await replyGate;
    return { reply: '记住你喜欢猫啦。', memories: [{ text: '我喜欢猫。', source: '我喜欢猫。' }] };
  });
  const preference = group('preference-first', '我喜欢猫。');
  const forget = group('forget-second', '/forget', 'alice', 'group-a', { explicit_mention: true });
  await f.companion.observeGroup(preference); await f.companion.observeGroup(forget);
  const inbox = new GroupInbox({ handle: f.processAddressed, batchParticipants: true, delayMs: 0, gapMs: 0,
    sleep: async () => { await new Promise(resolve => setImmediate(resolve)); } });
  const ordered = new OrderedGroupDispatch(), replies = [];
  const enqueue = event => { replies.push(inbox.enqueue(event)); };
  const firstDispatch = ordered.dispatch('group-a', slowDecision, decision => { if (decision.addressed) enqueue(preference); });
  const secondDispatch = ordered.dispatch('group-a', Promise.resolve({ addressed: true }), decision => { if (decision.addressed) enqueue(forget); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inbox.pending, 0);
  decidePreference({ addressed: true });
  try {
    await Promise.all([firstDispatch, secondDispatch]);
    await replyStarted;
    assert.equal(inbox.pending, 2, 'dispatch enqueues the later command without waiting for the earlier QQ answer');
    assert.equal(f.sent.length, 0);
  } finally { releaseReply(); await Promise.all(replies); }
  assert.deepEqual(f.sent.map(reply => reply.incomingId), ['preference-first', 'forget-second']);
  const memberKey = hash(JSON.stringify(['group-a', 'alice']));
  assert.deepEqual(f.companion.state.groups[memberKey].memory, []);
  assert.deepEqual(f.companion.state.groups[memberKey].history, []);
  assert.deepEqual(f.companion.groupContext('group-a'), []);
  await f.restart();
  assert.deepEqual(f.companion.state.groups[memberKey].memory, []);
  assert.deepEqual(f.companion.groupContext('group-a'), []);
});
