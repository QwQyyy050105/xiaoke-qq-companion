import {isAbsolute as isPortableAbsolute} from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { isPublicMediaAddress } from './safe_media_fetch.mjs';

const DEFAULT_ORIGINS = ['https://www.douyin.com', 'https://v.douyin.com'];
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const SENSITIVE_KEY = /(?:pass(?:word|wd)?|secret|token|authorization|auth[_-]?code|cookie|session|credential|api[_-]?key|ticket|signature|verify[_-]?code)/i;
const WRITE_PATH = /(?:^|\/)(?:logout|logoff|signout|delete|remove|unfollow|follow|like|unlike|digg|undigg|purchase|checkout|buy|subscribe|unsubscribe|publish|send|vote|report)(?:\/|$)|\/(?:comment|favorite|collect|friend|message|cart|order)\/(?:create|add|submit|delete|remove|send|update)|\/(?:commit|create|update)\/(?:comment|follow|digg|favorite|order)/i;
const LOGIN_PATH = /(?:^|\/)(?:login|signin|passport|oauth|authorize|captcha|challenge)(?:\/|$)/i;
const WRITE_QUERY = /^(?:action|operation|op|method)$/i;
const WRITE_VALUE = /^(?:delete|remove|follow|unfollow|like|unlike|buy|purchase|pay|checkout|send|publish|logout|logoff|subscribe|unsubscribe|vote|report)$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const abortError = () => failure('owner_browser_cancelled');
const isInside = (root, target) => target !== root && !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target));

/** URLs are evidence labels, never a place to expose credentials or tracking tokens. */
export function sanitizeOwnerBrowserUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE_KEY.test(key) || /^(?:code|state)$/i.test(key)) url.searchParams.delete(key);
    return url.href.slice(0, 4096);
  } catch { return ''; }
}

function cleanText(value, limit) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/https?:\/\/[^\s<>"']+/gi, url => sanitizeOwnerBrowserUrl(url)).slice(0, limit);
}

const LOADER_TEXT = /^(?:加载中|正在加载|努力加载|请稍候|请稍等|正在打开|页面加载中|loading|please wait|just a moment|loading content)[\s.。…!！]*$/i;
const CHROME_TEXT = /^(?:抖音|首页|推荐|精选|关注|朋友|我的|直播|搜索|登录|注册|消息|设置|帮助|更多|刷新|返回|home|search|menu|log in|sign in|settings|back|next)$/i;
function meaningfulRenderedText(snapshot) {
  const parts = String(snapshot.contentText ?? snapshot.text ?? '').split(/\n/).map(value => value.trim()).filter(value => value && !LOADER_TEXT.test(value) && !CHROME_TEXT.test(value));
  return parts.join('').replace(/[^\p{L}\p{N}]/gu, '').length >= 8;
}

/** Inspect actual captured pixels for media-only pages; loaded dimensions alone are not evidence. */
export function ownerScreenshotHasMediaDetail(png, media, viewport = VIEWPORT) {
  try {
    if (!Buffer.isBuffer(png) || png.length > 4 * 1024 * 1024 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
    let width, height, channels, ended = false; const chunks = [];
    for (let offset = 8; offset + 12 <= png.length;) {
      const length = png.readUInt32BE(offset); if (length > png.length - offset - 12) return false;
      const type = png.toString('ascii', offset + 4, offset + 8); const data = png.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        if (offset !== 8 || length !== 13 || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) return false;
        width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3;
      } else if (type === 'IDAT') chunks.push(data);
      else if (type === 'IEND') { ended = true; break; }
      offset += length + 12;
    }
    if (!ended || !width || !height || width * height > 2_000_000 || !channels || !chunks.length) return false;
    const stride = width * channels; const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
    if (raw.length !== (stride + 1) * height) return false;
    const pixels = Buffer.alloc(stride * height);
    const paeth = (a, b, c) => { const p = a + b - c; const aa = Math.abs(p - a), bb = Math.abs(p - b), cc = Math.abs(p - c); return aa <= bb && aa <= cc ? a : bb <= cc ? b : c; };
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]; if (filter > 4) return false;
      for (let x = 0; x < stride; x++) {
        const index = y * stride + x, a = x >= channels ? pixels[index - channels] : 0, b = y ? pixels[index - stride] : 0, c = y && x >= channels ? pixels[index - stride - channels] : 0;
        const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
        pixels[index] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
      }
    }
    for (const item of (media || []).slice(0, 8)) {
      if (!item?.decoded || !['image', 'video'].includes(item.kind)) continue;
      const rect = item.rect; if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 48 || rect.height < 48) continue;
      const left = Math.max(0, Math.floor(rect.x * width / viewport.width)), top = Math.max(0, Math.floor(rect.y * height / viewport.height));
      const right = Math.min(width, Math.ceil((rect.x + rect.width) * width / viewport.width)), bottom = Math.min(height, Math.ceil((rect.y + rect.height) * height / viewport.height));
      if (right - left < 48 || bottom - top < 48) continue;
      const bins = new Map(); let count = 0, minimum = 255, maximum = 0;
      for (let y = top; y < bottom; y += Math.max(1, Math.floor((bottom - top) / 48))) for (let x = left; x < right; x += Math.max(1, Math.floor((right - left) / 48))) {
        const index = (y * width + x) * channels; if (channels === 4 && pixels[index + 3] < 32) continue;
        const [r, g, b] = pixels.subarray(index, index + 3); const bin = `${r >> 4}:${g >> 4}:${b >> 4}`;
        bins.set(bin, (bins.get(bin) || 0) + 1); count++; minimum = Math.min(minimum, r, g, b); maximum = Math.max(maximum, r, g, b);
      }
      if (count >= 100 && bins.size >= 3 && maximum - minimum >= 32 && Math.max(...bins.values()) / count <= 0.98) return true;
    }
    return false;
  } catch { return false; }
}

/** Server-controlled policy. Never accept origins or executable paths from a model call. */
export function validateOwnerBrowserUrl(raw, { allowedOrigins = DEFAULT_ORIGINS, navigation = true, loginMode = false } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) throw failure('owner_browser_invalid_url');
  let url; try { url = new URL(raw); } catch { throw failure('owner_browser_invalid_url'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw failure('owner_browser_url_not_allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !net.isIP(host)) throw failure('owner_browser_private_address');
  if (net.isIP(host) && !isPublicMediaAddress(host)) throw failure('owner_browser_private_address');
  if (navigation && !new Set(allowedOrigins).has(url.origin)) throw failure('owner_browser_origin_not_allowed');
  let decodedPath = url.pathname; try { decodedPath = decodeURIComponent(decodedPath); } catch { throw failure('owner_browser_invalid_url'); }
  if (WRITE_PATH.test(decodedPath) || [...url.searchParams].some(([key, value]) => WRITE_QUERY.test(key) && WRITE_VALUE.test(value))) throw failure('owner_browser_write_action_blocked');
  if (navigation && !loginMode && (LOGIN_PATH.test(decodedPath) || [...url.searchParams.keys()].some(key => SENSITIVE_KEY.test(key) || /^(?:code|state)$/i.test(key)))) throw failure('owner_browser_login_or_secret_url');
  url.hash = '';
  return url;
}

async function withTimeout(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function verifyPublicDns(url, lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await withTimeout(lookup(host, { all: true, verbatim: true }), 5000, 'owner_browser_dns_timeout');
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(item => !isPublicMediaAddress(item.address))) throw failure('owner_browser_private_address');
}

async function checkedDirectory(root, dir) {
  if (!isInside(root, dir)) throw failure('owner_browser_storage_outside_root');
  // Check each existing ancestor before mkdir; an intermediate junction must not create data on C.
  let ancestor = dir;
  while (true) {
    try { const real = await fs.realpath(ancestor); if (real !== root && !isInside(root, real)) throw failure('owner_browser_storage_outside_root'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  await fs.mkdir(dir, { recursive: true });
  const actual = await fs.realpath(dir);
  if (!isInside(root, actual) || !isPortableAbsolute(actual)) throw failure('owner_browser_storage_outside_root');
  return actual;
}

async function fileHash(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

/** Only ordinary Windows runtime variables are forwarded, never app pipes, keys, or session env. */
function browserEnvironment(tempDir, localDir) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  return { SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    PATH: `${path.join(systemRoot, 'System32')};${systemRoot}`, TEMP: tempDir, TMP: tempDir,
    LOCALAPPDATA: localDir, APPDATA: localDir, USERPROFILE: localDir };
}

// This fixed function executes in the rendered page. Model input is never evaluated as JavaScript.
async function readRenderedPage({ maxText, maxLinks }) {
  const visible = element => {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
      && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
      && (typeof element.checkVisibility !== 'function' || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const challengeText = /扫码.{0,8}(?:登录|登陆)|扫描二维码|(?:请|进行|完成).{0,8}(?:安全验证|身份验证|人机验证)|拖动.{0,8}滑块|短信验证码|验证码登录|手机验证码|scan.{0,15}(?:qr|log\s?in)|verify.{0,15}(?:human|identity)|sign in to continue/i;
  const body = document.body;
  const bodyText = body?.innerText || '';
  const challenge = challengeText.test(bodyText.slice(0, 80000)) || [...document.querySelectorAll('input[type="password"],iframe[src]')].some(element => visible(element) && (element.matches('input') || /(?:captcha|challenge|passport|qrlogin)/i.test(element.getAttribute('src') || '')))
    || [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],form')].some(element => visible(element) && /登录|登陆|log\s?in|sign\s?in|验证码/i.test(element.innerText || ''));
  if (challenge) return { challenge: true };
  const chunks = []; const content = []; let length = 0; let truncated = false;
  if (body) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode; const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,[contenteditable="true"],[hidden],[aria-hidden="true"]') || !visible(parent)) continue;
      const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const kept = text.slice(0, Math.max(0, maxText - length)); chunks.push(kept);
      if (!parent.closest('nav,header,footer,aside,button,[role="navigation"],[role="menu"],[role="tablist"],[role="button"],[role="progressbar"],[aria-busy="true"]')
        && !/(?:loading|skeleton|spinner|placeholder)/i.test(String(parent.className || ''))) content.push(kept);
      if (length + text.length + 1 > maxText) { truncated = true; break; }
      length += text.length + 1;
    }
  }
  const links = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (!visible(anchor)) continue;
    const text = (anchor.innerText || anchor.getAttribute('aria-label') || anchor.title || '').replace(/\s+/g, ' ').trim();
    if (text) links.push({ text: text.slice(0, 160), url: anchor.href });
    if (links.length >= maxLinks) break;
  }
  const media = [];
  for (const element of document.querySelectorAll('img,video')) {
    if (media.length >= 8) break;
    if (!visible(element) || element.closest('nav,header,footer,aside,button,[role="progressbar"],[aria-busy="true"]')
      || /(?:loading|spinner|skeleton|placeholder|logo|icon)/i.test(`${element.className || ''} ${element.getAttribute('alt') || ''}`)) continue;
    const rect = element.getBoundingClientRect(); if (rect.width < 48 || rect.height < 48) continue;
    let decoded = false;
    if (element.tagName === 'IMG' && element.complete && element.naturalWidth > 0) {
      try { await element.decode(); decoded = true; } catch { /* Broken or undecodable images are not visible content. */ }
    } else if (element.tagName === 'VIDEO') decoded = element.readyState >= 2 && element.videoWidth > 0;
    if (decoded) media.push({ kind: element.tagName === 'IMG' ? 'image' : 'video', decoded,
      rect: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: Math.min(innerWidth, rect.right) - Math.max(0, rect.left), height: Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top) } });
  }
  return { challenge: false, url: location.href, title: document.title, text: chunks.join('\n'), contentText: content.join('\n'), truncated, links, media };
}

export class OwnerBrowser {
  constructor({ root, executablePath, executableSha256, allowedOrigins = DEFAULT_ORIGINS, chromium = null, lookup = dns.lookup, now = () => new Date(), navigationTimeoutMs = 20000, observationTimeoutMs = 10000, renderReadyTimeoutMs = 8000 } = {}) {
    this.root = path.resolve(String(root || ''));
    this.executablePath = path.resolve(String(executablePath || ''));
    this.executableSha256 = String(executableSha256 || '').toLowerCase();
    this.allowedOrigins = [...new Set(allowedOrigins)].map(origin => { const url = new URL(origin); if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw failure('owner_browser_invalid_origin'); return origin; });
    this.chromium = chromium; this.lookup = lookup; this.now = now;
    this.navigationTimeoutMs = Math.min(30000, Math.max(1000, Number(navigationTimeoutMs) || 20000));
    this.observationTimeoutMs = Math.min(15000, Math.max(1000, Number(observationTimeoutMs) || 10000));
    this.renderReadyTimeoutMs = Math.min(10000, Math.max(0, Number(renderReadyTimeoutMs) || 0));
    this.active = null;
  }

  async open({ ownerId, jobId, signal, isCurrent = () => true, headless = true, loginMode = false } = {}) {
    if (![ownerId, jobId].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512)) throw failure('owner_browser_identity_required');
    if (loginMode && headless) throw failure('owner_browser_login_requires_visible_window');
    if (this.active) throw failure('owner_browser_busy');
    const session = new OwnerBrowserSession(this, { ownerId, jobId, signal, isCurrent, headless, loginMode });
    this.active = session;
    try { await session.initialize(); session.initializing = false; await session.ensureCurrent(); return session; }
    catch (error) { session.initializing = false; await session.close(); await session.releaseResources(); throw error; }
  }
}

export class OwnerBrowserSession {
  constructor(runtime, { ownerId, jobId, signal, isCurrent, headless, loginMode }) {
    this.runtime = runtime; this.ownerHash = hash(ownerId); this.jobHash = hash(jobId);
    this.signal = signal; this.isCurrent = isCurrent; this.headless = headless; this.loginMode = loginMode;
    this.leaseId = randomUUID(); this.closed = false; this.closing = null; this.initializing = true; this.context = null; this.page = null;
    this.links = new Map(); this.pageVersion = 0; this.navigationGeneration = 0; this.queue = Promise.resolve();
    this.abortHandler = () => { void this.close(); };
    signal?.addEventListener('abort', this.abortHandler, { once: true });
  }

  async ensureCurrent() {
    if (this.closed || this.signal?.aborted) throw abortError();
    if (!await this.isCurrent()) { await this.close(); throw failure('owner_browser_owner_binding_changed'); }
    if (this.closed || this.signal?.aborted) throw abortError();
  }

  async initialize() {
    await this.ensureCurrent();
    const runtime = this.runtime;
    runtime.root = await fs.realpath(runtime.root);
    if (!isPortableAbsolute(runtime.root)) throw failure('owner_browser_requires_d_storage');
    const executable = await fs.realpath(runtime.executablePath);
    if (!isInside(runtime.root, executable) || !isPortableAbsolute(executable) || /headless[-_]shell/i.test(executable) || !/^(?:chrome|chromium|msedge)\.exe$/i.test(path.basename(executable))) throw failure('owner_browser_full_binary_required');
    if (!/^[a-f0-9]{64}$/.test(runtime.executableSha256) || await fileHash(executable) !== runtime.executableSha256) throw failure('owner_browser_binary_hash_mismatch');
    await this.ensureCurrent();
    const base = await checkedDirectory(runtime.root, path.join(runtime.root, 'data', 'owner_browser'));
    this.profileDir = await checkedDirectory(runtime.root, path.join(base, 'profiles', this.ownerHash));
    const tempDir = await checkedDirectory(runtime.root, path.join(runtime.root, 'temp', 'owner_browser'));
    const localDir = await checkedDirectory(runtime.root, path.join(base, 'local_runtime'));
    this.lockPath = path.join(base, 'active.lock');
    await this.acquireLock();
    await this.ensureCurrent();
    let context;
    try {
      const chromium = runtime.chromium || (await import('playwright-core')).chromium;
      await this.ensureCurrent();
      context = await chromium.launchPersistentContext(this.profileDir, {
        executablePath: executable, headless: this.headless, viewport: VIEWPORT,
        javaScriptEnabled: true, serviceWorkers: 'block', acceptDownloads: false,
        permissions: [], bypassCSP: false, ignoreHTTPSErrors: false,
        env: browserEnvironment(tempDir, localDir), timeout: 30000,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking', '--disable-default-apps', '--disable-features=DnsOverHttps,MediaRouter', '--dns-over-https-mode=off', '--disable-gpu', `--disk-cache-dir=${path.join(this.profileDir, 'cache')}`, `--crash-dumps-dir=${path.join(this.profileDir, 'crashes')}`]
      });
    } catch { throw failure('owner_browser_launch_failed'); }
    this.context = context;
    if (this.closed || this.signal?.aborted) { await context.close().catch(() => {}); throw abortError(); }
    await this.ensureCurrent();
    context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(runtime.navigationTimeoutMs);
    // Chromium still resolves DNS independently. These checks constrain browser requests but are
    // not advertised as a network sandbox or a complete defense against DNS rebinding.
    await context.route('**/*', route => this.routeRequest(route));
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => this.routeWebSocket(socket));
    const pages = context.pages();
    this.page = pages[0] || await context.newPage();
    for (const extra of pages.slice(1)) await extra.close().catch(() => {});
    context.on('page', page => { if (page !== this.page) void page.close().catch(() => {}); });
    this.page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    this.page.on('download', download => { void download.cancel().catch(() => {}); });
    this.page.on('framenavigated', frame => { if (frame === this.page.mainFrame()) { this.navigationGeneration++; this.invalidateLinks(); } });
    this.page.on('close', () => { if (!this.closed) void this.close(); });
    await this.ensureCurrent();
  }

  async acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle;
      try {
        handle = await fs.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, leaseId: this.leaseId, ownerHash: this.ownerHash, jobHash: this.jobHash }));
        await handle.sync(); this.hasLock = true; return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let old; try { old = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); } catch { throw failure('owner_browser_profile_locked'); }
        if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.leaseId !== 'string') throw failure('owner_browser_profile_locked');
        try { process.kill(old.pid, 0); throw failure('owner_browser_profile_locked'); }
        catch (check) { if (check.code !== 'ESRCH') throw failure('owner_browser_profile_locked'); }
        const still = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
        if (still.leaseId !== old.leaseId) throw failure('owner_browser_profile_locked');
        await fs.unlink(this.lockPath);
      } finally { await handle?.close(); }
    }
    throw failure('owner_browser_profile_locked');
  }

  async routeRequest(route) {
    try {
      await this.ensureCurrent();
      const request = route.request();
      const topNavigation = request.isNavigationRequest() && (!request.frame().parentFrame());
      const url = validateOwnerBrowserUrl(request.url(), { allowedOrigins: this.runtime.allowedOrigins, navigation: topNavigation, loginMode: this.loginMode });
      if (topNavigation && !this.loginMode && !['GET', 'HEAD'].includes(request.method())) throw failure('owner_browser_navigation_method_blocked');
      // Website read APIs may use POST. No model-controlled POST or button/form API is exposed.
      // Known account mutation endpoints remain blocked for both ordinary and manual-login sessions.
      await verifyPublicDns(url, this.runtime.lookup);
      await this.ensureCurrent();
      await route.continue();
    } catch { await route.abort('blockedbyclient').catch(() => {}); }
  }

  async routeWebSocket(socket) {
    try {
      await this.ensureCurrent();
      const raw = new URL(socket.url());
      if (!['ws:', 'wss:'].includes(raw.protocol)) throw failure('owner_browser_url_not_allowed');
      raw.protocol = raw.protocol === 'wss:' ? 'https:' : 'http:';
      const url = validateOwnerBrowserUrl(raw.href, { navigation: false, loginMode: this.loginMode });
      await verifyPublicDns(url, this.runtime.lookup); await this.ensureCurrent();
      // Forward the site's ordinary connection without inspecting credential/message payloads.
      socket.connectToServer();
    } catch { await socket.close({ code: 1008, reason: 'request_not_allowed' }).catch(() => {}); }
  }

  invalidateLinks() { this.pageVersion++; this.links.clear(); this.linkPageUrl = ''; }

  run(action, operation) {
    const task = this.queue.then(async () => {
      await this.ensureCurrent();
      try { return await operation(); }
      catch (error) {
        if (this.closed || this.signal?.aborted || error.code === 'owner_browser_owner_binding_changed') throw error;
        // Errors are structured; do not leak Chromium output, URLs with tokens, or page contents.
        if (error.code?.startsWith('owner_browser_')) throw error;
        throw failure(`owner_browser_${action}_failed`);
      }
    });
    this.queue = task.catch(() => {}); return task;
  }

  navigate(url) { return this.run('navigate', () => this.navigateAndObserve(url, 'navigate')); }
  snapshot() { return this.run('snapshot', () => this.observe('snapshot')); }
  follow(linkId) {
    return this.run('follow', async () => {
      if (typeof linkId !== 'string' || !this.links.has(linkId) || this.page.url() !== this.linkPageUrl) throw failure('owner_browser_stale_link');
      const url = this.links.get(linkId); return this.navigateAndObserve(url, 'follow');
    });
  }
  scroll({ direction = 'down', pixels = 600 } = {}) {
    return this.run('scroll', async () => {
      if (!['up', 'down'].includes(direction) || !Number.isInteger(pixels) || pixels < 1 || pixels > 900) throw failure('owner_browser_invalid_scroll');
      if (!this.loginMode) await this.page.mouse.wheel(0, direction === 'down' ? pixels : -pixels);
      await this.ensureCurrent(); return this.observe('scroll');
    });
  }
  wait(ms = 500) {
    return this.run('wait', async () => {
      if (!Number.isInteger(ms) || ms < 0 || ms > 3000) throw failure('owner_browser_invalid_wait');
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(abortError()); };
        const timer = setTimeout(() => { this.signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        this.signal?.addEventListener('abort', onAbort, { once: true });
        if (this.signal?.aborted) onAbort();
      });
      await this.ensureCurrent(); return this.observe('wait');
    });
  }

  async navigateAndObserve(raw, action) {
    const url = validateOwnerBrowserUrl(raw, { allowedOrigins: this.runtime.allowedOrigins, loginMode: this.loginMode });
    await verifyPublicDns(url, this.runtime.lookup); await this.ensureCurrent(); this.invalidateLinks();
    let response;
    try { response = await this.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: this.runtime.navigationTimeoutMs }); }
    catch { await this.ensureCurrent(); return this.unavailable(action, 'navigation_failed'); }
    await this.ensureCurrent();
    return this.observe(action, response?.status?.(), this.runtime.renderReadyTimeoutMs);
  }

  baseResult(action, status, observation, extra = {}) {
    return { status, observation, receipt: { id: randomUUID(), action, observedAt: this.runtime.now().toISOString(), ownerHash: this.ownerHash, jobHash: this.jobHash, pageVersion: this.pageVersion, status, url: observation.url, ...extra } };
  }

  async unavailable(action, reason, status = 'page_unavailable') {
    this.invalidateLinks(); await this.ensureCurrent();
    const observation = { url: sanitizeOwnerBrowserUrl(this.page?.url()), title: '', text: '', truncated: false, links: [], pageVersion: this.pageVersion, viewport: VIEWPORT };
    return { ...this.baseResult(action, status, observation), reason };
  }

  async observe(action, httpStatus, renderWaitMs = 0) {
    this.invalidateLinks();
    if (this.loginMode) return this.unavailable(action, 'interactive_login', 'login_required');
    const startUrl = this.page.url();
    let actual;
    try { actual = validateOwnerBrowserUrl(startUrl, { allowedOrigins: this.runtime.allowedOrigins }); await verifyPublicDns(actual, this.runtime.lookup); }
    catch (error) { return this.unavailable(action, error.code === 'owner_browser_login_or_secret_url' ? 'login_challenge' : 'page_not_allowed', error.code === 'owner_browser_login_or_secret_url' ? 'login_required' : 'page_unavailable'); }
    const generation = this.navigationGeneration;
    const deadline = Date.now() + renderWaitMs; let image, after;
    while (true) {
      const before = await this.readPage(); await this.ensureCurrent();
      if (before?.challenge) return this.unavailable(action, 'login_challenge', 'login_required');
      if (this.page.url() !== startUrl || this.navigationGeneration !== generation || before?.url !== startUrl) return this.unavailable(action, 'page_changed');
      if (meaningfulRenderedText(before) || before.media?.some(item => item.decoded)) {
        image = await this.page.screenshot({ type: 'png', fullPage: false, timeout: 10000 });
        // Recheck after capture. Auth dialogs and content disappearing during hydration are withheld.
        after = await this.readPage(); await this.ensureCurrent();
        if (after?.challenge) return this.unavailable(action, 'login_challenge', 'login_required');
        if (this.page.url() !== startUrl || this.navigationGeneration !== generation || after?.url !== startUrl) return this.unavailable(action, 'page_changed');
        if (!Buffer.isBuffer(image) || image.length < 8 || image.length > 4 * 1024 * 1024 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return this.unavailable(action, 'screenshot_size');
        if (meaningfulRenderedText(after) || ownerScreenshotHasMediaDetail(image, after.media)) break;
      }
      image = undefined;
      if (Date.now() >= deadline) return this.unavailable(action, 'page_loading');
      await this.renderPause(Math.min(250, deadline - Date.now()));
    }
    const links = [];
    for (const link of (after.links || []).slice(0, 60)) {
      try {
        const target = validateOwnerBrowserUrl(link.url, { allowedOrigins: this.runtime.allowedOrigins });
        const id = `${this.pageVersion}:${randomUUID().slice(0, 12)}`;
        const text = cleanText(link.text, 160); if (!text) continue;
        this.links.set(id, target.href); links.push({ id, text, url: sanitizeOwnerBrowserUrl(target.href) });
      } catch { /* Non-public, login, or action links are not model tools. */ }
    }
    this.linkPageUrl = startUrl;
    const observation = { url: sanitizeOwnerBrowserUrl(startUrl), title: cleanText(after.title, 300), text: cleanText(after.text, 12000), truncated: Boolean(after.truncated), links, pageVersion: this.pageVersion, viewport: VIEWPORT };
    const result = this.baseResult(action, 'observed', observation, { ...(Number.isInteger(httpStatus) ? { httpStatus } : {}), textSha256: hash(observation.text), screenshotSha256: hash(image) });
    await this.ensureCurrent();
    return { ...result, image: { bytes: image, mimeType: 'image/png' } };
  }

  async readPage() {
    let abortListener;
    try {
      const abort = new Promise((_, reject) => {
        abortListener = () => reject(abortError());
        this.signal?.addEventListener('abort', abortListener, { once: true });
        if (this.signal?.aborted) abortListener();
      });
      return await withTimeout(Promise.race([this.page.evaluate(readRenderedPage, { maxText: 12000, maxLinks: 60 }), abort]), this.runtime.observationTimeoutMs, 'owner_browser_observation_timeout');
    } catch (error) { await this.close(); throw error; }
    finally { this.signal?.removeEventListener('abort', abortListener); }
  }

  async renderPause(ms) {
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => { this.signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
      this.signal?.addEventListener('abort', abort, { once: true }); if (this.signal?.aborted) abort();
    });
    await this.ensureCurrent();
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.invalidateLinks(); this.signal?.removeEventListener('abort', this.abortHandler);
    this.closing = (async () => {
      await this.context?.close().catch(() => {});
      // A launch in flight still owns this lease. open() releases it after its late context closes.
      if (!this.initializing) await this.releaseResources();
    })();
    return this.closing;
  }

  async releaseResources() {
    if (this.hasLock) {
      try { const current = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); if (current.leaseId === this.leaseId) await fs.unlink(this.lockPath); }
      catch (error) { if (error.code !== 'ENOENT') this.closeError = 'owner_browser_lock_cleanup_failed'; }
      this.hasLock = false;
    }
    if (this.runtime.active === this) this.runtime.active = null;
  }
}
