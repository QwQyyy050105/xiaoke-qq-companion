import {isAbsolute as isPortableAbsolute} from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, open, realpath } from 'node:fs/promises';
import { durableWriteFile } from './durable_write.mjs';
import { join, isAbsolute } from 'node:path';
import { mediaScope } from './media.mjs';
import { inspectImage, MAX_IMAGE_BYTES } from './media_image.mjs';
import { resolveStickerCreation } from './sticker_actions.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function explicitBaseline(reference) {
  try {
    if (typeof reference !== 'string' || !isAbsolute(reference)) throw Error('invalid_reference');
    const file = await realpath(reference);
    if (process.platform === 'win32' && !isPortableAbsolute(file)) throw Error('invalid_reference');
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw Error('invalid_reference');
      const bytes = Buffer.alloc(stat.size + 1);let count = 0;
      while (count < bytes.length) {
        const {bytesRead} = await handle.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;count += bytesRead;
      }
      if (count !== stat.size) throw Error('invalid_reference');
      const image = inspectImage(bytes.subarray(0,count));
      return {path:file,sha256:image.sha256};
    } finally { await handle.close(); }
  } catch { throw Object.assign(new Error('image_reference_unavailable'), {code:'image_reference_unavailable'}); }
}
async function untilAborted(work, signal) {
  if (signal.aborted) throw signal.reason;
  let abort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
const safeFailure = error => {
  if (error?.usageLimit || error?.code === 'image_usage_limit') return '这次图片额度暂时用完了，图还没生成；恢复后请重新明确叫我制作。';
  if (error?.code === 'image_timeout') return '这次生成超时了，我没有拿到可发送的成品；不会擅自重复生成。';
  if (error?.code === 'image_too_large') return '图已经生成，但原文件超过 QQ 图片大小限制，暂时没发出；原图已保存在本机，尚未缩小。';
  if (/visual|reference/.test(error?.code || '')) return '这次图片的角色尺寸还没有通过实际视觉检查，所以我先不发图，也不会说已经做好了。';
  if (error?.code === 'image_aborted') return '这次制作已取消，没有发送图片。';
  return '这次制作没有取得经过检查、可以发送的成品，我没有把文字草稿当作图片完成。';
};

/** Only current user utterances authorize creation. IDs remain conversation scoped.
 * Worker/reviewer injection exists for offline tests; production supplies real implementations. */
export class StickerCreation {
  constructor({ root, media, createImage, visualReview, config = {}, now = Date.now,
    baselineReference, log = () => {} }) {
    Object.assign(this, { root, media, createImage, visualReview, config, now, baselineReference, log });
    this.file = join(root, 'data', 'sticker_jobs.json'); this.jobs = []; this.active = new Map(); this.starting = new Set(); this.deliveries = new Set(); this.clearedAt = new Map(); this.writes = Promise.resolve();
  }
  async init() {
    await mkdir(join(this.root, 'data'), { recursive: true });
    try { this.jobs = JSON.parse(await readFile(this.file, 'utf8')).jobs || []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.jobs = this.jobs.filter(job => job && typeof job.scope === 'string' && typeof job.jobKey === 'string').slice(-100);
    for (const job of this.jobs) if (job.status === 'running') {
      job.status = 'failed'; job.message = '上次制作时程序中断了，我还没有可交付的成品，也没有自动重复生成。';
    }
    await this.persist(); return this;
  }
  persist() {
    const snapshot = JSON.stringify({ version: 1, jobs: this.jobs.slice(-100) }, null, 2);
    const task = this.writes.catch(() => {}).then(async () => {
      await durableWriteFile(this.file, snapshot);
    });
    this.writes = task.catch(() => {}); return task;
  }
  pendingFor(event) {
    const scope = mediaScope(event);
    const found = this.jobs.find(job => job.scope === scope && ['ready', 'failed'].includes(job.status));
    return found ? { ...found } : null;
  }
  async confirmDelivered(event, jobKey) {
    const job = this.jobs.find(item => item.scope === mediaScope(event) && item.jobKey === jobKey);
    if (job && ['ready', 'failed'].includes(job.status)) { job.status = 'delivered'; job.deliveredAt = this.now(); await this.persist(); }
  }
  async deliverPending(event, deliver) {
    const job = this.jobs.find(item => item.scope === mediaScope(event) && ['ready', 'failed'].includes(item.status));
    if (!job || this.deliveries.has(job.jobKey)) return false;
    this.deliveries.add(job.jobKey);
    try {
      if (job.status === 'ready') {
        let unchanged = false;
        try {
          await this.media.refreshApproved();
          unchanged = !!job.reference?.id && (await this.media.prepare(event, job.reference.id)).sha256 === job.reference.sha256;
        } catch {}
        if (!unchanged) {
          job.status = 'failed'; job.errorCode = 'image_reference_changed';
          job.message = '这张成品等待交付期间，批准参考已经变化，旧的尺寸检查不再有效；原图仍保存在本机，我暂时不发它。';
          await this.persist();
        }
      }
      if (!this.jobs.includes(job)) return false;
      await deliver({ ...job }); await this.confirmDelivered(event, job.jobKey); return true;
    }
    finally { this.deliveries.delete(job.jobKey); }
  }
  async forget(event) {
    const scope = mediaScope(event); this.active.get(scope)?.controller.abort();
    if (Number.isFinite(event._receivedAt)) this.clearedAt.set(scope, Math.max(this.clearedAt.get(scope) || 0, event._receivedAt));
    this.jobs = this.jobs.filter(job => job.scope !== scope); await this.persist();
  }
  async waitForIdle(event) { await this.active.get(mediaScope(event))?.promise; }
  stop() { for (const task of this.active.values()) task.controller.abort(); }
  async execute(event, suggestion, { onComplete } = {}) {
    const action = resolveStickerCreation(event, suggestion);
    if (!action) return { status: 'ignored', message: '我还没有开始做图；请在当前消息里直接说要制作什么图片。' };
    const scope = mediaScope(event);
    if (!scope) throw new Error('media_invalid_scope');
    if (Number.isFinite(event._receivedAt) && event._receivedAt <= (this.clearedAt.get(scope) || 0)) {
      return { status: 'ignored', message: '这条排队中的旧制作请求已被后来的清空命令取消，没有开始生成。' };
    }
    const sourceIds = action.sourceIds.length ? action.sourceIds : [event.id].filter(Boolean);
    if (!sourceIds.length) return { status: 'ignored', message: '这条消息没有可核验的来源，我没有启动制作。' };
    const jobKey = digest(JSON.stringify([scope, sourceIds]));
    const existing = this.jobs.find(job => job.jobKey === jobKey);
    if (existing) return { ...existing, status: existing.status === 'delivered' ? 'ignored' : existing.status,
      message: existing.status === 'delivered' ? '这条制作请求已经处理过，没有重复生成。' : existing.message };
    if (this.active.has(scope) || this.starting.has(scope)) return { status: 'busy', message: '我正在做这个聊天里上一张图，完成后会发回来；这次还没另开一张。' };
    const job = { scope, jobKey, status: 'running', title: action.title, createdAt: this.now(),
      message: '我开始制作了，会先核对角色尺寸再发图。期间可以继续聊天；如果 QQ 回复窗口结束，成品会保留到下一条消息再发。' };
    this.starting.add(scope); this.jobs.push(job);
    try { await this.persist(); } finally { this.starting.delete(scope); }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(Object.assign(new Error('image_timeout'), { code: 'image_timeout' })), 600000); deadline.unref?.();
    const promise = Promise.resolve().then(() => this.run(event, action, job, controller.signal))
      .then(async () => {
        if (this.jobs.includes(job) && ['ready', 'failed'].includes(job.status) && typeof onComplete === 'function') {
          try { await onComplete({ ...job }); } catch { this.log('生成结果已保留，等待下一条可回复消息交付。'); }
        }
      }).catch(() => this.log('图片任务记录未完成，请检查本机任务记录。'))
      .finally(() => { clearTimeout(deadline); if (this.active.get(scope)?.promise === promise) this.active.delete(scope); });
    this.active.set(scope, { controller, promise });
    return { ...job, status: 'started' };
  }
  async run(event, action, job, signal) {
    let files = [];
    const canceled = () => {
      if (signal.aborted) throw Object.assign(new Error('image_aborted'), { code: 'image_aborted' });
      return !this.jobs.includes(job);
    };
    try {
      await this.media.refreshApproved();
      const reference = this.media.contextFor(event).images.find(item => item.source === 'approved' && item.type === 'avatar')
        || this.media.contextFor(event).images.find(item => item.id === 'approved_xiao_ke');
      if (!reference) throw Object.assign(new Error('image_reference_unavailable'), { code: 'image_reference_unavailable' });
      files = await this.media.visionFiles(event, { ids: [reference.id], maxImages: 1 });
      if (files.length !== 1) throw Object.assign(new Error('image_reference_unavailable'), { code: 'image_reference_unavailable' });
      const approved = await this.media.prepare(event, reference.id);
      job.reference = { id: reference.id, sha256: approved.sha256 };
      // A new user-approved avatar replaces the historical default baseline.
      // Identical inputs still require the real visual reviewer; byte identity
      // is only a change guard and never substitutes for a visible-size pass.
      const baseline = this.baselineReference === undefined
        ? {...files[0],sha256:approved.sha256} : await explicitBaseline(this.baselineReference);
      if (canceled()) return;
      job.preflight = await untilAborted(this.visualReview.preflight([baseline, files[0]], { signal }), signal);
      await this.persist();
      this.log('生图前实际视觉尺寸判断：' + job.preflight.status + '。');
      if (job.preflight.status !== 'pass') throw Object.assign(new Error('image_visual_preflight'), { code: 'image_visual_preflight' });
      if (canceled()) return;
      // A slow visual review can outlive the avatar approval it inspected.
      // Revalidate before spending a generation, as well as after generation.
      const currentBeforeGeneration = await this.media.prepare(event, reference.id).catch(() => {
        throw Object.assign(new Error('image_reference_changed'), {code:'image_reference_changed'});
      });
      if (currentBeforeGeneration.sha256 !== job.reference.sha256) throw Object.assign(new Error('image_reference_changed'), {code:'image_reference_changed'});
      if (canceled()) return;
      const generated = await this.createImage({ root: this.root, config: this.config, prompt: action.prompt,
        referenceFiles: [{ ...files[0], sha256: approved.sha256 }], sizeReview: job.preflight, signal });
      job.output = { path: generated.path, sha256: generated.sha256, mime: generated.mime, width: generated.width, height: generated.height };
      await this.persist();
      if (canceled()) return;
      job.postflight = await untilAborted(this.visualReview.postflight([files[0]], generated, { signal }), signal);
      await this.persist();
      this.log('生图后实际视觉尺寸判断：' + job.postflight.status + '。');
      if (job.postflight.status !== 'pass') throw Object.assign(new Error('image_visual_postflight'), { code: 'image_visual_postflight' });
      const current = await this.media.prepare(event, reference.id);
      if (current.sha256 !== approved.sha256) throw Object.assign(new Error('image_reference_changed'), { code: 'image_reference_changed' });
      if (canceled()) return;
      const imported = await this.media.importGenerated(event, generated, { type: 'sticker', title: action.title,
        label: action.title, tags: ['小柯', '专属表情', action.title] });
      if (canceled()) return;
      job.id = imported.id; job.status = 'ready'; job.completedAt = this.now();
      job.message = '这张「' + action.title + '」已经做好并通过角色尺寸检查，给你。';
    } catch (error) {
      if (this.jobs.includes(job)) {
        if (signal.aborted && signal.reason?.code === 'image_timeout') error = signal.reason;
        job.status = 'failed'; job.errorCode = typeof error?.code === 'string' ? error.code : 'image_creation_failed';
        job.message = job.output && ['image_timeout', 'image_aborted'].includes(error?.code)
          ? '图片原文件已保存在本机，但本次处理已超时或取消，没有作为完成结果发出。'
          : safeFailure(error); job.completedAt = this.now();
      }
    } finally {
      await this.media.releaseVisionFiles(files).catch(() => this.log('生图参考临时文件清理未完成。'));
      if (this.jobs.includes(job)) await this.persist();
    }
  }
}
