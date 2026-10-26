import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageVisualReviewer } from '../src/image_visual_review.mjs';

const TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=', 'base64');
// Mock observations test control flow only. These tiny fixtures are not character-size evidence.
const PASS = { status: 'pass', notes: '离线模拟：两图脸与龙角相对大小、胸像占画面比例和留白一致。' };

async function fixture(t) {
  await fs.mkdir(TEMP, { recursive: true });
  const base = await fs.mkdtemp(path.join(TEMP, 'image_visual_review_test_'));
  assert.ok(base.startsWith(TEMP + path.sep));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const references = [path.join(base, 'reference_1.png'), path.join(base, 'reference_2.png')];
  const generated = path.join(base, 'generated.png');
  await Promise.all([...references, generated].map(file => fs.writeFile(file, PNG)));
  return { base, references, generated };
}

test('preflight actually sends both approved images with visual comparison instructions', async t => {
  const f = await fixture(t); const calls = [];
  const reviewer = createImageVisualReviewer({ reviewVision: async input => { calls.push(input); return PASS; } });
  assert.deepEqual(await reviewer.preflight(f.references.map(path => ({ path }))), PASS);
  assert.equal(calls.length, 1); assert.equal(calls[0].stage, 'preflight');
  assert.deepEqual(calls[0].visionFiles.map(file => file.path), f.references);
  assert.deepEqual(calls[0].visionFiles.map(file => file.id), ['size_reference', 'size_candidate']);
  assert.match(calls[0].text, /相同显示尺度/); assert.match(calls[0].text, /脸和头部/);
  assert.match(calls[0].text, /龙角/); assert.match(calls[0].text, /胸像/);
  assert.match(calls[0].text, /相同源文件.*不能证明/);
});

test('postflight sends the real generated file against each supplied reference', async t => {
  const f = await fixture(t); const calls = [];
  const reviewer = createImageVisualReviewer({ reviewVision: async input => { calls.push(input); return PASS; } });
  const result = await reviewer.postflight(f.references, { savedPath: f.generated });
  assert.equal(result.status, 'pass'); assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.stage, 'postflight');
    assert.deepEqual(call.visionFiles.map(file => file.path), [f.references[index], f.generated]);
    assert.match(call.text, /本次实际生成的产物/);
  }
});

test('same source and identical bytes never bypass an actual call or override fail/unverified', async t => {
  const f = await fixture(t); let calls = 0;
  for (const status of ['fail', 'unverified']) {
    const reviewer = createImageVisualReviewer({ reviewVision: async () => { calls++; return { status, notes: '离线模拟：主体无法比较。' }; } });
    assert.equal((await reviewer.preflight([f.references[0], f.references[0]])).status, status);
  }
  assert.equal(calls, 2);
});

test('missing, unreadable, invalid, relative, or hash-mismatched images cannot pass or invoke vision', async t => {
  const f = await fixture(t); let calls = 0;
  const reviewer = createImageVisualReviewer({ reviewVision: async () => { calls++; return PASS; } });
  const invalid = path.join(f.base, 'not_image.png'); await fs.writeFile(invalid, 'not an image');
  for (const files of [undefined, [], [f.references[0]], [...f.references, f.generated],
    [f.references[0], path.join(f.base, 'missing.png')], [f.references[0], f.base],
    [f.references[0], invalid], [f.references[0], 'relative.png'],
    [f.references[0], { path: f.references[1], sha256: '0'.repeat(64) }]]) {
    const result = await reviewer.preflight(files);
    assert.equal(result.status, 'unverified'); assert.ok(result.notes);
  }
  for (const args of [[[], f.generated], [f.references], [[f.references[0]], path.join(f.base, 'missing.png')]]) {
    assert.equal((await reviewer.postflight(...args)).status, 'unverified');
  }
  assert.equal(calls, 0);
});

test('invalid model outputs, unavailable service and thrown errors remain unverified', async t => {
  const f = await fixture(t);
  for (const response of [null, {}, 'pass', JSON.stringify(PASS), [], { status: 'PASS', notes: 'text' },
    { status: 'pass', notes: '' }, { status: 'pass', notes: '  ' }, { status: 'pass', notes: 4 },
    { ...PASS, unexpected: true }, { status: 'pass', notes: 'x'.repeat(4001) }]) {
    assert.equal((await createImageVisualReviewer({ reviewVision: async () => response }).preflight(f.references)).status, 'unverified');
  }
  assert.equal((await createImageVisualReviewer().preflight(f.references)).status, 'unverified');
  const reviewer = createImageVisualReviewer({ reviewVision: async () => { throw new Error('private provider details'); } });
  const result = await reviewer.preflight(f.references);
  assert.equal(result.status, 'unverified'); assert.doesNotMatch(result.notes, /private provider details/);
});

test('image mutation during review invalidates even a model pass', async t => {
  const f = await fixture(t);
  const reviewer = createImageVisualReviewer({ reviewVision: async () => {
    const changed = Buffer.from(PNG); changed[changed.length - 1] ^= 1;
    await fs.writeFile(f.references[1], changed);
    return PASS;
  } });
  const result = await reviewer.preflight(f.references);
  assert.equal(result.status, 'unverified'); assert.match(result.notes, /变化/);
});

test('one failed or unverified postflight comparison prevents aggregate pass', async t => {
  const f = await fixture(t);
  for (const status of ['fail', 'unverified']) {
    let calls = 0;
    const reviewer = createImageVisualReviewer({ reviewVision: async () => ++calls === 1 ? PASS : { status, notes: '离线模拟：第二参考主体比例无法通过。' } });
    const result = await reviewer.postflight(f.references, f.generated);
    assert.equal(calls, 2); assert.equal(result.status, status);
    assert.match(result.notes, /参考 1/); assert.match(result.notes, /参考 2/);
  }
});

test('an already canceled review never starts the vision runner', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  const reviewer = createImageVisualReviewer({ reviewVision: async () => assert.fail('canceled model call') });
  for (const result of [await reviewer.preflight(f.references, { signal: controller.signal }),
    await reviewer.postflight(f.references, f.generated, { signal: controller.signal })]) {
    assert.equal(result.status, 'unverified'); assert.match(result.notes, /取消/);
  }
});

test('both stages pass the original signal to the runner and reject a pass after cancellation', async t => {
  const f = await fixture(t);
  for (const stage of ['preflight', 'postflight']) {
    const controller = new AbortController(); let calls = 0;
    const reviewer = createImageVisualReviewer({ reviewVision: async input => {
      calls++; assert.equal(input.signal, controller.signal);
      controller.abort(); return PASS;
    } });
    const result = stage === 'preflight'
      ? await reviewer.preflight(f.references, { signal: controller.signal })
      : await reviewer.postflight(f.references, f.generated, { signal: controller.signal });
    assert.equal(result.status, 'unverified'); assert.match(result.notes, /取消/); assert.equal(calls, 1);
  }
});

test('a runner rejection after abort remains a canceled unverified result', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const reviewer = createImageVisualReviewer({ reviewVision: async ({ signal }) => {
    assert.equal(signal, controller.signal); controller.abort(); throw new Error('aborted provider');
  } });
  const result = await reviewer.preflight(f.references, { signal: controller.signal });
  assert.equal(result.status, 'unverified'); assert.match(result.notes, /取消/);
  assert.doesNotMatch(result.notes, /aborted provider/);
});
