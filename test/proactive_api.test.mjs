import test from 'node:test';
import assert from 'node:assert/strict';
import { QQClient } from '../src/qq.mjs';

test('proactive group messages never reuse a passive message or event id', async () => {
  const calls = [];
  const client = new QQClient('1', 'dummy', { fetcher: async (url, request) => {
    calls.push({ url, request });
    return { ok: true, status: 200, json: async () => url.endsWith('getAppAccessToken')
      ? { access_token: 'test-token', expires_in: 7200 } : { id: 'sent' } };
  } });
  await client.proactive('group/a', ' 想整点有意思的。 ');
  assert.equal(calls[1].url, 'https://api.bot.qq.com/v2/groups/group%2Fa/messages');
  assert.deepEqual(JSON.parse(calls[1].request.body), { content: '想整点有意思的。', msg_type: 0 });
});

test('proactive permission errors preserve QQ business code even when HTTP succeeds', async () => {
  for (const status of [200, 403]) {
    const client = new QQClient('1', 'dummy', { fetcher: async url => ({
      ok: url.endsWith('getAppAccessToken') || status === 200,
      status: url.endsWith('getAppAccessToken') ? 200 : status,
      json: async () => url.endsWith('getAppAccessToken')
        ? { access_token: 'test-token', expires_in: 7200 }
        : { code: 40034105, message: 'no proactive permission' }
    }) });
    await assert.rejects(client.proactive('group-1', '你好。'), error => {
      assert.equal(error.code, 40034105);
      assert.equal(error.status, status);
      assert.equal(error.message, 'qq_api_error_40034105');
      return true;
    });
  }
});
