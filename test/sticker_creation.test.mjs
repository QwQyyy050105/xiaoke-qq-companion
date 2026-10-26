import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StickerCreation } from '../src/sticker_creation.mjs';
import { MediaLibrary } from '../src/media.mjs';
import { inspectImage } from '../src/media_image.mjs';
import { Companion, hash } from '../src/core.mjs';
import { conversationPrompt, codexArgs, allowedVisionFiles, parseVisualReviewResponse } from '../src/model_client.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=', 'base64');
const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const PASS = { status: 'pass', notes: 'Offline fixture only; no actual character visual approval claimed.' };
const event = (id = 'request-1', group = 'group-a', content = '小柯，帮我制作一张“这题我会”的专属表情包') => ({ id, group_openid: group, content, author: { member_openid: 'member-a' } });
const suggestion = { create_prompt: '按照批准参考制作小柯表情，这题我会，保持脸与角可见比例。', title: '这题我会' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  await fs.mkdir(BASE, { recursive: true }); const root = await fs.mkdtemp(path.join(BASE, 'sticker_creation_test_'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'data/generated_images/job-1'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets/avatar.png'), PNG);
  await fs.writeFile(path.join(root, 'assets/media_approved.json'), JSON.stringify({ images: [
    { id: 'xiao_ke', path: 'assets/avatar.png', sha256: inspectImage(PNG).sha256, type: 'avatar', label: '小柯头像' }
  ] }));
  const output = path.join(root, 'data/generated_images/job-1/image.png'); await fs.writeFile(output, PNG);
  const image = { path: output, ...inspectImage(PNG) }; delete image.buffer;
  const calls = [];
  const media = await MediaLibrary.open({ root });
  const args = { root, media, createImage: async input => { calls.push(input); return image; }, visualReview: {
    preflight: async refs => { assert.equal(refs.length, 2); return PASS; }, postflight: async () => PASS
  }, ...options };
  const service = await new StickerCreation(args).init();
  t.after(() => service.stop()); return { root, service, media, image, calls, args };
}

test('explicit current request returns immediately and completes actual import through both visual stages', async t => {
  const gate = deferred(), f = await fixture(t); const stages = [];
  f.service.createImage = async input => { f.calls.push(input); await gate.promise; return f.image; };
  f.service.visualReview = { preflight: async refs => { stages.push('before'); assert.equal(refs.length, 2); return PASS; },
    postflight: async (refs, actual) => { stages.push('after'); assert.equal(actual.path, f.image.path); return PASS; } };
  const e = event(); const result = await f.service.execute(e, suggestion);
  assert.equal(result.status, 'started'); assert.equal(f.service.pendingFor(e), null);
  gate.resolve(); await f.service.waitForIdle(e);
  const pending = f.service.pendingFor(e); assert.equal(pending.status, 'ready'); assert.match(pending.id, /^collected_/);
  assert.deepEqual(stages, ['before', 'after']); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].sizeReview.status, 'pass');
  assert.equal((await f.media.prepare(e, pending.id)).sha256, f.image.sha256);
  await assert.rejects(f.media.prepare(event('another', 'group-b'), pending.id), /unknown_id/);
  assert.equal(f.service.pendingFor(event('another', 'group-b')), null);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'temp/media')), []);
});

test('quoted/history/proactive/capability questions cannot authorize generation', async t => {
  const f = await fixture(t);
  for (const e of [event('quote', 'group-a', '他说：“帮我制作表情包”'),
    event('history', 'group-a', '你好'), event('ability', 'group-a', '你能制作表情包吗？'),
    { ...event('proactive'), mode: 'proactive' }]) {
    e.history = [{ content: event().content }]; e.quoted_messages = [{ text: event().content }];
    assert.equal((await f.service.execute(e, suggestion)).status, 'ignored');
  }
  assert.equal(f.calls.length, 0);
});

test('same room permits one running job and source replay never generates a second image', async t => {
  const gate = deferred(), f = await fixture(t); f.service.createImage = async () => { await gate.promise; return f.image; };
  const e = event(); assert.equal((await f.service.execute(e, suggestion)).status, 'started');
  assert.equal((await f.service.execute(event('request-2'), suggestion)).status, 'busy');
  assert.equal((await f.service.execute(e, suggestion)).status, 'running');
  gate.resolve(); await f.service.waitForIdle(e);
  await f.service.confirmDelivered(e, f.service.pendingFor(e).jobKey);
  assert.equal((await f.service.execute(e, suggestion)).status, 'ignored');
});

test('failed or unverified actual size review prevents generating/importing and retains real output evidence', async t => {
  for (const stage of ['before', 'after']) {
    const f = await fixture(t);
    f.service.visualReview = { preflight: async () => stage === 'before' ? { status: 'unverified', notes: 'fixture' } : PASS,
      postflight: async () => ({ status: 'fail', notes: 'fixture mismatch' }) };
    await f.service.execute(event(), suggestion); await f.service.waitForIdle(event());
    const pending = f.service.pendingFor(event()); assert.equal(pending.status, 'failed'); assert.match(pending.message, /没有通过实际视觉检查/);
    assert.equal(f.calls.length, stage === 'before' ? 0 : 1); assert.equal(f.media.contextFor(event()).images.filter(i => i.type === 'sticker').length, 0);
    if (stage === 'after') { assert.equal(pending.output.path, f.image.path); await fs.access(pending.output.path); }
  }
});

test('usage limit is truthful, no automatic retry; undelivered result persists to a later event and restart', async t => {
  const f = await fixture(t, { createImage: async () => { throw Object.assign(new Error('quota'), { code: 'image_usage_limit', usageLimit: true }); } });
  await f.service.execute(event(), suggestion); await f.service.waitForIdle(event());
  const reopened = await new StickerCreation(f.args).init();
  let notices = 0; await reopened.deliverPending(event('later'), async result => { notices++; assert.match(result.message, /额度.*图还没生成/); });
  assert.equal(notices, 1); assert.equal(reopened.pendingFor(event()), null);
});

test('ready image retained after missed delivery window; next message can deliver exactly once', async t => {
  const f = await fixture(t); let attempts = 0;
  await f.service.execute(event(), suggestion, { onComplete: async () => { attempts++; throw new Error('group_reply_expired'); } });
  await f.service.waitForIdle(event()); assert.equal(attempts, 1);
  const reopened = await new StickerCreation(f.args).init(); const gate = deferred();
  const first = reopened.deliverPending(event('later'), async pending => { await f.media.prepare(event('later'), pending.id); await gate.promise; });
  assert.equal(await reopened.deliverPending(event('parallel'), () => assert.fail('double send')), false);
  gate.resolve(); assert.equal(await first, true); assert.equal(reopened.pendingFor(event()), null);
});

test('forget invalidates in-flight completion, prevents import and removes pending jobs', async t => {
  const f = await fixture(t), gate = deferred(); f.service.createImage = async () => { await gate.promise; return f.image; };
  await f.service.execute(event(), suggestion); await new Promise(r => setTimeout(r, 15));
  await f.service.forget(event()); await f.media.forget(event()); gate.resolve(); await f.service.waitForIdle(event());
  assert.equal(f.service.pendingFor(event()), null); assert.equal(f.media.contextFor(event()).images.filter(i => i.type === 'sticker').length, 0);
});

test('changing the approved reference while a completed image waits invalidates old delivery approval', async t => {
  const f = await fixture(t);
  await f.service.execute(event(), suggestion); await f.service.waitForIdle(event());
  const pending = f.service.pendingFor(event()); assert.equal(pending.status, 'ready');
  // Remove the live approval without touching the historic generated evidence.
  await fs.writeFile(path.join(f.root, 'assets/media_approved.json'), JSON.stringify({ images: [] }));
  await f.service.deliverPending(event('later'), async result => {
    assert.equal(result.status, 'failed'); assert.match(result.message, /批准参考已经变化/);
  });
  await fs.access(f.image.path); assert.equal(f.service.pendingFor(event()), null);
});

test('a clear command routed during a slow chat also cancels an earlier queued creation request', async t => {
  const f = await fixture(t);
  await f.service.forget({ ...event('clear'), content: '/forget', _receivedAt: 2000 });
  const old = await f.service.execute({ ...event('older'), _receivedAt: 1000 }, suggestion);
  assert.equal(old.status, 'ignored'); assert.equal(f.calls.length, 0);
  const fresh = { ...event('newer'), _receivedAt: 3000 };
  assert.equal((await f.service.execute(fresh, suggestion)).status, 'started');
  await f.service.waitForIdle(fresh); assert.equal(f.calls.length, 1);
});

test('core forwards create suggestion while actual workflow status replaces speculative model success', async t => {
  const f = await fixture(t), gate = deferred(); f.service.createImage = async () => { await gate.promise; return f.image; };
  const companion = await new Companion({ dataDir: path.join(f.root, 'data'), pairingHash: hash('test'),
    generate: async () => ({ reply: '我做好发出了！', memories: [], media: suggestion }) }).init();
  const sent = [];
  const result = await companion.handle(event(), async (_text, options) => {
    const job = await f.service.execute(event(), options.media); sent.push(job.message);
    return { id: 'qq-fixture', sent_text: job.message };
  });
  assert.equal(result.status, 'replied'); assert.match(sent[0], /开始制作/); assert.doesNotMatch(sent[0], /做好发出了/);
  gate.resolve(); await f.service.waitForIdle(event());
});

test('visual review is schema constrained with real images while ordinary chat keeps imagegen disabled', async t => {
  const f = await fixture(t);
  const args = codexArgs(f.root, { structured: true, visualReview: true });
  assert.ok(args.some(arg => arg.endsWith('visual_review.schema.json')));
  assert.ok(args.some((arg, i) => arg === '--disable' && args[i + 1] === 'image_generation'));
  await assert.rejects(allowedVisionFiles(f.root, [{ path: f.image.path }]), /path_rejected/);
  assert.equal((await allowedVisionFiles(f.root, [{ path: f.image.path }], { visualReview: true })).length, 1);
  assert.throws(() => parseVisualReviewResponse('{"status":"pass","notes":""}'), /invalid_visual/);
  assert.deepEqual(parseVisualReviewResponse(JSON.stringify(PASS)), PASS);
  const prompt = conversationPrompt('PRIVATE PERSONA', { mode: 'visual_review', text: 'compare actual images', history: [{ content: 'private history' }] });
  assert.doesNotMatch(prompt, /PRIVATE PERSONA|private history/); assert.match(prompt, /分辨率.*不是/);
});
