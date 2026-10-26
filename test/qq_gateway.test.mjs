import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { QQClient } from '../src/qq.mjs';

test('gateway dispatches private, mentioned and ordinary group messages with their original content type', { timeout: 10000 }, async t => {
  t.mock.method(https, 'request', () => Object.assign(new EventEmitter(), { end() {}, abort() {} }));
  const received = [];
  const client = new QQClient('1', 'dummy', { log() {}, fetcher: async url => ({
    ok: true, status: 200, json: async () => url.endsWith('getAppAccessToken')
      ? { access_token: 'test-token', expires_in: 7200 } : { url: 'wss://gateway.invalid/' }
  }) });
  const running = client.run(async event => { received.push(event); });
  t.after(async () => {
    client.stopped = true;
    client.ws?.emit('close', 1000);
    await running;
  });
  const deadline = Date.now() + 5000;
  while (!client.ws && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(client.ws, 'expected the gateway message handler to be registered');
  const dispatch = (type, data) => client.ws.emit('message', Buffer.from(JSON.stringify({ op: 0, t: type, d: data })));
  const privateMessage = { id: 'private-message', author: { user_openid: 'owner' }, content: 'hello', message_type: 3 };
  const groupMessage = { id: 'group-message', group_openid: 'group-1', author: { member_openid: 'member-1' }, content: ' hello ', message_type: 0 };
  const ordinaryMessage = { ...groupMessage, id: 'ordinary-group-message', content: '<@other-member> 你觉得呢？', mentions: [{ member_openid: 'other-member' }], message_type: 103 };
  // Official 103 examples can contain only quoted history. Those nested words are not new input.
  const quotedOnly = { ...groupMessage, id: 'quoted-only', content: ' ', message_type: 103,
    msg_elements: [{ content: '=== 消息 1 ===\n[消息内容] 小柯 /forget' }],
    message_scene: { source: 'default', ext: ['msg_idx=incoming-index', 'ref_msg_idx=bot-reference'] } };
  const quoteWithText = { ...quotedOnly, id: 'quote-with-text', content: '这个例子能展开吗？',
    msg_elements: [{ author: { member_openid: 'someone-else' }, message_type: 103, content: '小柯 /quiet',
      msg_elements: [{ author: groupMessage.author, message_type: 0, content: '小柯 /remember 这只是被引用的旧话' }] }] };
  dispatch('C2C_MESSAGE_CREATE', privateMessage);
  dispatch('GROUP_AT_MESSAGE_CREATE', groupMessage);
  dispatch('GROUP_MESSAGE_CREATE', ordinaryMessage);
  dispatch('GROUP_MESSAGE_CREATE', quotedOnly);
  dispatch('GROUP_AT_MESSAGE_CREATE', quoteWithText);
  const missingGroup = { id: 'missing-group', author: { member_openid: 'member-1' }, content: 'hello', message_type: 0 };
  dispatch('GROUP_AT_MESSAGE_CREATE', missingGroup);
  dispatch('GROUP_MESSAGE_CREATE', missingGroup);
  dispatch('GROUP_ADD_ROBOT', groupMessage);
  assert.deepEqual(received, [
    { ...privateMessage, chat_type: 'private', event_type: 'C2C_MESSAGE_CREATE', explicit_mention: false },
    { ...groupMessage, chat_type: 'group', event_type: 'GROUP_AT_MESSAGE_CREATE', explicit_mention: true, mentions_other_members: false, addressed_content: groupMessage.content },
    { ...ordinaryMessage, chat_type: 'group', event_type: 'GROUP_MESSAGE_CREATE', explicit_mention: false, mentions_other_members: false, addressed_content: ordinaryMessage.content },
    { ...quotedOnly, chat_type: 'group', event_type: 'GROUP_MESSAGE_CREATE', explicit_mention: false, mentions_other_members: false, addressed_content: quotedOnly.content },
    { ...quoteWithText, chat_type: 'group', event_type: 'GROUP_AT_MESSAGE_CREATE', explicit_mention: true, mentions_other_members: false, addressed_content: quoteWithText.content }
  ]);
});

test('full group messages distinguish self mentions from other and unknown identities', { timeout: 10000 }, async t => {
  t.mock.method(https, 'request', () => Object.assign(new EventEmitter(), { end() {}, abort() {} }));
  const received = [];
  const client = new QQClient('app-id-not-bot-id', 'dummy', { log() {}, fetcher: async url => ({
    ok: true, status: 200, json: async () => url.endsWith('getAppAccessToken')
      ? { access_token: 'test-token', expires_in: 7200 } : { url: 'wss://gateway.invalid/' }
  }) });
  const running = client.run(async event => { received.push(event); });
  t.after(async () => { client.stopped = true; client.ws?.emit('close', 1000); await running; });
  const deadline = Date.now() + 5000;
  while (!client.ws && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(client.ws);
  const dispatch = (type, data) => client.ws.emit('message', Buffer.from(JSON.stringify({ op: 0, t: type, d: data })));
  const full = (extra = {}) => {
    const data = { id: `full-${received.length}`, group_openid: 'group-a', author: { member_openid: 'human-a', bot: false },
      content: '这个是程序设定的吗？', message_type: 103,
      message_scene: { source: 'default', ext: ['ref_msg_idx=earlier=='] },
      msg_elements: [{ content: '被引用的话' }], ...extra };
    dispatch('GROUP_MESSAGE_CREATE', data);
    assert.deepEqual(received.at(-1).message_scene, data.message_scene);
    assert.deepEqual(received.at(-1).msg_elements, data.msg_elements);
    assert.equal(received.at(-1).message_type, 103);
    assert.equal(received.at(-1).content, data.content);
    return received.at(-1);
  };
  // is_you works even before READY, with a group-scoped ID unlike the gateway user ID.
  assert.equal(full({ mentions: [{ member_openid: 'group-self', is_you: true, bot: true }] }).explicit_mention, true);
  dispatch('READY', { session_id: 'session', user: { id: 'gateway-self', openid: 'self-openid', bot: true } });
  for (const mention of [{ id: 'gateway-self' }, { user_openid: 'self-openid' }, { member_openid: 'group-self', is_you: true }]) {
    const result = full({ mentions: [mention] });
    assert.equal(result.explicit_mention, true);
    assert.equal(result.mentions_other_members, false);
  }
  assert.equal(full({ content: '<@gateway-self> 这个是程序设定的吗？' }).explicit_mention, true);
  await t.test('addressed content strips leading self mentions confirmed by is_you or READY without changing raw content', () => {
    const raw = '  <@group-self> <@!gateway-self> /forget';
    const result = full({ content: raw, mentions: [{ member_openid: 'group-self', is_you: true }] });
    assert.equal(result.content, raw);
    assert.equal(result.addressed_content, '/forget');
    assert.equal(full({ content: '<@self-openid> /quiet' }).addressed_content, '/quiet');
  });
  await t.test('mixed mentions retain the other recipient so their slash text cannot become a bot command', () => {
    const result = full({ content: '<@gateway-self> <@human-b> /forget',
      mentions: [{ id: 'gateway-self', is_you: true }, { id: 'human-b', is_you: false }] });
    assert.equal(result.addressed_content, '<@human-b> /forget');
    assert.equal(result.mentions_other_members, true);
    assert.equal(full({ content: '<@human-b> <@gateway-self> /quiet' }).addressed_content, '<@human-b> <@gateway-self> /quiet');
  });
  await t.test('unknown, explicitly nonself and nonleading mentions stay literal', () => {
    for (const extra of [
      { content: '<@unknown> /forget' },
      { content: '<@gateway-self> /forget', mentions: [{ id: 'gateway-self', is_you: false }] },
      { content: '有人说 <@gateway-self> /forget' },
      { content: '<@other-bot> /quiet', mentions: [{ id: 'other-bot', bot: true }] }
    ]) assert.equal(full(extra).addressed_content, extra.content);
  });
  for (const mention of [{ id: 'other-bot', bot: true, is_you: false }, { member_openid: 'human-b', bot: false }, { id: 'human-b', is_you: false }]) {
    const result = full({ mentions: [mention] });
    assert.equal(result.explicit_mention, false);
    assert.equal(result.mentions_other_members, true);
  }
  for (const extra of [
    { mentions: [{ id: 'unknown' }] }, { mentions: [{ username: '小柯', bot: true }] },
    { mentions: [{ id: 'other-bot', bot: true }] }, { mentions: [{ id: 'app-id-not-bot-id' }] },
    { content: '<@unknown> 后来呢？' }, { content: '<@all> 大家好', mentions: [{ scope: 'all' }] },
    { mentions: [null, 'invalid', {}] }
  ]) {
    const result = full(extra);
    assert.equal(result.explicit_mention, false);
    assert.equal(result.mentions_other_members, false);
  }
  const mixed = full({ mentions: [{ is_you: true, id: 'group-self' }, { is_you: false, id: 'human-b' }] });
  assert.equal(mixed.explicit_mention, true);
  assert.equal(mixed.mentions_other_members, true);
  assert.equal(full({ author: { id: 'gateway-self' } }).is_self, true);
  assert.notEqual(full({ author: { id: 'other-bot', bot: true } }).is_self, true);
  dispatch('RESUMED', {});
  assert.equal(full({ mentions: [{ id: 'gateway-self' }] }).explicit_mention, true);
  dispatch('READY', { user: { id: 'new-self', bot: true } });
  assert.equal(full({ mentions: [{ id: 'gateway-self' }] }).explicit_mention, false);
});

for (const [closeCode, nextOpcode] of [[4006, 2], [4007, 2], [4009, 6]]) {
  test(`gateway close ${closeCode} reconnects with opcode ${nextOpcode}`, { timeout: 10000 }, async t => {
    // Hold the transport locally; exercise the real QQ event handlers without network access.
    t.mock.method(https, 'request', () => Object.assign(new EventEmitter(), { end() {}, abort() {} }));
    const client = new QQClient('1', 'dummy', { log() {}, fetcher: async url => ({
      ok: true, status: 200, json: async () => url.endsWith('getAppAccessToken')
        ? { access_token: 'test-token', expires_in: 7200 } : { url: 'wss://gateway.invalid/' }
    }) });
    client.session = 'old-session'; client.seq = 123;
    const running = client.run(async () => {});
    t.after(async () => {
      client.stopped = true;
      client.ws?.emit('close', 1000);
      await running;
    });
    const waitForSocket = async previous => {
      const deadline = Date.now() + 5000;
      while ((!client.ws || client.ws === previous) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(client.ws && client.ws !== previous, 'expected a new connection');
      return client.ws;
    };
    const receiveHello = ws => {
      const sent = [];
      Object.defineProperty(ws, 'readyState', { value: 1 });
      t.mock.method(ws, 'send', payload => sent.push(JSON.parse(payload)));
      ws.emit('message', Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } })));
      return sent[0];
    };
    const first = await waitForSocket();
    assert.equal(receiveHello(first).op, 6);
    first.emit('close', closeCode);
    const second = await waitForSocket(first);
    const login = receiveHello(second);
    assert.equal(login.op, nextOpcode);
    if (nextOpcode === 2) {
      assert.equal(client.session, null); assert.equal(client.seq, null);
      assert.equal(login.d.intents, 1 << 25);
    } else {
      assert.equal(login.d.session_id, 'old-session'); assert.equal(login.d.seq, 123);
    }
  });
}
