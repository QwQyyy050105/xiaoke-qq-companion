import {isAbsolute as isPortableAbsolute} from 'node:path';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { durableWriteFile } from './durable_write.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const pending = new Set(['queued', 'running']);
const browserTools = new Set(['owner_browser_navigate', 'owner_browser_snapshot', 'owner_browser_scroll', 'owner_browser_follow', 'owner_browser_wait']);
const statuses = new Set(['queued', 'running', 'completed', 'awaiting_login', 'unavailable', 'failed', 'canceled', 'interrupted', 'expired', 'forgotten']);
const labels = { queued: '等待浏览', running: '正在浏览', completed: '浏览完成', awaiting_login: '等待你在独立浏览器登录', unavailable: '浏览暂不可用', failed: '浏览未完成', canceled: '已取消', interrupted: '上次浏览已中断，未自动重放', expired: '浏览任务已超时', forgotten: '已忘记这次浏览' };
const fault = code => Object.assign(new Error(code), { code });
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (base, file) => { const relative = path.relative(base, file); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const bounded = (value, max) => typeof value === 'string' && [...value].length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const idText = value => bounded(value, 256) && value.length > 0 && !/\s/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const secretValue = /-----BEGIN[^\r\n]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:app[_ -]?secret|api[_ -]?key|access[_ -]?token|password|密码|密钥|cookie|authorization)["']?\s*[:=：]\s*["']?\S+|\b[A-Za-z0-9_-]{48,}\b/i;
const credentialTask = /(?:密码|口令|验证码|密钥|私钥|登录凭据|cookies?|app[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|passwords?|credentials?|session[_ -]?(?:id|token)|localstorage|sessionstorage)/i;
const cleanupErrors = new Set(['stdin_eof_failed', 'stdout_close_failed', 'stderr_close_failed', 'process_shutdown_error', 'process_kill_rejected', 'process_kill_failed', 'stdio_close_unconfirmed', 'process_exit_unconfirmed', 'local_stream_cleanup_failed', 'local_process_unref_failed']);
function cleanupMetadata(value) {
  if (!object(value) || !['graceful', 'forced', 'unconfirmed', 'not_started'].includes(value.appServer?.status)
    || !['closed', 'failed', 'unconfirmed', 'not_opened', 'cancellation_pending'].includes(value.browser?.status)
    || !['removed', 'retained', 'not_created'].includes(value.tempDirectory?.status)) return undefined;
  const appServer = { status: value.appServer.status };
  for (const field of ['stdinEnded', 'exitObserved', 'closeObserved', 'forceAttempted']) if (typeof value.appServer[field] === 'boolean') appServer[field] = value.appServer[field];
  if (value.appServer.exitCode === null || Number.isSafeInteger(value.appServer.exitCode) && Math.abs(value.appServer.exitCode) <= 0xffffffff) appServer.exitCode = value.appServer.exitCode;
  if (value.appServer.signal === null || ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGBREAK', 'SIGHUP', 'SIGABRT'].includes(value.appServer.signal)) appServer.signal = value.appServer.signal;
  if (Array.isArray(value.appServer.errors)) appServer.errors = [...new Set(value.appServer.errors.filter(code => cleanupErrors.has(code)))].slice(0, 10);
  const tempDirectory = { status: value.tempDirectory.status };
  if (['process_cleanup_unconfirmed', 'temp_cleanup_failed'].includes(value.tempDirectory.reason)) tempDirectory.reason = value.tempDirectory.reason;
  return { appServer, browser: { status: value.browser.status }, tempDirectory };
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || secretValue.test(url.pathname)) return ''; return url.origin + url.pathname; } catch { return ''; }
}
function safeText(value, max = 2000) {
  if (!bounded(value, 16000) || secretValue.test(value) || /<(?:html|body|input|script|div|form)\b/i.test(value)) return '';
  return [...value.replace(/https?:\/\/[^\s<>"'）]+/g, value => publicUrl(value) || '[链接已省略]')].slice(0, max).join('').trim();
}
function sensitiveUrl(text) {
  return (text.match(/https?:\/\/[^\s<>"']+/g) || []).some(value => {
    try { const url = new URL(value); return Boolean(url.username || url.password) || [...url.searchParams.keys()].some(key => /^(?:token|key|auth|authorization|secret|password|code|ticket|session|access_token|refresh_token|api_key)$/i.test(key)); }
    catch { return false; }
  });
}
function instruction(text) {
  if (typeof text !== 'string') return null;
  const command = text.trim().match(/^\/(browse|browsestatus|browsecancel)(?:\s+([\s\S]*))?$/i);
  if (command) return { command: command[1].toLowerCase(), argument: (command[2] || '').trim(), explicit: true };
  const natural = text.trim().replace(/^小柯[，,：:\s]*/, '');
  if (/^(?:(?:请|请你)?(?:帮我|替我)?(?:去抖音(?:看看|逛逛|刷一会儿?|浏览)|(?:打开|浏览|看看)(?:这个网页|这个页面|这个链接|网页|页面|链接)))/.test(natural)) {
    return { command: 'browse', argument: text.trim(), explicit: false };
  }
  return null;
}
function ownerEvent(event, owner) {
  const sender = event?.author?.user_openid ?? event?.author?.openid ?? event?.author?.id;
  return typeof owner === 'string' && owner.length > 0 && sender === owner && !event?.group_openid
    && (!event?.chat_type || event.chat_type === 'private') && !event?.is_self && !event?.author?.bot;
}
function originalDeadline(event, now) {
  const dates = [event?._receivedAt, Date.parse(event?.timestamp || '')].filter(value => Number.isFinite(value) && value > 0);
  if (!dates.length) return 0;
  // Arrival and QQ timestamps may shorten this window, but may never refresh it.
  return Math.min(...dates, now) + 3540000;
}
async function directory(base, parts, create = false) {
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (!inside(base, current)) throw fault('owner_browser_path_boundary');
    if (create) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(current), current)) throw fault('owner_browser_path_boundary');
  }
  return current;
}
async function readRecord(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 131072 || !samePath(await fs.realpath(file), file)) throw fault('owner_browser_record_invalid');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw fault('owner_browser_record_changed');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw fault('owner_browser_record_changed');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}
function validReceipt(receipt) {
  return object(receipt) && Object.keys(receipt).every(key => ['tool', 'callHash', 'receiptHash', 'threadHash', 'turnHash', 'ok', 'observed', 'url', 'title', 'observedAt', 'pageVersion', 'textSha256', 'screenshotSha256', 'artifact'].includes(key))
    && browserTools.has(receipt.tool) && HASH.test(receipt.callHash) && HASH.test(receipt.receiptHash)
    && [receipt.threadHash, receipt.turnHash].every(value => value === '' || HASH.test(value)) && typeof receipt.ok === 'boolean' && typeof receipt.observed === 'boolean'
    && (receipt.url === '' || receipt.url === publicUrl(receipt.url)) && bounded(receipt.title, 240) && receipt.title === safeText(receipt.title, 240)
    && integer(receipt.observedAt) && bounded(receipt.pageVersion, 128) && [receipt.textSha256, receipt.screenshotSha256].every(value => value === '' || HASH.test(value))
    && (!receipt.artifact || (object(receipt.artifact) && Object.keys(receipt.artifact).every(key => ['path', 'mimeType', 'sha256', 'size'].includes(key))
      && /^artifacts\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}\.(?:png|jpg|jpeg|webp)$/.test(receipt.artifact.path)
      && ['image/png', 'image/jpeg', 'image/webp'].includes(receipt.artifact.mimeType) && HASH.test(receipt.artifact.sha256) && integer(receipt.artifact.size) && receipt.artifact.size <= 5 * 1024 * 1024));
}
const proof = receipt => receipt.ok && receipt.observed && receipt.pageVersion && (receipt.textSha256 || receipt.screenshotSha256);
function validJob(job, id) {
  return object(job) && Object.keys(job).every(key => ['version', 'id', 'ownerHash', 'sourceHashes', 'taskHash', 'task', 'createdAt', 'updatedAt', 'expiresAt', 'deliveryDeadline', 'status', 'summary', 'receipts', 'observations', 'notification', 'cleanup'].includes(key))
    && job.version === 1 && job.id === id && UUID.test(id) && HASH.test(job.ownerHash) && HASH.test(job.taskHash)
    && Array.isArray(job.sourceHashes) && job.sourceHashes.length > 0 && job.sourceHashes.length <= 32 && job.sourceHashes.every(value => HASH.test(value))
    && bounded(job.task, 4000) && !secretValue.test(job.task) && !credentialTask.test(job.task) && bounded(job.summary, 4000) && job.summary === safeText(job.summary, 4000)
    && [job.createdAt, job.updatedAt, job.expiresAt, job.deliveryDeadline].every(integer) && job.expiresAt > job.createdAt && job.expiresAt - job.createdAt <= 1800000
    && (job.deliveryDeadline === 0 || job.deliveryDeadline <= job.createdAt + 3540000) && statuses.has(job.status)
    && Array.isArray(job.receipts) && job.receipts.length <= 24 && job.receipts.every(validReceipt)
    && Array.isArray(job.observations) && job.observations.length <= 8 && job.observations.every(value => object(value) && Object.keys(value).every(key => ['receiptHash', 'summary'].includes(key)) && HASH.test(value.receiptHash) && bounded(value.summary, 500) && value.summary === safeText(value.summary, 500) && job.receipts.some(receipt => receipt.receiptHash === value.receiptHash && proof(receipt)))
    && ['none', 'sending', 'sent', 'failed', 'uncertain', 'expired', 'suppressed'].includes(job.notification)
    && (job.status !== 'completed' || job.receipts.some(proof))
    && (job.cleanup === undefined || cleanupMetadata(job.cleanup) !== undefined && JSON.stringify(job.cleanup) === JSON.stringify(cleanupMetadata(job.cleanup)));
}

/** Durable owner-private orchestration. Browser I/O is injected and never run by this module. */
export class OwnerBrowserJobs {
  static async open(options) { const jobs = new OwnerBrowserJobs(options); await jobs.init(); return jobs; }
  constructor({ root, getOwner, runJob, notify = async () => ({ sent: false }), now = Date.now, save = durableWriteFile, log = () => {}, maxPending = 3, maxJobs = 100, timeoutMs = 180000, queueTtlMs = 600000, taskDedupeMs = 30000, ownerPollMs = 500 } = {}) {
    if (typeof root !== 'string' || !isPortableAbsolute(root) || !path.isAbsolute(root) || [getOwner, runJob, notify, now, save, log].some(value => typeof value !== 'function')
      || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 8 || !Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 100
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isInteger(queueTtlMs) || queueTtlMs < 1 || queueTtlMs > 1800000
      || !Number.isInteger(taskDedupeMs) || taskDedupeMs < 0 || taskDedupeMs > 60000 || !Number.isInteger(ownerPollMs) || ownerPollMs < 10 || ownerPollMs > 10000) throw fault('owner_browser_options_invalid');
    Object.assign(this, { root, getOwner, runJob, notify, now, save, log, maxPending, maxJobs, timeoutMs, queueTtlMs, taskDedupeMs, ownerPollMs });
    this.jobs = new Map(); this.envelopes = new Map(); this.commands = Promise.resolve(); this.writes = Promise.resolve(); this.active = null; this.draining = false; this.stopped = false; this.storageFailed = false; this.ownerHash = ''; this.polling = false;
  }
  async init() {
    if (!samePath(await fs.realpath(this.root), this.root)) throw fault('owner_browser_path_boundary');
    this.base = await directory(this.root, ['data', 'owner_browser', 'jobs'], true);
    const entries = await fs.readdir(this.base, { withFileTypes: true });
    if (entries.length > this.maxJobs) throw fault('owner_browser_capacity');
    for (const entry of entries) {
      if (!UUID.test(entry.name)) throw fault('owner_browser_record_invalid');
      const folder = await this.jobDirectory(entry.name), record = await readRecord(path.join(folder, 'job.json'));
      if (!validJob(record, entry.name)) throw fault('owner_browser_record_invalid');
      this.jobs.set(record.id, record);
      if (pending.has(record.status)) { record.status = 'interrupted'; record.summary = labels.interrupted; record.notification = 'suppressed'; await this.persist(record); }
      else if (record.notification === 'sending') { record.notification = 'uncertain'; await this.persist(record); }
    }
    const owner = await this.owner(); this.ownerHash = owner ? hash(owner) : '';
    this.ownerTimer = setInterval(() => { if (!this.polling) { this.polling = true; this.ownerChanged().catch(() => {}).finally(() => { this.polling = false; }); } }, this.ownerPollMs);
    this.ownerTimer.unref?.();
  }
  async owner() { try { const owner = await this.getOwner(); return typeof owner === 'string' ? owner : ''; } catch { return ''; } }
  serialize(callback) { const work = this.commands.then(callback); this.commands = work.catch(() => {}); return work; }
  jobDirectory(id) { if (!UUID.test(id)) throw fault('owner_browser_invalid_id'); return directory(this.base, [id]); }
  persist(record) {
    record.updatedAt = this.now(); const bytes = JSON.stringify(record, null, 2) + '\n';
    const operation = this.writes.then(async () => {
      if (this.storageFailed) throw fault('owner_browser_storage_failed');
      const folder = await this.jobDirectory(record.id), target = path.join(folder, 'job.json');
      try { const info = await fs.lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw fault('owner_browser_path_boundary'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.save(target, bytes);
    });
    this.writes = operation.catch(() => {
      this.storageFailed = true;
      for (const job of this.jobs.values()) if (pending.has(job.status)) { job.status = 'failed'; job.summary = '浏览记录没能安全保存，这次先停下了。'; job.notification = 'suppressed'; }
      if (this.active) { this.active.invalidated = true; this.active.controller.abort(fault('owner_browser_storage_failed')); }
      this.envelopes.clear();
    });
    return operation;
  }
  invalidate(record, status, summary = labels[status]) {
    if (!pending.has(record.status)) return false;
    record.status = status; record.summary = summary; record.notification = 'suppressed';
    if (this.active?.record === record) { this.active.invalidated = true; this.active.controller.abort(fault('owner_browser_' + status)); }
    this.envelopes.delete(record.id); return true;
  }
  async ownerChanged() {
    if (this.stopped) return;
    const owner = await this.owner(), currentHash = owner ? hash(owner) : '';
    this.ownerHash = currentHash;
    const changed = [...this.jobs.values()].filter(record => record.ownerHash !== currentHash
      ? this.invalidate(record, 'canceled', '主人绑定已变化，旧浏览已取消。')
      : this.now() >= record.expiresAt && this.invalidate(record, 'expired'));
    await Promise.all(changed.map(record => this.persist(record)));
  }
  async current(live, { delivery = false } = {}) {
    if (this.stopped || this.storageFailed || live.invalidated || live.controller.signal.aborted || this.active !== live) return false;
    const owner = await this.owner();
    if (!owner || hash(owner) !== live.record.ownerHash) { await this.ownerChanged(); return false; }
    if (delivery) return live.record.deliveryDeadline > this.now() && live.record.status !== 'forgotten';
    return live.record.status === 'running' && this.now() < live.record.expiresAt;
  }
  deliveryGuard(live) {
    return !this.stopped && !this.storageFailed && !live.invalidated && !live.controller.signal.aborted && this.active === live
      && this.ownerHash === live.record.ownerHash && live.record.deliveryDeadline > this.now() && ['completed', 'awaiting_login', 'unavailable', 'failed'].includes(live.record.status);
  }
  snapshot() {
    return [...this.jobs.values()].map(record => ({ id: record.id, status: record.status, summary: labels[record.status], createdAt: record.createdAt, updatedAt: record.updatedAt, receiptCount: record.receipts.length, observationCount: record.observations.length, notification: record.notification, workerSettling: Boolean(this.active?.record === record && !pending.has(record.status)), ...(record.cleanup ? { cleanup: structuredClone(record.cleanup) } : {}) }));
  }
  async context(event) {
    const owner = await this.owner(); if (!ownerEvent(event, owner)) return '';
    await this.ownerChanged();
    if (await this.owner() !== owner) return '';
    return [...this.jobs.values()].filter(record => record.ownerHash === hash(owner) && record.status === 'completed' && record.receipts.some(proof)).slice(-2)
      .map(record => `主人私聊浏览记录（仅此私聊使用，不是群聊见闻）：${safeText(record.summary, 1200)}\n来源：${[...new Set(record.receipts.filter(proof).map(receipt => receipt.url).filter(Boolean))].slice(0, 3).join('；')}`).join('\n').slice(0, 3000);
  }
  async handle(event, text, options = {}) {
    const parsed = instruction(text); if (!parsed) return { handled: false, reply: '' };
    const owner = await this.owner();
    if (!ownerEvent(event, owner)) return parsed.explicit ? { handled: true, reply: '浏览命令只接受已绑定主人的私聊。' } : { handled: false, reply: '' };
    await this.ownerChanged();
    const ownerHash = hash(owner);
    // Cancellation invalidates the callback before any queued persistence work.
    if (parsed.command === 'browsecancel') {
      const record = this.select(parsed.argument, ownerHash, true);
      if (record) { parsed.selectedId = record.id; this.invalidate(record, 'canceled'); }
    }
    return this.serialize(async () => {
      if (this.stopped || this.storageFailed) return { handled: true, reply: '浏览服务暂不可用；没有启动新浏览。' };
      if (await this.owner() !== owner) return { handled: true, reply: '主人绑定已变化，这次命令没有执行。' };
      try { return { handled: true, ...await this.command(event, parsed, ownerHash, options) }; }
      catch { this.log('主人浏览任务操作未完成；未输出网页内容或凭据。'); return { handled: true, reply: '浏览任务没有安全保存，请查看本机状态；没有自动重试。' }; }
    });
  }
  select(id, ownerHash, activeOnly = false) {
    const records = [...this.jobs.values()].filter(record => record.ownerHash === ownerHash && (!activeOnly || pending.has(record.status) || (record.status === 'canceled' && this.active?.record === record)));
    return id ? records.find(record => record.id === id) : records.at(-1);
  }
  async command(event, { command, argument, selectedId }, ownerHash, options) {
    if (command === 'browsestatus') {
      const records = argument ? [this.select(argument, ownerHash)].filter(Boolean) : [...this.jobs.values()].filter(record => record.ownerHash === ownerHash).slice(-5);
      return { reply: records.length ? records.map(record => `${record.id} · ${labels[record.status]}${record.summary ? '\n' + record.summary : ''}${record.notification === 'expired' ? '\n原消息回复窗口已过期，结果留在这里，没有另行主动发送。' : ''}`).join('\n\n') : '没有找到你的浏览任务。' };
    }
    if (command === 'browsecancel') {
      const record = this.select(selectedId || argument, ownerHash) || this.select('', ownerHash, true);
      if (!record || (argument && record.id !== argument)) return { reply: '没有找到你的浏览任务。' };
      if (pending.has(record.status)) this.invalidate(record, 'canceled');
      if (record.status === 'canceled') { await this.persist(record); return { reply: `已取消 ${record.id}。这次任务不会再回传浏览内容。` }; }
      return { reply: `这次任务已结束：${labels[record.status]}。` };
    }
    if (!argument) return { reply: '用 /browse 加上你现在希望我浏览的内容，例如 /browse 去抖音看看猫咪视频。' };
    if (!bounded(argument, 4000) || credentialTask.test(argument) || secretValue.test(argument) || sensitiveUrl(argument)) return { reply: '这个浏览请求涉及凭据或超出长度限制。登录请你在独立浏览器完成，不要把密码、验证码或密钥交给浏览任务。' };
    if (!idText(event?.id)) return { reply: '这条消息缺少有效标识，没有创建浏览任务。' };
    const sourceHash = hash(ownerHash + ':' + event.id), taskHash = hash(argument.normalize('NFKC').replace(/\s+/g, ' ').trim());
    const existing = [...this.jobs.values()].find(record => record.ownerHash === ownerHash && (record.sourceHashes.includes(sourceHash)
      || (record.taskHash === taskHash && record.status !== 'forgotten' && (pending.has(record.status) || this.now() - record.createdAt < this.taskDedupeMs))));
    if (existing) {
      if (!existing.sourceHashes.includes(sourceHash) && existing.sourceHashes.length < 32) { existing.sourceHashes.push(sourceHash); await this.persist(existing); }
      return { reply: `这条浏览请求已登记：${existing.id} · ${labels[existing.status]}。`, existingJobId: existing.id, deduplicated: true };
    }
    const occupied = [...this.jobs.values()].filter(record => pending.has(record.status)).length + (this.active && !pending.has(this.active.record.status) ? 1 : 0);
    if (occupied >= this.maxPending || this.jobs.size >= this.maxJobs) return { reply: '浏览队列暂时满了；现有任务结束后再交给我，或用 /browsecancel 取消。' };
    const id = randomUUID(), createdAt = this.now();
    const record = { version: 1, id, ownerHash, sourceHashes: [sourceHash], taskHash, task: argument, createdAt, updatedAt: createdAt, expiresAt: createdAt + this.queueTtlMs,
      deliveryDeadline: originalDeadline(event, createdAt), status: 'queued', summary: '', receipts: [], observations: [], notification: 'none' };
    await directory(this.base, [id, 'artifacts'], true); this.jobs.set(id, record);
    await this.persist(record); this.envelopes.set(id, { event, notify: typeof options.notify === 'function' ? options.notify : this.notify, ready: options.deferStart !== true });
    setImmediate(() => { this.drain().catch(() => {}); });
    return { reply: occupied ? '等我看完手头这页就去' : '我去看看', jobId: id, created: true };
  }
  async activate(id) {
    const record = this.jobs.get(id), envelope = this.envelopes.get(id);
    if (!record || record.status !== 'queued' || !envelope || this.stopped || this.storageFailed) return false;
    const owner = await this.owner();
    if (!ownerEvent(envelope.event, owner) || record.ownerHash !== hash(owner)) { await this.ownerChanged(); return false; }
    envelope.ready = true; setImmediate(() => { this.drain().catch(() => {}); }); return true;
  }
  async cancel(id) {
    const record = this.jobs.get(id), owner = await this.owner();
    if (!record || !owner || record.ownerHash !== hash(owner) || !this.invalidate(record, 'canceled')) return false;
    await this.persist(record); return true;
  }
  async receipt(value, record) {
    if (!object(value) || !browserTools.has(value.tool) || !idText(value.callId) || !idText(value.receiptId)
      || typeof value.ok !== 'boolean' || typeof value.observed !== 'boolean') return null;
    const observedAt = typeof value.observedAt === 'string' ? Date.parse(value.observedAt) : value.observedAt;
    if (!integer(observedAt) || observedAt < record.createdAt - 60000 || observedAt > this.now() + 60000) return null;
    const receipt = { tool: value.tool, callHash: hash(value.callId), receiptHash: hash(value.receiptId), threadHash: idText(value.threadId) ? hash(value.threadId) : '', turnHash: idText(value.turnId) ? hash(value.turnId) : '',
      ok: value.ok, observed: value.observed, url: publicUrl(value.url), title: safeText(value.title || '', 240), observedAt, pageVersion: bounded(String(value.pageVersion ?? ''), 128) ? String(value.pageVersion ?? '') : '',
      textSha256: HASH.test(value.textSha256 || '') ? value.textSha256 : '', screenshotSha256: HASH.test(value.screenshotSha256 || '') ? value.screenshotSha256 : '' };
    if (object(value.artifact)) {
      const folder = await this.jobDirectory(record.id), supplied = value.artifact.path;
      if (typeof supplied !== 'string') return null;
      const file = path.isAbsolute(supplied) ? supplied : path.resolve(folder, supplied), artifactDir = await directory(folder, ['artifacts']);
      if (!inside(artifactDir, file) || path.dirname(file) !== artifactDir) return null;
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024 || !samePath(await fs.realpath(file), file)) return null;
      const handle = await fs.open(file, 'r'); let bytes;
      try {
        const opened = await handle.stat();
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.nlink !== 1) return null;
        bytes = await handle.readFile(); const after = await handle.stat();
        if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return null;
      } finally { await handle.close(); }
      const digest = hash(bytes);
      if (digest !== value.artifact.sha256 || digest !== receipt.screenshotSha256 || stat.size !== value.artifact.size) return null;
      receipt.artifact = { path: 'artifacts/' + path.basename(file), mimeType: value.artifact.mimeType, sha256: digest, size: stat.size };
    }
    return validReceipt(receipt) ? receipt : null;
  }
  async observe(live, value) {
    if (!await this.current(live)) return false;
    const supplied = value?.receipt || value, receipt = await this.receipt(supplied, live.record).catch(() => null);
    if (!receipt || !await this.current(live)) return false;
    if (!live.record.receipts.some(item => item.receiptHash === receipt.receiptHash)) {
      if (live.record.receipts.length >= 24) return false;
      live.record.receipts.push(receipt);
    }
    const summary = safeText(value?.summary || '', 500);
    if (summary && proof(receipt) && live.record.observations.length < 8 && !live.record.observations.some(item => item.receiptHash === receipt.receiptHash && item.summary === summary)) live.record.observations.push({ receiptHash: receipt.receiptHash, summary });
    await this.persist(live.record); return true;
  }
  async captureCleanup(live, value) {
    const cleanup = cleanupMetadata(value);
    if (!cleanup || this.stopped || this.storageFailed || this.active !== live || live.record.status === 'forgotten') return;
    // Cancellation may finish before the process closes. Keep later shutdown
    // evidence without reviving the task, its content, or its notification.
    live.record.cleanup = cleanup; await this.persist(live.record);
  }
  async drain() {
    if (this.draining || this.stopped || this.storageFailed) return;
    this.draining = true;
    try {
      while (!this.stopped && !this.storageFailed) {
        const record = [...this.jobs.values()].find(item => item.status === 'queued' && this.envelopes.get(item.id)?.ready); if (!record) break;
        await this.ownerChanged(); if (record.status !== 'queued') continue;
        if (this.now() >= record.expiresAt) { this.invalidate(record, 'expired'); await this.persist(record); continue; }
        const live = { record, controller: new AbortController(), invalidated: false }; this.active = live;
        record.status = 'running'; await this.persist(record);
        if (!await this.current(live)) { this.invalidate(record, 'canceled'); await this.persist(record); this.active = null; continue; }
        live.timer = setTimeout(() => { if (this.invalidate(record, 'expired', '浏览已超过本次时限，未继续回传结果。')) this.persist(record).catch(() => {}); }, Math.min(this.timeoutMs, record.expiresAt - this.now()));
        try {
          const outputDir = await directory(await this.jobDirectory(record.id), ['artifacts']);
          const result = await this.runJob({ id: record.id, task: record.task, signal: live.controller.signal, isCurrent: () => this.current(live), onObservation: value => this.observe(live, value), outputDir });
          await this.captureCleanup(live, result?.cleanup);
          if (!await this.current(live)) continue;
          for (const value of (Array.isArray(result?.toolReceipts) ? result.toolReceipts : Array.isArray(result?.receipts) ? result.receipts : []).slice(0, 24)) await this.observe(live, value);
          for (const value of (Array.isArray(result?.observations) ? result.observations : []).slice(0, 8)) await this.observe(live, value);
          if (!await this.current(live)) continue;
          const status = ['completed', 'awaiting_login', 'unavailable', 'failed'].includes(result?.status) ? result.status : 'unavailable';
          record.status = status === 'completed' && !record.receipts.some(proof) ? 'unavailable' : status;
          record.summary = record.status === 'unavailable' ? '没有取得可核验的实际网页观察，这次不能算浏览完成。'
            : record.status === 'awaiting_login' ? '页面要求登录或验证，需要你先在独立浏览窗口里完成。'
              : record.status === 'failed' ? '这次浏览没有完成，未确认的内容没有当作结果。'
                : safeText(result?.summary ?? result?.text ?? '', 4000) || labels[record.status];
          await this.persist(record); await this.deliver(live);
        } catch (error) {
          await this.captureCleanup(live, error?.cleanup);
          if (await this.current(live)) {
            for (const receipt of (Array.isArray(error?.receipts) ? error.receipts : []).slice(0, 24)) await this.observe(live, receipt);
            if (await this.current(live)) { record.status = 'failed'; record.summary = '这次浏览没有完成，已停止；可查看任务状态后重新安排。'; await this.persist(record); await this.deliver(live); }
          }
        } finally { clearTimeout(live.timer); this.envelopes.delete(record.id); if (this.active === live) this.active = null; }
      }
    } finally { this.draining = false; }
  }
  async deliver(live) {
    const record = live.record, envelope = this.envelopes.get(record.id), event = envelope?.event;
    if (this.stopped || !event || record.notification !== 'none') return;
    if (!await this.current(live, { delivery: true })) { if (this.stopped || live.invalidated) return; record.notification = record.deliveryDeadline <= this.now() ? 'expired' : 'suppressed'; await this.persist(record); return; }
    record.notification = 'sending'; await this.persist(record);
    if (!await this.current(live, { delivery: true })) { if (this.stopped || live.invalidated) return; record.notification = 'suppressed'; await this.persist(record); return; }
    try {
      const result = await envelope.notify(event, { id: record.id, status: record.status, summary: record.summary, reply: safeText(record.summary, 1800), toolReceipts: structuredClone(record.receipts) }, { isCurrent: () => this.current(live, { delivery: true }), guard: () => this.deliveryGuard(live) });
      if (live.invalidated || record.status === 'forgotten') return;
      record.notification = result?.messageNotSent === true || result?.sent === false ? 'failed' : result?.sent === true || idText(result?.id) || idText(result?.body?.id) ? 'sent' : 'uncertain';
    } catch (error) { if (live.invalidated || this.stopped) return; record.notification = error?.messageNotSent === true ? 'failed' : 'uncertain'; }
    await this.persist(record);
  }
  async forget(event) {
    const owner = await this.owner(); if (!ownerEvent(event, owner)) return false;
    const ownerHash = hash(owner), records = [...this.jobs.values()].filter(record => record.ownerHash === ownerHash);
    for (const record of records) {
      this.invalidate(record, 'canceled');
      if (this.active?.record === record) { this.active.invalidated = true; this.active.controller.abort(fault('owner_browser_forgotten')); }
      record.status = 'forgotten'; record.task = ''; record.summary = ''; record.receipts = []; record.observations = []; record.notification = 'suppressed'; this.envelopes.delete(record.id);
      delete record.cleanup;
    }
    await this.serialize(async () => {
      for (const record of records) {
        await this.persist(record);
        const jobDir = await this.jobDirectory(record.id), artifacts = await directory(jobDir, ['artifacts']);
        // Only direct, verified job artifacts are removed; never follow links.
        for (const item of await fs.readdir(artifacts, { withFileTypes: true })) {
          const target = path.resolve(artifacts, item.name);
          if (!inside(artifacts, target) || item.isSymbolicLink() || !item.isFile()) throw fault('owner_browser_path_boundary');
          await fs.unlink(target);
        }
      }
    });
    return true;
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.ownerTimer);
    const changed = [...this.jobs.values()].filter(record => this.invalidate(record, 'interrupted'));
    if (this.active) {
      this.active.invalidated = true; this.active.controller.abort(fault('owner_browser_stopped'));
      const record = this.active.record;
      if (!changed.includes(record)) { record.notification = record.notification === 'sending' ? 'uncertain' : record.notification === 'none' ? 'suppressed' : record.notification; changed.push(record); }
    }
    await Promise.all(changed.map(record => this.persist(record))).catch(() => {}); await this.commands; await this.writes;
  }
}
