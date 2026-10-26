import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { OwnerBrowser, sanitizeOwnerBrowserUrl, validateOwnerBrowserUrl, ownerScreenshotHasMediaDetail } from '../src/owner_browser.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function screenshotPng(detailed) {
  const width = 96, height = 96; const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; if (detailed) for (let x = 0; x < width; x++) { const i = y * (width * 3 + 1) + 1 + x * 3; raw[i] = x * 2; raw[i + 1] = y * 2; raw[i + 2] = (x + y) % 255; } }
  const chunk = (type, data) => { const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8); let crc = 0xffffffff; for (const byte of out.subarray(4, out.length - 4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const MEDIA = [{ kind: 'video', decoded: true, rect: { x: 0, y: 0, width: 1280, height: 800 } }];

class FakePage extends EventEmitter {
  constructor(context) {
    super(); this.context = context; this.currentUrl = 'about:blank'; this.closed = false;
    this.frame = { parentFrame: () => null }; this.calls = []; this.rendered = {};
    this.mouse = { wheel: async (x, y) => { this.calls.push(['wheel', x, y]); } };
  }
  url() { return this.currentUrl; }
  mainFrame() { return this.frame; }
  async goto(url, options) {
    this.calls.push(['goto', url, options]);
    const request = await this.context.dispatch(url, { navigation: true });
    if (request.aborted) throw new Error('net blocked');
    if (this.gotoGate) await this.gotoGate.promise;
    if (this.closed) throw new Error('context closed');
    this.currentUrl = this.redirect || url;
    if (this.redirect) { const redirected = await this.context.dispatch(this.redirect, { navigation: true }); if (redirected.aborted) throw new Error('redirect blocked'); }
    this.emit('framenavigated', this.frame);
    return { status: () => 200 };
  }
  async evaluate(fn, args) {
    this.calls.push(['evaluate', typeof fn, args]);
    return { challenge: false, url: this.currentUrl, title: '真实页面标题', text: 'JS 渲染后的内容', truncated: false, links: [], ...this.rendered };
  }
  async screenshot(options) { this.calls.push(['screenshot', options]); this.onScreenshot?.(); return this.image || PNG; }
  async close() { if (this.closed) return; this.closed = true; this.gotoGate?.reject(new Error('closed')); this.emit('close'); }
}

class FakeContext extends EventEmitter {
  constructor() { super(); this.page = new FakePage(this); this.closed = 0; this.routes = []; }
  setDefaultTimeout(value) { this.defaultTimeout = value; }
  setDefaultNavigationTimeout(value) { this.navigationTimeout = value; }
  async route(pattern, handler) { this.routes.push({ pattern, handler }); }
  async routeWebSocket(pattern, handler) { this.websocket = { pattern, handler }; }
  pages() { return [this.page]; }
  async newPage() { throw new Error('unexpected new page'); }
  async close() { this.closed++; await this.page.close(); }
  async dispatch(url, { navigation = false, method = 'GET', childFrame = false } = {}) {
    const result = { continued: false, aborted: false };
    const request = { url: () => url, method: () => method, isNavigationRequest: () => navigation, frame: () => childFrame ? { parentFrame: () => this.page.frame } : this.page.frame };
    await this.routes[0].handler({ request: () => request, continue: async () => { result.continued = true; }, abort: async () => { result.aborted = true; } });
    return result;
  }
}

async function fixture(t, overrides = {}) {
  const base = path.resolve('temp'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'owner_browser_test_'));
  const executablePath = path.join(root, 'runtime', 'browsers', 'chromium', 'chrome.exe');
  await fs.mkdir(path.dirname(executablePath), { recursive: true }); await fs.writeFile(executablePath, 'fake-binary-never-executed');
  const context = new FakeContext(); const launches = [];
  const chromium = { launchPersistentContext: async (profile, options) => { launches.push({ profile, options }); return context; } };
  const runtime = new OwnerBrowser({ root, executablePath, executableSha256: digest('fake-binary-never-executed'), chromium, lookup: publicLookup, now: () => new Date('2026-10-24T00:00:00.000Z'), renderReadyTimeoutMs: 0, ...overrides });
  t.after(async () => {
    await runtime.active?.close();
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(base));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { runtime, context, page: context.page, launches, root, executablePath, open: (options = {}) => runtime.open({ ownerId: 'qq-private-owner', jobId: 'owner-job-1', ...options }) };
}

test('real-browser adapter returns actual DOM and PNG receipts; D profile and clean child env', async t => {
  const f = await fixture(t); const session = await f.open();
  f.page.rendered.text = '页面 https://www.douyin.com/video/123?token=do-not-expose&from=feed';
  const result = await session.navigate('https://www.douyin.com/?recommend=1');
  assert.equal(result.status, 'observed'); assert.equal(result.observation.title, '真实页面标题');
  assert.equal(result.observation.text, '页面 https://www.douyin.com/video/123?from=feed');
  assert.deepEqual(result.image, { bytes: PNG, mimeType: 'image/png' });
  assert.equal(result.receipt.ownerHash, digest('qq-private-owner')); assert.equal(result.receipt.jobHash, digest('owner-job-1'));
  assert.equal(result.receipt.screenshotSha256, digest(PNG)); assert.equal(result.receipt.textSha256, digest(result.observation.text));
  assert.equal(result.receipt.httpStatus, 200); assert.equal(result.receipt.observedAt, '2026-10-24T00:00:00.000Z');
  const launch = f.launches[0]; assert.equal(launch.profile, path.join(f.root, 'data', 'owner_browser', 'profiles', digest('qq-private-owner')));
  assert.equal(launch.options.javaScriptEnabled, true); assert.equal(launch.options.serviceWorkers, 'block'); assert.equal(launch.options.acceptDownloads, false);
  assert.ok(launch.options.env.TEMP.startsWith(f.root)); assert.ok(launch.options.env.LOCALAPPDATA.startsWith(f.root));
  assert.ok(!Object.keys(launch.options.env).some(key => /CODEX|CUA|PIPE|TOKEN|SECRET|KEY/i.test(key)));
  assert.equal(f.page.calls.filter(call => call[0] === 'evaluate').length, 2);
  await session.close(); assert.equal(f.context.closed, 1); assert.equal(f.runtime.active, null);
  await assert.rejects(fs.stat(path.join(f.root, 'data', 'owner_browser', 'active.lock')), { code: 'ENOENT' });
});

test('follow only accepts current observed safe anchors; every snapshot and navigation expires old IDs', async t => {
  const f = await fixture(t); const session = await f.open();
  f.page.rendered.links = [
    { text: '第二页', url: 'https://www.douyin.com/video/2' },
    { text: '点赞', url: 'https://www.douyin.com/like/2' },
    { text: '脚本', url: 'javascript:alert(1)' },
    { text: '私人', url: 'http://127.0.0.1/' },
    { text: '站外', url: 'https://example.com/' },
    { text: '登录', url: 'https://www.douyin.com/login' }
  ];
  const first = await session.navigate('https://www.douyin.com/'); assert.equal(first.observation.links.length, 1);
  const oldId = first.observation.links[0].id;
  const second = await session.snapshot(); assert.ok(second.observation.pageVersion > first.observation.pageVersion);
  await assert.rejects(session.follow(oldId), { code: 'owner_browser_stale_link' });
  const result = await session.follow(second.observation.links[0].id); assert.equal(result.observation.url, 'https://www.douyin.com/video/2');
  assert.equal(result.receipt.action, 'follow');
  f.page.emit('framenavigated', f.page.frame);
  await assert.rejects(session.follow(result.observation.links[0].id), { code: 'owner_browser_stale_link' });
});

test('URL policy refuses private networks, non-web schemes, secrets, account changes and foreign origins', () => {
  const blocked = ['file:///D:/secret', 'data:text/plain,hello', 'javascript:1', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://fixture:fake@example.com/', 'https://www.douyin.com:8443/', 'https://www.douyin.com/?access_token=secret', 'https://www.douyin.com/logout', 'https://www.douyin.com/%6cike/1', 'https://www.douyin.com/?action=buy', 'https://example.com/'];
  for (const url of blocked) assert.throws(() => validateOwnerBrowserUrl(url), error => error.code?.startsWith('owner_browser_'), url);
  assert.equal(validateOwnerBrowserUrl('https://www.douyin.com/video/123?recommend=1').origin, 'https://www.douyin.com');
  assert.equal(sanitizeOwnerBrowserUrl('https://name:pw@www.douyin.com/?token=x&code=y&state=z&from=feed#secret'), 'https://www.douyin.com/?from=feed');
});

test('routes revalidate DNS including redirects and CDN subrequests; ordinary POST read APIs work', async t => {
  const f = await fixture(t, { lookup: async host => [{ address: host === 'private.example' ? '192.168.1.2' : '8.8.8.8' }] }); await f.open();
  assert.equal((await f.context.dispatch('https://public.cdn.example/image.png')).continued, true);
  assert.equal((await f.context.dispatch('https://private.example/image.png')).aborted, true);
  assert.equal((await f.context.dispatch('https://www.douyin.com/api/feed', { method: 'POST' })).continued, true);
  assert.equal((await f.context.dispatch('https://www.douyin.com/aweme/v1/web/commit/follow/user', { method: 'POST' })).aborted, true);
  assert.equal((await f.context.dispatch('https://example.com/redirected', { navigation: true })).aborted, true);
  assert.equal((await f.context.dispatch('https://www.douyin.com/form', { navigation: true, method: 'POST' })).aborted, true);
  assert.equal((await f.context.dispatch('http://169.254.169.254/latest/meta-data')).aborted, true);
  const ws = raw => ({ connected: false, closed: false, url: () => raw, connectToServer() { this.connected = true; }, async close() { this.closed = true; } });
  const publicSocket = ws('wss://public.cdn.example/read'); await f.context.websocket.handler(publicSocket); assert.equal(publicSocket.connected, true);
  const privateSocket = ws('ws://127.0.0.1/'); await f.context.websocket.handler(privateSocket); assert.equal(privateSocket.closed, true); assert.equal(privateSocket.connected, false);
});

test('mixed public and private DNS answers fail closed before browser navigation', async t => {
  const f = await fixture(t, { lookup: async () => [{ address: '8.8.8.8' }, { address: '10.1.2.3' }] }); const session = await f.open();
  await assert.rejects(session.navigate('https://www.douyin.com/'), { code: 'owner_browser_private_address' });
  assert.equal(f.page.calls.length, 0);
});

test('private/foreign redirect never produces an observed receipt or screenshot', async t => {
  const f = await fixture(t); const session = await f.open(); f.page.redirect = 'http://127.0.0.1/secret';
  const result = await session.navigate('https://www.douyin.com/');
  assert.equal(result.status, 'page_unavailable'); assert.equal(result.observation.text, ''); assert.equal(result.image, undefined);
  assert.equal(f.page.calls.some(call => call[0] === 'screenshot'), false);
});

test('login challenge is withheld before screenshot and after a capture race', async t => {
  const f = await fixture(t); const session = await f.open(); f.page.rendered = { challenge: true, text: 'private login QR' };
  const first = await session.navigate('https://www.douyin.com/');
  assert.equal(first.status, 'login_required'); assert.equal(first.image, undefined); assert.equal(first.observation.text, '');
  assert.equal(f.page.calls.filter(call => call[0] === 'screenshot').length, 0);
  f.page.rendered = { text: 'safe page' }; f.page.onScreenshot = () => { f.page.rendered.challenge = true; };
  const second = await session.snapshot(); assert.equal(second.status, 'login_required'); assert.equal(second.image, undefined); assert.equal(second.observation.links.length, 0);
  assert.equal(second.receipt.screenshotSha256, undefined);
});

test('manual login is visible, same owner profile, and never reads DOM or captures pixels', async t => {
  const f = await fixture(t);
  await assert.rejects(f.open({ loginMode: true }), { code: 'owner_browser_login_requires_visible_window' });
  const session = await f.open({ loginMode: true, headless: false });
  const result = await session.navigate('https://www.douyin.com/login'); assert.equal(result.status, 'login_required');
  await session.snapshot(); await session.scroll({ direction: 'down', pixels: 10 }); await session.wait(0);
  assert.equal(f.launches[0].options.headless, false);
  assert.equal(f.page.calls.some(call => ['evaluate', 'screenshot', 'wheel'].includes(call[0])), false);
  assert.equal((await f.context.dispatch('https://www.douyin.com/login', { navigation: true, method: 'POST' })).continued, true);
});

test('scroll and wait bounds cannot become arbitrary evaluation or unbounded operations', async t => {
  const f = await fixture(t); const session = await f.open(); await session.navigate('https://www.douyin.com/');
  const result = await session.scroll({ direction: 'up', pixels: 450 }); assert.equal(result.receipt.action, 'scroll');
  assert.deepEqual(f.page.calls.find(call => call[0] === 'wheel'), ['wheel', 0, -450]);
  for (const args of [{ direction: 'left', pixels: 4 }, { direction: 'down', pixels: 901 }, { direction: 'down', pixels: -1 }]) await assert.rejects(session.scroll(args), { code: 'owner_browser_invalid_scroll' });
  for (const ms of [-1, 3001, 'script', 0.5]) await assert.rejects(session.wait(ms), { code: 'owner_browser_invalid_wait' });
  assert.equal((await session.wait(0)).receipt.action, 'wait');
});

test('owner binding is checked asynchronously before and after actions; changed binding closes owned context', async t => {
  let current = true; const f = await fixture(t); const session = await f.open({ isCurrent: async () => current });
  await session.navigate('https://www.douyin.com/'); current = false;
  await assert.rejects(session.snapshot(), { code: 'owner_browser_owner_binding_changed' });
  assert.equal(f.context.closed, 1); assert.equal(f.runtime.active, null);
});

test('binding change during capture discards all late evidence', async t => {
  let current = true; const f = await fixture(t); const session = await f.open({ isCurrent: async () => current });
  f.page.onScreenshot = () => { current = false; };
  await assert.rejects(session.navigate('https://www.douyin.com/'), { code: 'owner_browser_owner_binding_changed' });
  assert.equal(f.context.closed, 1);
});

test('cancellation closes active navigation; no late receipt and queue stays cancelled', async t => {
  const f = await fixture(t); const controller = new AbortController(); const session = await f.open({ signal: controller.signal });
  f.page.gotoGate = deferred(); const work = session.navigate('https://www.douyin.com/');
  while (!f.page.calls.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(work, { code: 'owner_browser_cancelled' }); await session.close();
  await assert.rejects(session.snapshot(), { code: 'owner_browser_cancelled' }); assert.equal(f.context.closed, 1);
});

test('cancellation while launching closes late context and releases lock only after launch settles', async t => {
  const gate = deferred(); const entered = deferred(); const lateContext = new FakeContext();
  const f = await fixture(t, { chromium: { launchPersistentContext: async () => { entered.resolve(); await gate.promise; return lateContext; } } });
  const controller = new AbortController(); const pending = f.open({ signal: controller.signal });
  const lockPath = path.join(f.root, 'data', 'owner_browser', 'active.lock');
  await entered.promise;
  controller.abort(); await assert.rejects(f.open(), { code: 'owner_browser_busy' });
  gate.resolve(); await assert.rejects(pending, { code: 'owner_browser_cancelled' });
  assert.equal(lateContext.closed, 1); assert.equal(f.runtime.active, null); await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('one active owner session, process lock and binary integrity prevent borrowed or competing profiles', async t => {
  const f = await fixture(t); const session = await f.open();
  await assert.rejects(f.open({ ownerId: 'another-owner' }), { code: 'owner_browser_busy' });
  const other = new OwnerBrowser({ root: f.root, executablePath: f.executablePath, executableSha256: digest('fake-binary-never-executed'), chromium: { launchPersistentContext: () => assert.fail('must not launch') } });
  await assert.rejects(other.open({ ownerId: 'another-owner', jobId: 'another-job' }), { code: 'owner_browser_profile_locked' });
  await session.close();
  await fs.writeFile(f.executablePath, 'tampered'); await assert.rejects(f.open(), { code: 'owner_browser_binary_hash_mismatch' });
});

test('a math headless shell is not accepted as the owner account browser', async t => {
  const f = await fixture(t); const headless = path.join(f.root, 'runtime', 'chrome-headless-shell.exe'); await fs.writeFile(headless, 'fake-binary-never-executed');
  f.runtime.executablePath = headless; await assert.rejects(f.open(), { code: 'owner_browser_full_binary_required' }); assert.equal(f.launches.length, 0);
});

test('unknown/oversized screenshot bytes and concurrent navigation cannot become evidence', async t => {
  const f = await fixture(t); const session = await f.open(); f.page.image = Buffer.from('not png');
  let result = await session.navigate('https://www.douyin.com/'); assert.equal(result.status, 'page_unavailable'); assert.equal(result.image, undefined);
  f.page.image = PNG; f.page.onScreenshot = () => { f.page.currentUrl = 'https://www.douyin.com/video/new'; f.page.emit('framenavigated', f.page.frame); };
  result = await session.snapshot(); assert.equal(result.reason, 'page_changed'); assert.equal(result.image, undefined);
});

test('a stalled renderer has a bounded read timeout and closes its context', async t => {
  const f = await fixture(t, { observationTimeoutMs: 1000 }); const session = await f.open();
  f.page.evaluate = () => new Promise(() => {});
  await assert.rejects(session.navigate('https://www.douyin.com/'), { code: 'owner_browser_observation_timeout' });
  assert.equal(f.context.closed, 1); assert.equal(f.runtime.active, null);
});

test('abort interrupts a renderer evaluation without waiting for its timeout', async t => {
  const f = await fixture(t); const controller = new AbortController(); const session = await f.open({ signal: controller.signal });
  const entered = deferred(); f.page.evaluate = () => { entered.resolve(); return new Promise(() => {}); };
  const pending = session.navigate('https://www.douyin.com/'); await entered.promise; controller.abort();
  await assert.rejects(pending, { code: 'owner_browser_cancelled' }); assert.equal(f.context.closed, 1);
});

test('blank prehydration and loader-only pages never produce successful browsing evidence', async t => {
  const f = await fixture(t); const session = await f.open(); f.page.image = screenshotPng(false);
  for (const text of ['', '加载中…', 'Loading...', '推荐\n精选\n关注\n朋友\n我的\n搜索']) {
    f.page.rendered = { text, contentText: text, media: [] };
    const result = await session.navigate('https://www.douyin.com/');
    assert.equal(result.status, 'page_unavailable'); assert.equal(result.reason, 'page_loading');
    assert.equal(result.image, undefined); assert.equal(result.observation.text, ''); assert.equal(result.observation.links.length, 0);
    assert.equal(result.receipt.screenshotSha256, undefined); assert.equal(result.receipt.textSha256, undefined);
  }
  assert.equal(f.page.calls.some(call => call[0] === 'screenshot'), false);
});

test('navigation waits boundedly for meaningful hydrated text, then takes actual observation', async t => {
  const f = await fixture(t, { renderReadyTimeoutMs: 1000 }); const session = await f.open();
  const evaluate = f.page.evaluate.bind(f.page); let reads = 0;
  f.page.evaluate = async (...args) => { f.page.rendered = ++reads < 2 ? { text: '加载中…', contentText: '' } : { text: '这是异步渲染后的实际视频说明', contentText: '这是异步渲染后的实际视频说明' }; return evaluate(...args); };
  const result = await session.navigate('https://www.douyin.com/');
  assert.equal(result.status, 'observed'); assert.equal(result.observation.text, '这是异步渲染后的实际视频说明');
  assert.equal(f.page.calls.filter(call => call[0] === 'screenshot').length, 1); assert.ok(reads >= 3);
});

test('hydration wait expires as page_loading and remains cancellable', async t => {
  const f = await fixture(t, { renderReadyTimeoutMs: 60 }); const controller = new AbortController(); const session = await f.open({ signal: controller.signal });
  f.page.rendered = { text: '', contentText: '', media: [] };
  let result = await session.navigate('https://www.douyin.com/'); assert.equal(result.reason, 'page_loading');
  f.runtime.renderReadyTimeoutMs = 1000;
  const work = session.navigate('https://www.douyin.com/'); setTimeout(() => controller.abort(), 20);
  await assert.rejects(work, { code: 'owner_browser_cancelled' });
});

test('media dimensions or blank pixels do not qualify; decoded visible media with actual detail can', async t => {
  const f = await fixture(t); const session = await f.open(); f.page.rendered = { text: '', contentText: '', media: MEDIA };
  f.page.image = screenshotPng(false);
  assert.equal(ownerScreenshotHasMediaDetail(f.page.image, MEDIA), false);
  let result = await session.navigate('https://www.douyin.com/'); assert.equal(result.reason, 'page_loading'); assert.equal(result.image, undefined);
  f.page.image = screenshotPng(true); assert.equal(ownerScreenshotHasMediaDetail(f.page.image, MEDIA), true);
  result = await session.snapshot(); assert.equal(result.status, 'observed'); assert.equal(result.observation.text, ''); assert.equal(result.receipt.screenshotSha256, digest(f.page.image));
  f.page.rendered.media = [{ ...MEDIA[0], decoded: false }]; result = await session.snapshot(); assert.equal(result.reason, 'page_loading');
});

test('login challenge appearing during hydration returns no screenshot or observations', async t => {
  const f = await fixture(t, { renderReadyTimeoutMs: 1000 }); const session = await f.open();
  const evaluate = f.page.evaluate.bind(f.page); let reads = 0;
  f.page.evaluate = async (...args) => { f.page.rendered = ++reads === 1 ? { text: '', contentText: '' } : { challenge: true, text: '扫码登录' }; return evaluate(...args); };
  const result = await session.navigate('https://www.douyin.com/'); assert.equal(result.status, 'login_required'); assert.equal(result.image, undefined);
  assert.equal(result.observation.text, ''); assert.equal(f.page.calls.some(call => call[0] === 'screenshot'), false);
});

test('content disappearing or a login challenge arriving after media capture discards PNG', async t => {
  const f = await fixture(t); const session = await f.open(); f.page.image = screenshotPng(true);
  f.page.rendered = { text: '', contentText: '', media: MEDIA }; f.page.onScreenshot = () => { f.page.rendered = { text: '', contentText: '', media: [] }; };
  let result = await session.navigate('https://www.douyin.com/'); assert.equal(result.reason, 'page_loading'); assert.equal(result.image, undefined);
  f.page.rendered = { text: '', contentText: '', media: MEDIA }; f.page.onScreenshot = () => { f.page.rendered.challenge = true; };
  result = await session.snapshot(); assert.equal(result.status, 'login_required'); assert.equal(result.image, undefined); assert.equal(result.receipt.screenshotSha256, undefined);
});
