import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MathReplies, isMathContinuation } from '../src/math_reply.mjs';
import { projectMathChatBlocks } from '../src/math_chat_projection.mjs';

const PROJECT = path.resolve(import.meta.dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const DOCUMENT = { title: '一元方程', blocks: [{ type: 'text', content: '两边减去 1' }, { type: 'math', content: 'x+1=3' }], summary: '求 x' };
const group = (id = 'g', message = randomUUID()) => ({ id: message, group_openid: id, author: { user_openid: 'a' } });
const privateEvent = (id = 'a', message = randomUUID()) => ({ id: message, chat_type: 'private', author: { user_openid: id } });
const fullText = pages => Array.from({ length: pages }, (_, i) => String(i % 10).repeat(1600)).join('');

async function fixture(t) {
  const parent = path.join(PROJECT, 'temp');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'math_reply_test_'));
  t.after(async () => {
    assert.ok(root.startsWith(`${parent}${path.sep}math_reply_test_`));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function output(root, count = 1, id = randomUUID()) {
  const outputDir = path.join(root, 'data', 'math_documents', id);
  await fs.mkdir(outputDir, { recursive: true });
  const images = [];
  for (let i = 0; i < count; i++) {
    const fileName = `page_${i + 1}.png`, filePath = path.join(outputDir, fileName);
    await fs.writeFile(filePath, PNG);
    images.push({ path: filePath, fileName, buffer: PNG, mime: 'image/png', width: 1, height: 1, blockIndexes: [i % 2] });
  }
  await fs.writeFile(path.join(outputDir, 'source.json'), JSON.stringify(DOCUMENT));
  return { id, outputDir, images, sourcePath: path.join(outputDir, 'source.json'), summary: '简短摘要' };
}

function delivery(limit = 5, { failImage, failText } = {}) {
  let attempts = 0;
  const sent = [], tried = [];
  const callbacks = {
    remaining: () => limit - attempts,
    sendImage: async (image, description) => {
      attempts++; tried.push({ type: 'image', fileName: image.fileName });
      if (failImage?.(image, attempts)) throw Error('QQ rejected image');
      sent.push({ type: 'image', image, content: description });
      return { id: `receipt-${attempts}`, msg_seq: attempts };
    },
    sendText: async text => {
      attempts++; tried.push({ type: 'text' });
      if (failText?.(text, attempts)) throw Error('QQ rejected text');
      sent.push({ type: 'text', content: text });
      return { id: `receipt-${attempts}`, msg_seq: attempts };
    }
  };
  return { callbacks, sent, tried, get attempts() { return attempts; } };
}

test('explicit continuation matcher has no broad chat triggers', () => {
  for (const text of ['/mathnext', ' 继续公式 ', '继续数学解答', '小柯，继续公式。', '小珂 继续数学解答！', '柯霜,/mathnext']) assert.equal(isMathContinuation(text), true);
  for (const text of ['继续', '请继续公式', '/mathnext now', '继续公式吧', null]) assert.equal(isMathContinuation(text), false);
});

test('group and each private scope are isolated; group 5/private 4 cap leaves an honest continuation slot', async t => {
  const root = await fixture(t), service = await MathReplies.open({ root, render: () => output(root, 7) });
  const g = group(), a = privateEvent(), b = privateEvent('b');
  await service.prepare(g, DOCUMENT, fullText(7));
  await service.prepare(a, DOCUMENT, fullText(7));
  await service.prepare(b, DOCUMENT, fullText(7));
  const groupDelivery = delivery(99), first = await service.deliver(g, groupDelivery.callbacks);
  assert.equal(groupDelivery.attempts, 5);
  assert.equal(groupDelivery.sent.filter(item => item.type === 'image').length, 4);
  assert.equal(service.pending(g).next, 4);
  assert.equal(service.pending(a).next, 0);
  assert.equal(first.delivered_messages.length, 5);
  assert.match(first.delivered_messages[0].content, /第 1\/7 页。.*两边减去/);
  assert.match(first.sent_text, /还剩 3 页.*继续公式/);
  const privateDelivery = delivery(99);
  await service.deliver(a, privateDelivery.callbacks);
  assert.equal(privateDelivery.attempts, 4);
  assert.equal(service.pending(a).next, 3);
  assert.equal(service.pending(b).next, 0);
  const files = await fs.readdir(path.join(root, 'data', 'math_replies', 'jobs', first.job.id));
  assert.deepEqual(files.sort(), ['document.json', 'fallback.txt']);
});

test('restart continues at next page, deduplicates event IDs persistently, and does not send an old event into a new job', async t => {
  const root = await fixture(t), render = () => output(root, 7), e = group('g', 'original');
  let service = await MathReplies.open({ root, render });
  const prepared = await service.prepare(e, DOCUMENT, fullText(7));
  assert.equal((await service.prepare(e, DOCUMENT, fullText(7))).id, prepared.id);
  await service.deliver(e, delivery().callbacks);
  service = await MathReplies.open({ root, render });
  const duplicate = delivery();
  assert.equal((await service.deliver(e, duplicate.callbacks)).duplicate, true);
  assert.equal(duplicate.attempts, 0);
  const nextEvent = group('g', 'next'), continuation = delivery();
  await service.deliver(nextEvent, continuation.callbacks);
  assert.equal(continuation.sent[0].image.fileName, 'page_5.png');
  assert.equal(service.pending(e), null);
  await service.prepare(group('g', 'new'), DOCUMENT, fullText(7));
  const replay = delivery();
  assert.equal((await service.deliver(nextEvent, replay.callbacks)).duplicate, true);
  assert.equal(replay.attempts, 0);
  assert.equal(service.pending(e).next, 0);
});

test('first rejected PNG falls back to the entire saved text with failed attempt included in budget', async t => {
  const root = await fixture(t), e = group(), text = fullText(6);
  const service = await MathReplies.open({ root, render: () => output(root, 6) });
  const job = await service.prepare(e, DOCUMENT, text);
  const first = delivery(5, { failImage: () => true });
  const receipt = await service.deliver(e, first.callbacks);
  assert.equal(first.attempts, 5);
  assert.equal(first.sent.filter(item => item.type === 'text' && item.content.length === 1600).length, 3);
  assert.equal(service.pending(e).mode, 'text');
  assert.equal(service.pending(e).next, 3);
  assert.match(receipt.sent_text, /切换完整文字/);
  const continuation = delivery();
  await service.deliver(group(), continuation.callbacks);
  const pieces = [...first.sent, ...continuation.sent].filter(item => item.content.length === 1600).map(item => item.content).join('');
  assert.equal(pieces, text);
  assert.equal(await fs.readFile(path.join(root, 'data', 'math_replies', 'jobs', job.id, 'fallback.txt'), 'utf8'), text);
});

test('a rejected page after successful PNGs keeps only the remaining pages for continuation', async t => {
  const root = await fixture(t), e = group(), service = await MathReplies.open({ root, render: () => output(root, 6) });
  await service.prepare(e, DOCUMENT, fullText(6));
  const first = delivery(5, { failImage: (_, n) => n === 3 });
  await service.deliver(e, first.callbacks);
  assert.equal(service.pending(e).next, 2);
  assert.equal(service.pending(e).mode, 'images');
  const second = delivery();
  await service.deliver(group(), second.callbacks);
  assert.deepEqual(second.sent.filter(item => item.type === 'image').map(item => item.image.fileName), ['page_3.png', 'page_4.png', 'page_5.png', 'page_6.png']);
});

test('render rejection, oversized document, and page overflow preserve every text step including emoji', async t => {
  const root = await fixture(t);
  for (const kind of ['rejected', 'document', 'pages']) {
    let calls = 0;
    const service = await MathReplies.open({ root, render: async () => {
      calls++;
      if (kind === 'rejected') throw Error('typesetting failed');
      return output(root, kind === 'pages' ? 33 : 1);
    } });
    const text = '首步🙂'.repeat(1300) + '\n最后结果，不能被摘要替代。', event = group(kind);
    const document = kind === 'document' ? { ...DOCUMENT, summary: 'x'.repeat(1001) } : DOCUMENT;
    await service.prepare(event, document, text);
    const pieces = [];
    for (let i = 0; service.pending(event) && i < 6; i++) {
      const batch = delivery();
      await service.deliver(i ? group(kind) : event, batch.callbacks);
      pieces.push(...batch.sent.filter(item => !/共 \d+ 页，已发送/.test(item.content)).map(item => item.content));
      for (const piece of batch.sent) assert.ok(Array.from(piece.content).length <= 1600);
    }
    assert.equal(pieces.join(''), text);
    assert.equal(calls, kind === 'document' ? 0 : 1);
  }
});

test('image byte/hash change never sends tampered bytes and uses complete fallback', async t => {
  const root = await fixture(t), result = await output(root), event = group();
  const service = await MathReplies.open({ root, render: async () => result });
  await service.prepare(event, DOCUMENT, '完整解答');
  await fs.writeFile(result.images[0].path, Buffer.from('corrupted'));
  const batch = delivery();
  await service.deliver(event, batch.callbacks);
  assert.equal(batch.sent.filter(item => item.type === 'image').length, 0);
  assert.equal(batch.sent[0].content, '完整解答');
});

test('renderer paths outside its UUID directory and linked images are rejected without touching their targets', async t => {
  const root = await fixture(t), external = path.join(root, 'outside.png');
  await fs.writeFile(external, PNG);
  const result = await output(root);
  result.images[0].path = external;
  const service = await MathReplies.open({ root, render: async () => result });
  assert.equal((await service.prepare(group('outside'), DOCUMENT, '完整原文')).mode, 'text');
  assert.deepEqual(await fs.readFile(external), PNG);
  const linked = await output(root);
  await fs.unlink(linked.images[0].path);
  await fs.link(external, linked.images[0].path);
  const next = await MathReplies.open({ root, render: async () => linked });
  assert.equal((await next.prepare(group('linked'), DOCUMENT, '完整原文')).mode, 'text');
  assert.deepEqual(await fs.readFile(external), PNG);
});

test('restart parks an in-flight send and a transport timeout parks immediately instead of duplicating', async t => {
  const root = await fixture(t), event = group();
  let service = await MathReplies.open({ root, render: () => output(root, 2) });
  await service.prepare(event, DOCUMENT, '完整解答');
  const indexPath = path.join(root, 'data', 'math_replies', 'index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.jobs[0].inFlight = 0;
  await fs.writeFile(indexPath, JSON.stringify(index));
  service = await MathReplies.open({ root, render: () => output(root) });
  const batch = delivery();
  await service.deliver(event, batch.callbacks);
  assert.equal(batch.sent.length, 1);
  assert.equal(batch.sent[0].type, 'text');
  assert.match(batch.sent[0].content, /未能确认/);
  assert.equal(service.pending(event).status, 'uncertain');
  const newer = group('new');
  await service.prepare(newer, DOCUMENT, '新解答');
  const timeout = delivery();
  timeout.callbacks.sendImage = async () => { throw Object.assign(Error('network timeout'), { name: 'TimeoutError' }); };
  await service.deliver(newer, timeout.callbacks);
  assert.equal(service.pending(newer).status, 'uncertain');
  assert.equal(timeout.sent.filter(item => item.type === 'image').length, 0);
  assert.match(timeout.sent[0].content, /暂停自动续发/);
});

test('forget removes only its scope sources and renderer output, preserving shared references', async t => {
  const root = await fixture(t), shared = await output(root, 2);
  const service = await MathReplies.open({ root, render: async () => shared }), a = group('a'), b = group('b');
  const ja = await service.prepare(a, DOCUMENT, 'a'), jb = await service.prepare(b, DOCUMENT, 'b');
  await service.forget(a);
  assert.equal(service.pending(a), null);
  assert.ok(service.pending(b));
  await fs.stat(shared.outputDir);
  await assert.rejects(fs.stat(path.join(root, 'data', 'math_replies', 'jobs', ja.id)), { code: 'ENOENT' });
  await service.forget(b);
  await assert.rejects(fs.stat(shared.outputDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'data', 'math_replies', 'jobs', jb.id)), { code: 'ENOENT' });
});

test('forget aborts pending rendering and prepare raises math_forgotten', async t => {
  const root = await fixture(t), event = group();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const service = await MathReplies.open({ root, render: ({ signal }) => new Promise((resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }) });
  const preparing = service.prepare(event, DOCUMENT, '全部原文');
  const rejected = assert.rejects(preparing, { code: 'math_forgotten' });
  await ready;
  await service.forget(event);
  await rejected;
  assert.equal(service.pending(event), null);
});

test('expired pending never sends on restart and index stays within 64 entries', async t => {
  const root = await fixture(t), event = group();
  let clock = 1000;
  let service = await MathReplies.open({ root, now: () => clock, ttlMs: 100, render: async () => { throw Error('fallback'); } });
  await service.prepare(event, DOCUMENT, '完整原文');
  clock = 1101;
  service = await MathReplies.open({ root, now: () => clock, render: async () => { throw Error('fallback'); } });
  assert.equal(service.pending(event), null);
  const batch = delivery();
  assert.equal((await service.deliver(event, batch.callbacks)).expired, true);
  assert.equal(batch.attempts, 0);
  for (let i = 0; i < 65; i++) await service.prepare(group('same'), DOCUMENT, `原文${i}`);
  const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'math_replies', 'index.json'), 'utf8'));
  assert.equal(state.jobs.length, 64);
  assert.equal(state.jobs.some(job => JSON.stringify(job).includes('group_openid')), false);
});

test('same-scope concurrent continuations serialize and reserve status even with only one slot', async t => {
  const root = await fixture(t), event = group(), service = await MathReplies.open({ root, render: () => output(root, 8) });
  await service.prepare(event, DOCUMENT, '完整原文');
  const sameEvent = group('g', 'same'), a = delivery(), b = delivery();
  await Promise.all([service.deliver(sameEvent, a.callbacks), service.deliver(sameEvent, b.callbacks)]);
  assert.equal(a.attempts + b.attempts, 5);
  assert.equal(service.pending(event).next, 4);
  const one = delivery(1);
  await service.deliver(group(), one.callbacks);
  assert.equal(one.attempts, 1);
  assert.match(one.sent[0].content, /还剩 4 页.*继续公式/);
  assert.equal(service.pending(event).next, 4);
});

test('emoji metadata reopens and a full text job can continue beyond 256 events', async t => {
  const root = await fixture(t), e = group(), doc = { ...DOCUMENT, blocks: [{ type: 'text', content: '🙂'.repeat(800) }, { type: 'math', content: 'x=2' }] };
  let service = await MathReplies.open({ root, render: () => output(root, 2) });
  await service.prepare(e, doc, fullText(2));
  await service.prepare(group('long-title'), { ...doc, title: '🙂'.repeat(100) }, '全文');
  const indexPath = path.join(root, 'data', 'math_replies', 'index.json'), index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.jobs[0].sources = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(64, '0'));
  await fs.writeFile(indexPath, JSON.stringify(index));
  service = await MathReplies.open({ root, render: () => output(root) });
  const batch = delivery();
  await service.deliver(group(), batch.callbacks);
  assert.equal(batch.sent.filter(item => item.type === 'image').length, 2);
});

test('failed forget keeps a tombstone so repair and retry remove the same scope files', async t => {
  const root = await fixture(t), e = group(), rendered = await output(root);
  let service = await MathReplies.open({ root, render: async () => rendered });
  const job = await service.prepare(e, DOCUMENT, '完整解答');
  const external = path.join(root, 'external.png');
  await fs.link(rendered.images[0].path, external);
  await assert.rejects(service.forget(e), /math_path_not_regular/);
  assert.equal(service.pending(e), null);
  const index = JSON.parse(await fs.readFile(path.join(root, 'data', 'math_replies', 'index.json'), 'utf8'));
  assert.equal(index.jobs[0].status, 'deleting');
  service = await MathReplies.open({ root, render: async () => rendered });
  await fs.unlink(external);
  await service.forget(e);
  await assert.rejects(fs.stat(rendered.outputDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'data', 'math_replies', 'jobs', job.id)), { code: 'ENOENT' });
});

test('aligned rows split over cards record only the actually delivered projection before and after continuation',async t=>{
  const root=await fixture(t),document={title:'逐步求值',summary:'结果',blocks:[{type:'math',content:'\\begin{aligned}x&=1+2\\\\&=3\\end{aligned}'}]};
  const projected=projectMathChatBlocks(document),rendered=await output(root,2);
  assert.deepEqual(projected.map(x=>x.content),['x=1+2','=3']);
  for(let i=0;i<2;i++)Object.assign(rendered.images[i],{blockIndexes:[0],visibleBlocks:[projected[i]],fragments:[{blockIndex:0,fragment:i}]});
  const service=await MathReplies.open({root,render:async()=>rendered}),event=group('projected');
  assert.equal((await service.prepare(event,document,'完整推导')).mode,'images');
  const index=JSON.parse(await fs.readFile(path.join(root,'data/math_replies/index.json'),'utf8'));
  assert.match(index.jobs[0].images[0].description,/x=1\+2/);
  assert.doesNotMatch(index.jobs[0].images[0].description,/内容：.*=3/);
  const first=delivery(2),receipt=await service.deliver(event,first.callbacks);
  assert.equal(first.sent.filter(x=>x.type==='image').length,1);
  assert.match(receipt.delivered_messages[0].content,/x=1\+2/);
  assert.doesNotMatch(receipt.delivered_messages[0].content,/内容：.*=3/);
  assert.equal(service.pending(event).next,1);
  const second=delivery(2),last=await service.deliver(group('projected'),second.callbacks);
  assert.match(last.delivered_messages[0].content,/内容：=3/);
  assert.doesNotMatch(last.delivered_messages[0].content,/x=1\+2/);
  assert.equal(service.pending(event),null);
});

test('wrong, omitted, repeated, out-of-order or invented renderer fragments are rejected before any image send',async t=>{
  const root=await fixture(t),document={title:'逐步求值',summary:'结果',blocks:[{type:'math',content:'\\begin{aligned}x&=1+2\\\\&=3\\end{aligned}'}]};
  const projected=projectMathChatBlocks(document);
  const corruptions=[
    images=>{images[0].visibleBlocks[0].fragment=99;},
    images=>{images[0].visibleBlocks[0].blockIndex=1;},
    images=>{images[0].visibleBlocks[0].content='x=999';},
    images=>{images[0].visibleBlocks[0].extra='invented';},
    images=>{delete images[1].visibleBlocks;},
    images=>{images[1].visibleBlocks=[{...projected[0]}];},
    images=>{images.reverse();},
    images=>{images.pop();},
    images=>{images[0].fragments[0].fragment=1;},
    images=>{images[0].blockIndexes=[1];}
  ];
  for(const [i,corrupt] of corruptions.entries()){
    const rendered=await output(root,2);
    for(let n=0;n<2;n++)Object.assign(rendered.images[n],{blockIndexes:[0],visibleBlocks:[{...projected[n]}],fragments:[{blockIndex:0,fragment:n}]});
    corrupt(rendered.images);
    const event=group('invalid_projection_'+i),service=await MathReplies.open({root,render:async()=>rendered});
    assert.equal((await service.prepare(event,document,'完整原文')).mode,'text');
    const batch=delivery();await service.deliver(event,batch.callbacks);
    assert.equal(batch.sent.filter(x=>x.type==='image').length,0);
    assert.equal(batch.sent[0].content,'完整原文');
  }
});
