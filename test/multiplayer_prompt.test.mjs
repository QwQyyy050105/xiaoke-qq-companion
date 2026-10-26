import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationPrompt } from '../src/model_client.mjs';

const dataFor = input => {
  const prompt = conversationPrompt('小柯在群里和大家聊天。', input, new Date('2026-10-22T12:00:00Z'));
  return { prompt, data: JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) };
};

test('changing wall-clock time leaves the common prompt prefix stable without deleting current time', () => {
  const input={text:'小柯，晚上好',history:[],memory:[]};
  const first=conversationPrompt('小柯',input,new Date('2026-10-22T12:00:00Z'));
  const next=conversationPrompt('小柯',input,new Date('2026-10-22T12:01:00Z'));
  assert.equal(first.slice(0,first.lastIndexOf('\n')),next.slice(0,next.lastIndexOf('\n')));
  assert.notEqual(JSON.parse(first.slice(first.lastIndexOf('\n')+1)).local_time,JSON.parse(next.slice(next.lastIndexOf('\n')+1)).local_time);
});

test('a multiplayer prompt preserves both speakers and their own memories without private history duplication', () => {
  const turnMessages = [
    { speaker: 'member_alice', content: '以后叫我阿白。刚才那个笑话继续讲呀。', messageId: 'a1' },
    { speaker: 'member_bob', content: '我叫阿蓝。我是特地没叫你全名。', messageId: 'b1' }
  ];
  const participants = [
    { speaker: 'member_alice', memory: ['我喜欢猫'] },
    { speaker: 'member_bob', memory: ['我喜欢画画'] }
  ];
  const roomHistory = [{ role: 'assistant', speaker: 'xiao_ke', content: '叫全名像在训龙。', messageId: 'bot1' }];
  const { prompt, data } = dataFor({
    speaker: 'member_bob', text: turnMessages[1].content, turnMessages, participants, roomHistory,
    history: [{ role: 'user', content: 'PERSONAL_HISTORY_MUST_NOT_APPEAR' }], memory: [], structured: true
  });
  assert.deepEqual(data.group_turn, turnMessages);
  assert.deepEqual(data.participants, participants);
  assert.deepEqual(data.room_messages, roomHistory);
  assert.deepEqual(data.recent_messages, []);
  assert.doesNotMatch(prompt, /PERSONAL_HISTORY_MUST_NOT_APPEAR/);
  assert.equal(data.group_turn[0].speaker, 'member_alice');
  assert.equal(data.group_turn[1].speaker, 'member_bob');
  assert.equal(data.participants[0].memory.includes('我喜欢画画'), false);
});

test('reply prompts ground media and action limits in the installed companion rather than blaming QQ', () => {
  const { data } = dataFor({ speaker: 'member_alice', text: '那你发个表情包呀', memory: [], history: [] });
  assert.match(data.capabilities.media, /图片传输实现可处理PNG\/JPEG/);
  assert.match(data.capabilities.media, /没有图像输入就不能声称看清/);
  assert.match(data.capabilities.media, /不能猜测QQ本身不支持/);
  assert.match(data.capabilities.actions, /不知道故障原因时不自行诊断/);
  assert.deepEqual(data.group_turn, [{ speaker: 'member_alice', content: '那你发个表情包呀' }]);
});

test('image prompt identifies only actually attached images without exposing filesystem paths', () => {
  const {prompt,data} = dataFor({speaker:'member_a',text:'看这张图',
    mediaCatalog:[{id:'seen_1',label:'收到的图'},{id:'saved_2',label:'收藏的图'}],
    visionFiles:[{id:'seen_1',path:'D:\\private\\file.jpg'}]});
  assert.deepEqual(data.image_inputs,[{id:'seen_1'}]);
  assert.equal(data.media_catalog.length,2);
  assert.doesNotMatch(prompt,/private|file\.jpg/);
});

test('routing prompts preserve pending participants and proactive prompts discard private participant data', () => {
  const pendingMessages = [
    { speaker: 'member_alice', content: '这个是程序设定的吗？', messageId: 'a2' },
    { speaker: 'member_bob', content: '我也想听你说', messageId: 'b2' }
  ];
  const { data: routing } = dataFor({ mode: 'routing', text: '接着说呀', speaker: 'member_bob',
    pendingMessages, pendingSpeakers: ['member_alice', 'member_bob'] });
  assert.deepEqual(routing.pending_messages, pendingMessages);
  assert.deepEqual(routing.pending_speakers, ['member_alice', 'member_bob']);
  const { prompt: proactive, data } = dataFor({ mode: 'proactive', text: '开个话题',
    memory: ['PRIVATE_MEMORY'], history: [{ role: 'user', content: 'PRIVATE_HISTORY' }],
    participants: [{ speaker: 'member_alice', memory: ['PRIVATE_PARTICIPANT_MEMORY'] }],
    turnMessages: [{ speaker: 'member_bob', content: 'PRIVATE_TURN' }],
    roomHistory: [{ role: 'user', speaker: 'member_alice', content: '我们刚才聊猫' }] });
  assert.doesNotMatch(proactive, /PRIVATE_MEMORY|PRIVATE_HISTORY|PRIVATE_PARTICIPANT_MEMORY|PRIVATE_TURN/);
  assert.equal(data.room_messages[0].content, '我们刚才聊猫');
});
