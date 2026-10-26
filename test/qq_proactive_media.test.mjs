import test from 'node:test';
import assert from 'node:assert/strict';
import { QQClient } from '../src/qq.mjs';
import { MAX_IMAGE_BYTES } from '../src/media_image.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=', 'base64');
function wav() {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(16000, 40);
  return buffer;
}
function fakeClient(respond = (call, index) => index === 0 ? { file_info: 'upload-receipt' } : { id: 'message-receipt', timestamp: 123 }) {
  const calls = [];
  const client = new QQClient('synthetic-app', 'synthetic-secret', { log: () => {}, fetcher: async (url, options) => {
    const call = { url, method: options.method, body: JSON.parse(options.body) }; calls.push(call);
    const response = await respond(call, calls.length - 1);
    return { ok: response.httpStatus ? response.httpStatus < 400 : true, status: response.httpStatus || 200, json: async () => response.body || response };
  } });
  client.token = 'synthetic-test-token'; client.expiresAt = Infinity;
  return { calls, client };
}

for (const [method, fileType, buffer, mime] of [['proactiveImage', 1, PNG, 'image/png'], ['proactiveVoice', 3, wav(), 'audio/wav']]) {
  test(`${method} uploads actual bytes then sends group rich media without invented reply identifiers`, async () => {
    const { calls, client } = fakeClient();
    const receipt = await client[method]('test/group?name', { buffer, mime, url: 'https://private.example/source', path: 'D:\\private\\original',
      fileName: 'untrusted-file-name', file_info: 'forged-upload', msg_id: 'forged-trigger', msg_seq: 999, message_reference: { message_id: 'forged-quote' } });
    assert.deepEqual(receipt, { id: 'message-receipt', timestamp: 123 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://api.bot.qq.com/v2/groups/test%2Fgroup%3Fname/files');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['file_data', 'file_name', 'file_type', 'srv_send_msg']);
    assert.equal(calls[0].body.file_type, fileType); assert.equal(calls[0].body.srv_send_msg, false);
    assert.deepEqual(Buffer.from(calls[0].body.file_data, 'base64'), buffer);
    assert.doesNotMatch(calls[0].body.file_name, /untrusted|private/);
    assert.equal(calls[1].url, 'https://api.bot.qq.com/v2/groups/test%2Fgroup%3Fname/messages');
    assert.equal(calls[1].method, 'POST');
    assert.deepEqual(calls[1].body, { msg_type: 7, media: { file_info: 'upload-receipt' } });
    assert.doesNotMatch(JSON.stringify(calls), /private|forged|untrusted|msg_id|msg_seq|message_reference/);
  });

  test(`${method} rejects untrusted upload results before any message request`, async () => {
    for (const response of [{}, { file_info: '' }, { file_info: 17 }, { file_info: 'x'.repeat(65537) }]) {
      const { calls, client } = fakeClient(() => response);
      await assert.rejects(client[method]('synthetic-group', { buffer, mime }), /qq_invalid_media_upload/);
      assert.equal(calls.length, 1); assert.match(calls[0].url, /\/files$/);
    }
  });

  test(`${method} stops after an in-flight upload when the original conversation is canceled`, async () => {
    let releaseUpload, uploadStarted, current = true;
    const waiting = new Promise(resolve => { releaseUpload = resolve; });
    const started = new Promise(resolve => { uploadStarted = resolve; });
    const { calls, client } = fakeClient(async (call, index) => {
      assert.equal(index, 0, 'a canceled upload must never be followed by a messages POST');
      uploadStarted(); await waiting;
      return { file_info: 'actual-upload' };
    });
    const pending = client[method]('synthetic-group', { buffer, mime }, { isCurrent: () => current });
    const rejected = assert.rejects(pending, /proactive_stale/);
    await started; current = false; releaseUpload();
    await rejected;
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/files$/);
    assert.equal(calls[0].body.srv_send_msg, false);
  });

  test(`${method} does not upload an already stale opportunity`, async () => {
    const { calls, client } = fakeClient();
    await assert.rejects(client[method]('synthetic-group', { buffer, mime }, { isCurrent: () => false }), /proactive_stale/);
    assert.equal(calls.length, 0);
  });

  test(`${method} propagates permission failure and ambiguous network failure without retrying a send`, async () => {
    const denied = fakeClient((call, index) => index === 0 ? { file_info: 'upload-receipt' } : { httpStatus: 403, body: { code: 40034105 } });
    await assert.rejects(denied.client[method]('synthetic-group', { buffer, mime }), error => {
      assert.equal(error.message, 'qq_api_error_40034105'); assert.equal(error.status, 403); assert.equal(error.code, 40034105); return true;
    });
    assert.equal(denied.calls.length, 2);
    const uncertain = fakeClient((call, index) => { if (index === 1) throw new Error('synthetic_network_uncertain'); return { file_info: 'upload-receipt' }; });
    await assert.rejects(uncertain.client[method]('synthetic-group', { buffer, mime }), /synthetic_network_uncertain/);
    assert.equal(uncertain.calls.length, 2);
    const uploadDenied = fakeClient(() => ({ httpStatus: 403, body: { code: 40034105 } }));
    await assert.rejects(uploadDenied.client[method]('synthetic-group', { buffer, mime }), /qq_api_error_40034105/);
    assert.equal(uploadDenied.calls.length, 1);
  });

  test(`${method} accepts neither missing targets nor external URL/path-only media`, async () => {
    const { calls, client } = fakeClient();
    for (const group of ['', null, undefined, {}, 'x'.repeat(513)]) await assert.rejects(client[method](group, { buffer, mime }), /qq_invalid_proactive_target/);
    for (const input of [{ url: 'https://external.example/file' }, { path: 'D:\\private\\file' }, { file_data: buffer.toString('base64') }, { buffer: Buffer.from('invalid') }]) {
      await assert.rejects(client[method]('synthetic-group', input));
    }
    assert.equal(calls.length, 0);
  });
}

test('proactive image transport enforces actual MIME, dimensions and size before upload', async () => {
  const { calls, client } = fakeClient();
  await assert.rejects(client.proactiveImage('synthetic-group', { buffer: PNG, mime: 'image/jpeg' }), /mime_mismatch/);
  await assert.rejects(client.proactiveImage('synthetic-group', { buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1), mime: 'image/png' }), /image_size/);
  const bomb = Buffer.from(PNG); bomb.writeUInt32BE(20000, 16);
  await assert.rejects(client.proactiveImage('synthetic-group', { buffer: bomb, mime: 'image/png' }), /dimensions/);
  assert.equal(calls.length, 0);
});
test('successful HTTP without a message receipt is uncertain, not a delivered image',async()=>{
 const {client,calls}=fakeClient((call,index)=>index===0?{file_info:'real-upload'}:{code:0});
 await assert.rejects(client.proactiveImage('group',{buffer:PNG,mime:'image/png'}),/qq_delivery_unconfirmed/);
 assert.equal(calls.length,2);
});

test('proactive text checks the current opportunity before making a request', async () => {
  const { client, calls } = fakeClient(() => ({ id: 'text-receipt' }));
  await assert.rejects(client.proactive('group', 'synthetic message', { isCurrent: () => false }), /proactive_stale/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.proactive('group', 'synthetic message'), { id: 'text-receipt' });
  assert.equal(calls.length, 1);
});
