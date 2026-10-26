import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { durableWriteFile } from './durable_write.mjs';
import { loadCharacter, characterPrompt } from './character.mjs';
import { OwnerBrowser } from './owner_browser.mjs';
import { OwnerBrowserJobs } from './owner_browser_jobs.mjs';
import { createOwnerBrowserWorker } from './owner_browser_worker.mjs';

const failed = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');

// This owns one isolated account profile. It never attaches to the user's
// desktop browser, imports cookies, or treats opening a login page as login.
export class OwnerBrowserService {
  static async open({ root, config, getOwner, browser, runWorker, jobsFactory, ...options }) {
    let runtime = null;
    try { runtime = JSON.parse(await readFile(join(root, 'runtime', 'owner_browser_runtime.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw failed('owner_browser_config_invalid'); }
    const instance = new OwnerBrowserService({ root, config, getOwner, runtime, ...options });
    if (!instance.loginBinding) {
      try { const binding = JSON.parse(await readFile(instance.bindingPath, 'utf8'));
        if (/^[a-f0-9]{64}$/.test(binding.ownerHash) && Number.isFinite(Date.parse(binding.confirmedAt))) instance.loginBinding = binding; }
      catch (error) { if (error.code !== 'ENOENT') throw failed('owner_browser_login_binding_invalid'); }
    }
    instance.browser = browser || (runtime ? new OwnerBrowser({ root, executablePath: runtime.executablePath,
      executableSha256: runtime.executableSha256, allowedOrigins: runtime.allowedOrigins }) : null);
    instance.runWorker = runWorker || createOwnerBrowserWorker();
    instance.jobs = await (jobsFactory || (args => OwnerBrowserJobs.open(args)))({ root, getOwner,
      runJob: args => instance.run(args), ...options });
    return instance;
  }

  constructor({ root, config, getOwner, runtime, enabled = () => true, loginBinding = null }) {
    Object.assign(this, { root, config, getOwner, runtime, enabled, loginBinding });
    this.bindingPath = join(root, 'data', 'owner_browser', 'login_binding.json');
    this.login = null; this.running = false; this.stopped = false;
  }

  status() {
    this.reconcileLogin();
    return { configured: Boolean(this.browser), enabled: this.enabled() && !this.stopped,
      loginWindowOpen: Boolean(this.login), loginReady: this.login?.ready === true,
      authentication: this.hasBinding() ? 'owner_confirmed_not_verified' : 'login_required', running: this.running,
      jobs: this.jobs?.snapshot() || [], scope: 'owner_private', gameplay: false };
  }

  context(event) { return this.jobs.context(event); }
  handle(event, text, options) { return this.jobs.handle(event, text, options); }
  activate(id) { return this.jobs.activate(id); }
  cancel(id) { return this.jobs.cancel(id); }
  hasBinding() { const owner = this.getOwner(); return Boolean(owner && this.loginBinding?.ownerHash === hash(owner)); }
  reconcileLogin() { if (this.login?.session?.closed) { this.login.controller.abort(); this.login = null; } }

  async run({ id, task, signal, isCurrent, onObservation }) {
    this.reconcileLogin();
    if (!this.browser || this.stopped || !this.enabled()) return { status: 'unavailable', summary: '浏览器当前没有启用。', toolReceipts: [] };
    if (this.login) return { status: 'awaiting_login', summary: '登录窗口还开着，完成登录并关闭后再让我去看。', toolReceipts: [] };
    if (!this.hasBinding()) return { status: 'awaiting_login', summary: '需要先在本机控制台为小柯登录独立的抖音账号。', toolReceipts: [] };
    if (this.running) return { status: 'unavailable', summary: '另一项浏览还没有结束。', toolReceipts: [] };
    const ownerId = this.getOwner();
    if (!ownerId || signal.aborted || !await isCurrent()) throw failed('owner_browser_stale');
    if (this.login || this.running || !this.hasBinding()) throw failed('owner_browser_stale');
    this.running = true;
    try {
      const current = async () => !this.stopped && this.enabled() && !this.login && this.getOwner() === ownerId
        && !signal.aborted && await isCurrent();
      const persona = await loadCharacter(this.root).then(characterPrompt).catch(() => '小柯说话自然简短，有灵动和调皮，也有优雅与沉静。');
      const result = await this.runWorker({ root: this.root, config: this.config,
        job: { ownerId, jobId: id }, task, persona, signal, isCurrent: current,
        openBrowser: options => this.browser.open({ ...options, ownerId, jobId: id }),
        onReceipt: receipt => onObservation(receipt) });
      return { status: result.status, summary: result.text || '', toolReceipts: result.receipts || [], cleanup: result.cleanup };
    } finally { this.running = false; }
  }

  async openLogin() {
    this.reconcileLogin();
    if (!this.browser || this.stopped || !this.enabled()) throw failed('owner_browser_unavailable');
    if (this.running) throw failed('owner_browser_busy');
    if (this.login) return { ok: true, status: 'login_window_open', authentication: 'unverified' };
    const ownerId = this.getOwner();
    if (!ownerId) throw failed('owner_browser_owner_required');
    const login = { controller: new AbortController(), session: null, ownerId };
    this.login = login;
    const isCurrent = () => this.login === login && !this.stopped && this.getOwner() === ownerId && !login.controller.signal.aborted;
    try {
      login.session = await this.browser.open({ ownerId, jobId: randomUUID(), signal: login.controller.signal,
        isCurrent, headless: false, loginMode: true });
      if (!isCurrent()) { await login.session.close(); throw failed('owner_browser_stale'); }
      await login.session.navigate('https://www.douyin.com/');
      if (!isCurrent()) throw failed('owner_browser_stale');
      login.ready = true;
      return { ok: true, status: 'login_window_open', authentication: 'unverified' };
    } catch (error) {
      login.controller.abort(); await login.session?.close().catch(() => {});
      if (this.login === login) this.login = null;
      throw error;
    }
  }

  async closeLogin({ confirmed = false } = {}) {
    const login = this.login;
    const ownerId = this.getOwner();
    if (confirmed && (!login?.ready || !login.session || login.ownerId !== ownerId || !ownerId)) throw failed('owner_browser_login_confirmation_required');
    if (login) {
      login.controller.abort();
      await login.session?.close();
      if (this.login === login) this.login = null;
    }
    if (confirmed) {
      if (this.stopped || this.getOwner() !== ownerId) throw failed('owner_browser_stale');
      const binding = { ownerHash: hash(ownerId), confirmedAt: new Date().toISOString(), authentication: 'owner_confirmed_not_verified' };
      await durableWriteFile(this.bindingPath, JSON.stringify(binding, null, 2) + '\n');
      this.loginBinding = binding;
    }
    return { ok: true, status: 'login_window_closed', authentication: this.hasBinding() ? 'owner_confirmed_not_verified' : 'login_required' };
  }
  async ownerChanged() { await this.jobs.ownerChanged(); await this.closeLogin(); }
  async forget(event) { await this.jobs.forget(event); }
  async stop() { this.stopped = true; await this.jobs.stop(); await this.closeLogin(); }
}
