import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Companion, hash, splitReply } from '../src/core.mjs';
import { QQClient } from '../src/qq.mjs';
import { codexArgs } from '../src/model_client.mjs';

async function fixture(t, generate = async () => '你好呀。') {
  const dir = await mkdtemp(join(process.cwd(), 'temp', 'test_'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Companion({ dataDir: dir, pairingHash: hash('test-code'), generate }).init();
}
const event = (id, content, owner = 'owner') => ({ id, content, author: { user_openid: owner } });
const pair = bot => bot.handle(event('pair', '/pair test-code'), async () => {});

test('requires correct pairing code and isolates the owner', async t => {
  let calls = 0; const bot = await fixture(t, async () => { calls++; return 'reply'; });
  await bot.handle(event('bad', '/pair invalid', 'stranger'), async text => assert.match(text, /没有匹配/));
  assert.equal(bot.state.owner, null);
  await pair(bot);
  await bot.handle(event('foreign', 'read memory', 'stranger'), async () => assert.fail());
  assert.equal(calls, 0); assert.equal(bot.state.owner, 'owner');
});
test('duplicate QQ events invoke the model once', async t => {
  let calls = 0; const bot = await fixture(t, async () => { calls++; return 'reply'; }); await pair(bot);
  await Promise.all([bot.handle(event('one', 'hi'), async () => {}), bot.handle(event('one', 'hi'), async () => {})]);
  assert.equal(calls, 1); assert.equal(bot.state.history.length, 2);
});
test('serializes messages and persists context across restarts', async t => {
  const sizes = []; const bot = await fixture(t, async ({ history }) => { sizes.push(history.length); return 'reply'; }); await pair(bot);
  await Promise.all([bot.handle(event('one', 'first'), async () => {}), bot.handle(event('two', 'second'), async () => {})]);
  assert.deepEqual(sizes, [0, 2]);
  const restored = await new Companion({ dataDir: bot.dataDir, pairingHash: hash('test-code'), generate: async () => '' }).init();
  assert.equal(restored.state.history.length, 4); assert.equal(restored.state.owner, 'owner');
});
test('reset keeps explicit memory; forget removes history and memory', async t => {
  const bot = await fixture(t); await pair(bot);
  await bot.handle(event('r', '/remember 喜欢猫'), async () => {});
  await bot.handle(event('h', 'hi'), async () => {});
  await bot.handle(event('reset', '/reset'), async () => {});
  assert.equal(bot.state.history.length, 0); assert.deepEqual(bot.state.memory, ['喜欢猫']);
  await bot.handle(event('forget', '/forget'), async () => {});
  assert.deepEqual(bot.state.memory, []); assert.deepEqual(bot.state.history, []);
});
test('failed generation does not add fabricated chat history', async t => {
  const bot = await fixture(t, async () => { throw new Error('offline'); }); await pair(bot);
  await assert.rejects(bot.handle(event('one', 'hi'), async () => {}), /offline/);
  assert.deepEqual(bot.state.history, []);
});
test('failed delivery is not committed as an answered conversation and can retry', async t => {
  const bot = await fixture(t); await pair(bot);
  await assert.rejects(bot.handle(event('send-failure', 'hi'), async () => { throw new Error('network'); }), /network/);
  assert.deepEqual(bot.state.history, []);
  assert.equal(bot.state.seen.includes('send-failure'), false);
  await bot.handle(event('send-failure', 'hi'), async () => {});
  assert.equal(bot.state.history.length, 2);
  assert.equal(bot.state.seen.includes('send-failure'), true);
});
test('reply chunks respect four reply maximum and preserve Unicode', () => {
  assert.deepEqual(splitReply('🐱'.repeat(2000)).map(x => Array.from(x).length), [1800, 200]);
  assert.equal(splitReply('文'.repeat(10000)).length, 4);
});
test('rejects QQ business errors even if HTTP is 200', async () => {
  const client = new QQClient('1', 'dummy', { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ code: 100016 }) }) });
  await assert.rejects(client.accessToken(), /qq_token_error_100016/);
});
test('uses current official endpoint and passive reply fields', async () => {
  const calls = [];
  const client = new QQClient('1', 'dummy', { fetcher: async (url, request) => {
    calls.push({ url, request }); return { ok: true, status: 200, json: async () => url.endsWith('getAppAccessToken') ? { access_token: 'test-token', expires_in: '7200' } : { id: 'reply' } };
  }});
  await client.reply(event('msg', 'hello'), 'reply', 1); await client.reply(event('msg', 'hello'), 'second', 2);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.equal(calls[1].url, 'https://api.bot.qq.com/v2/users/owner/messages');
  assert.deepEqual(JSON.parse(calls[1].request.body), { content: 'reply', msg_type: 0, msg_id: 'msg', msg_seq: 1 });
});
test('Codex bridge uses read-only ephemeral mode and disables external tools', () => {
  const args = codexArgs(process.cwd());
  assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('read-only')); assert.ok(args.includes('shell_tool')); assert.ok(args.includes('plugins'));
  assert.equal(args.at(-1), '-');
});

 test('unpaired private messages receive setup guidance without model or owner memory access',async t=>{
 const bot=await fixture(t,async()=>assert.fail('unpaired model call'));
 bot.state.memory=['private secret'];const replies=[];
 await bot.handle(event('hello-unpaired','你好'),async text=>replies.push(text));
 assert.equal(replies.length,1);assert.match(replies[0],/配对/);assert.ok(!replies[0].includes('private secret'));
 assert.equal(bot.state.owner,null);assert.deepEqual(bot.state.history,[]);

 });
