import {isAbsolute as isPortableAbsolute} from 'node:path';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspectImage, MAX_IMAGE_BYTES } from './media_image.mjs';
import { projectMathChatBlocks } from './math_chat_projection.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_JOBS = 64, MAX_PAGES = 32, MAX_SOURCE_BYTES = 2 * 1024 * 1024, MAX_EVENTS = 4096;
const ACTIVE = new Set(['rendering', 'pending', 'uncertain']);
const STATUSES = new Set([...ACTIVE, 'complete', 'expired', 'superseded', 'deleting']);
const sha = value => createHash('sha256').update(value).digest('hex');
const chars = value => Array.from(value);
const excerpt = (value, length) => chars(value).slice(0, length).join('');
const forgotten = () => Object.assign(Error('math_forgotten'), { code: 'math_forgotten' });
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (base, target) => {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};

export function isMathContinuation(text) {
  return typeof text === 'string' && /^(?:(?:小柯|小珂|柯霜)[，,\s]*)?(?:\/mathnext|继续公式|继续数学解答)[。.!！]*$/i.test(text.trim());
}

function eventScope(event) {
  const group = event?.group_openid;
  if (typeof group === 'string' && group) return { key: sha(`group:${group}`), limit: 5 };
  if (event?.chat_type === 'group' || event?.group_openid) throw Error('math_scope_invalid');
  const user = event?.author?.user_openid ?? event?.author?.openid ?? event?.author?.id;
  if (typeof user !== 'string' || !user) throw Error('math_scope_invalid');
  return { key: sha(`private:${user}`), limit: 4 };
}

function eventHash(scope, event) {
  return typeof event?.id === 'string' && event.id ? sha(`${scope}:${event.id}`) : null;
}

function documentForStorage(value) {
  // Never interpret model fields as paths, HTML or executable commands.
  return {
    title: typeof value?.title === 'string' ? value.title : '',
    blocks: Array.isArray(value?.blocks) ? value.blocks.map(block => ({ type: block?.type, content: block?.content })) : [],
    summary: typeof value?.summary === 'string' ? value.summary : ''
  };
}

function validDocument(value) {
  if (!value.title.trim() || value.title.length > 80 || value.summary.length > 1000
    || value.blocks.length < 1 || value.blocks.length > 32) return false;
  let length = value.title.length + value.summary.length;
  for (const block of value.blocks) {
    if (!['text', 'math'].includes(block.type) || typeof block.content !== 'string'
      || !block.content.trim() || block.content.length > 4000) return false;
    length += block.content.length;
  }
  return length <= 24000;
}

function textPages(text) {
  const points = chars(text), pages = [];
  for (let i = 0; i < points.length; i += 1600) pages.push(points.slice(i, i + 1600).join(''));
  return pages;
}

function descriptor(job) {
  return job ? { id: job.id, status: job.status, mode: job.mode, next: job.next, total: job.total,
    remaining: Math.max(0, job.total - job.next), title: job.title, createdAt: job.createdAt, expiresAt: job.expiresAt } : null;
}

function realReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok === false || value.success === false) return false;
  const id = value.messageId ?? value.id ?? value.body?.id;
  return (typeof id === 'string' && id.trim().length > 0) || (typeof id === 'number' && Number.isSafeInteger(id));
}

/** Full originals remain on disk; the network adapter receives only validated local pages. */
export class MathReplies {
  static async open({ root, render, now = Date.now, ttlMs = 86_400_000 } = {}) {
    if (typeof root !== 'string' || !isPortableAbsolute(root) || typeof render !== 'function'
      || typeof now !== 'function' || !Number.isFinite(ttlMs) || ttlMs <= 0) throw Error('math_options_invalid');
    const result = new MathReplies(path.resolve(root), render, now, ttlMs);
    await result.#init();
    return result;
  }

  constructor(root, render, now, ttlMs) {
    this.root = root;
    this.base = path.join(root, 'data', 'math_replies');
    this.documents = path.join(root, 'data', 'math_documents');
    this.render = render;
    this.now = now;
    this.ttlMs = ttlMs;
    this.jobs = new Map();
    this.latest = new Map();
    this.locks = new Map();
    this.epochs = new Map();
    this.controllers = new Map();
    this.writes = Promise.resolve();
  }

  async #guard(target, { directory = false, missing = false, max = Infinity } = {}) {
    const resolved = path.resolve(target);
    if (!samePath(resolved, this.root) && !within(this.root, resolved)) throw Error('math_path_outside_root');
    const relative = path.relative(this.root, resolved);
    let current = this.root;
    const parts = relative ? relative.split(path.sep) : [];
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (error.code === 'ENOENT' && missing) return null;
        throw error;
      }
      if (stat.isSymbolicLink() || !samePath(await fs.realpath(current), current)) throw Error('math_path_link');
      const last = i === parts.length - 1;
      if (!last || directory) { if (!stat.isDirectory()) throw Error('math_path_not_directory'); }
      else if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw Error('math_path_not_regular');
      if (last) return stat;
    }
  }

  async #mkdir(target) {
    await this.#guard(target, { directory: true, missing: true });
    await fs.mkdir(target, { recursive: true });
    await this.#guard(target, { directory: true });
  }

  async #read(target, max) {
    await this.#guard(target, { max });
    const value = await fs.readFile(target);
    if (value.length > max) throw Error('math_file_too_large');
    await this.#guard(target, { max });
    return value;
  }

  async #atomic(target, content) {
    await this.#guard(path.dirname(target), { directory: true });
    await this.#guard(target, { missing: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, content, { flag: 'wx' });
      await this.#guard(target, { missing: true });
      await fs.rename(temp, target);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }

  #save() {
    const payload = JSON.stringify({ version: 1, jobs: [...this.jobs.values()], latest: Object.fromEntries(this.latest) }, null, 2);
    const next = this.writes.then(() => this.#atomic(path.join(this.base, 'index.json'), payload));
    this.writes = next.catch(() => {});
    return next;
  }

  #serial(scope, operation) {
    const next = (this.locks.get(scope) ?? Promise.resolve()).then(operation);
    const settled = next.catch(() => {});
    this.locks.set(scope, settled);
    settled.finally(() => { if (this.locks.get(scope) === settled) this.locks.delete(scope); });
    return next;
  }

  #current(scope) { return this.jobs.get(this.latest.get(scope)); }
  #epoch(scope) { return this.epochs.get(scope) ?? 0; }

  async #init() {
    await this.#guard(this.root, { directory: true });
    await this.#mkdir(path.join(this.base, 'jobs'));
    await this.#mkdir(this.documents);
    let state;
    try { state = JSON.parse((await this.#read(path.join(this.base, 'index.json'), 32 * 1024 * 1024)).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw Error('math_index_invalid', { cause: error }); }
    if (state?.version !== 1 || !Array.isArray(state.jobs) || state.jobs.length > MAX_JOBS
      || !state.latest || typeof state.latest !== 'object' || Array.isArray(state.latest)) throw Error('math_index_invalid');
    for (const raw of state.jobs) {
      if (!raw || !UUID.test(raw.id) || !HASH.test(raw.scope) || !HASH.test(raw.fallbackHash)
        || !HASH.test(raw.documentHash) || !STATUSES.has(raw.status) || !['images', 'text'].includes(raw.mode)
        || !Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= raw.createdAt
        || !Number.isSafeInteger(raw.next) || !Number.isSafeInteger(raw.total) || raw.next < 0 || raw.next > raw.total || raw.total < 1
        || !Array.isArray(raw.sources) || raw.sources.length > MAX_EVENTS || raw.sources.some(value => !HASH.test(value))
        || !Array.isArray(raw.images) || raw.images.length > MAX_PAGES || typeof raw.title !== 'string' || chars(raw.title).length > 80
        || (raw.prepareSource !== null && !HASH.test(raw.prepareSource))
        || (raw.rendererId !== null && !UUID.test(raw.rendererId))
        || (raw.mode === 'images' && (raw.total !== raw.images.length || !raw.rendererId))
        || (raw.inFlight !== null && (!Number.isSafeInteger(raw.inFlight) || raw.inFlight !== raw.next))
        || this.jobs.has(raw.id)) throw Error('math_index_invalid');
      const images = raw.images.map(image => {
        if (!image || typeof image.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.png$/i.test(image.fileName)
          || !HASH.test(image.sha256) || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
          || image.width < 1 || image.height < 1 || typeof image.description !== 'string' || chars(image.description).length > 1100) throw Error('math_index_invalid');
        return { fileName: image.fileName, sha256: image.sha256, width: image.width, height: image.height, description: image.description };
      });
      const job = { id: raw.id, scope: raw.scope, createdAt: raw.createdAt, expiresAt: raw.expiresAt, title: raw.title,
        status: raw.status, mode: raw.mode, next: raw.next, total: raw.total, fallbackHash: raw.fallbackHash, documentHash: raw.documentHash,
        sources: raw.sources, images, rendererId: raw.rendererId, inFlight: raw.inFlight, prepareSource: raw.prepareSource };
      if (job.status === 'deleting') { /* Keep cleanup tombstones until a successful forget retry. */ }
      else if (job.expiresAt <= this.now()) job.status = 'expired';
      else if (job.inFlight !== null) job.status = 'uncertain';
      else if (job.status === 'rendering') job.status = 'pending'; // full text was saved before render started
      this.jobs.set(job.id, job);
    }
    for (const [scope, id] of Object.entries(state.latest)) {
      if (!HASH.test(scope) || !UUID.test(id) || this.jobs.get(id)?.scope !== scope) throw Error('math_index_invalid');
      this.latest.set(scope, id);
    }
    await this.#save();
  }

  pending(event) {
    const { key } = eventScope(event), job = this.#current(key);
    return job && ACTIVE.has(job.status) && job.expiresAt > this.now() ? descriptor(job) : null;
  }

  prepare(event, document, fallbackText) {
    const { key } = eventScope(event), epoch = this.#epoch(key);
    return this.#serial(key, async () => {
      if (epoch !== this.#epoch(key)) throw forgotten();
      if (typeof fallbackText !== 'string' || !fallbackText.trim() || Buffer.byteLength(fallbackText) > MAX_SOURCE_BYTES) throw Error('math_fallback_invalid');
      const source = eventHash(key, event);
      const duplicate = source && [...this.jobs.values()].find(job => job.scope === key && (job.prepareSource === source || job.sources.includes(source)));
      if (duplicate) return descriptor(duplicate);
      // All source content is saved before renderer execution, including documents rejected by its limits.
      const stored = documentForStorage(document), documentText = JSON.stringify(stored, null, 2);
      if (Buffer.byteLength(documentText) > MAX_SOURCE_BYTES) throw Error('math_document_too_large');
      if (this.jobs.size >= MAX_JOBS) {
        const oldest = [...this.jobs.values()].filter(job => job.status !== 'deleting' && (!ACTIVE.has(job.status) || job.expiresAt <= this.now())).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!oldest) throw Error('math_queue_full');
        this.jobs.delete(oldest.id);
        if (this.latest.get(oldest.scope) === oldest.id) this.latest.delete(oldest.scope);
      }
      const id = randomUUID(), createdAt = Math.trunc(this.now()), directory = path.join(this.base, 'jobs', id);
      await this.#mkdir(directory);
      await this.#atomic(path.join(directory, 'fallback.txt'), fallbackText);
      await this.#atomic(path.join(directory, 'document.json'), documentText);
      const previous = this.#current(key);
      if (previous && ACTIVE.has(previous.status)) previous.status = 'superseded';
      const job = { id, scope: key, createdAt, expiresAt: createdAt + this.ttlMs, title: excerpt(stored.title, 80),
        status: 'rendering', mode: 'text', next: 0, total: textPages(fallbackText).length,
        fallbackHash: sha(fallbackText), documentHash: sha(documentText), sources: [], images: [], rendererId: null, inFlight: null, prepareSource: source };
      // prepare does not consume the source event: its first deliver must still run.
      this.jobs.set(id, job);
      this.latest.set(key, id);
      await this.#save();
      const controller = new AbortController();
      this.controllers.set(key, controller);
      let output;
      try {
        if (validDocument(stored)) {
          output = await this.render({ root: this.root, document: stored, signal: controller.signal });
          const checked = await this.#rendered(output, stored);
          job.images = checked.images;
          job.rendererId = checked.rendererId;
          job.mode = 'images';
          job.total = checked.images.length;
        }
      } catch {
        // Invalid/render-failed output uses the saved complete text; discard only this unreferenced output.
        if (output?.id && UUID.test(output.id) && typeof output.outputDir === 'string'
          && samePath(output.outputDir, path.join(this.documents, output.id))) {
          try { await this.#deleteRenderer(output.id, id); }
          catch { job.rendererId = output.id; } // Retain the cleanup reference; do not block full text fallback.
        }
      }
      finally { if (this.controllers.get(key) === controller) this.controllers.delete(key); }
      if (epoch !== this.#epoch(key) || controller.signal.aborted) {
        if (output?.id && UUID.test(output.id)) await this.#deleteRenderer(output.id, id);
        throw forgotten();
      }
      job.status = job.expiresAt <= this.now() ? 'expired' : 'pending';
      await this.#save();
      return descriptor(job);
    });
  }

  async #rendered(output, document) {
    if (!output || !UUID.test(output.id) || typeof output.outputDir !== 'string'
      || !samePath(output.outputDir, path.join(this.documents, output.id)) || !Array.isArray(output.images)
      || !output.images.length || output.images.length > MAX_PAGES) throw Error('math_render_output_invalid');
    const directory = path.join(this.documents, output.id);
    await this.#guard(directory, { directory: true });
    const names = new Set(), images = [];
    const hasProjection=output.images.some(image=>image?.visibleBlocks!==undefined||image?.fragments!==undefined);
    const projection=hasProjection?projectMathChatBlocks(document):null;
    let projectionCursor=0;
    for (const [index, image] of output.images.entries()) {
      if (typeof image?.path !== 'string' || !samePath(path.dirname(image.path), directory)
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.png$/i.test(path.basename(image.path))) throw Error('math_render_image_path');
      const fileName = path.basename(image.path);
      if (names.has(fileName.toLowerCase())) throw Error('math_render_duplicate_page');
      names.add(fileName.toLowerCase());
      const inspected = inspectImage(image.buffer, 'image/png');
      const actual = inspectImage(await this.#read(image.path, MAX_IMAGE_BYTES), 'image/png');
      if (actual.sha256 !== inspected.sha256 || image.mime !== 'image/png'
        || actual.width !== image.width || actual.height !== image.height) throw Error('math_render_image_changed');
      const indexes = Array.isArray(image.blockIndexes) ? [...new Set(image.blockIndexes)].filter(i => Number.isSafeInteger(i) && i >= 0 && i < document.blocks.length) : [];
      let pageNotes;
      if(hasProjection){
        if(!Array.isArray(image.visibleBlocks)||!image.visibleBlocks.length)throw Error('math_render_projection_invalid');
        const visible=[];
        for(const item of image.visibleBlocks){
          const expected=projection[projectionCursor];
          if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['blockIndex','fragment','content'].includes(key))
            ||!Number.isSafeInteger(item.blockIndex)||!Number.isSafeInteger(item.fragment)||typeof item.content!=='string'
            ||!expected||item.blockIndex!==expected.blockIndex||item.fragment!==expected.fragment||item.content!==expected.content)throw Error('math_render_projection_invalid');
          visible.push(expected);projectionCursor++;
        }
        const visibleIndexes=[...new Set(visible.map(item=>item.blockIndex))];
        if(JSON.stringify(indexes)!==JSON.stringify(visibleIndexes))throw Error('math_render_projection_invalid');
        if(image.fragments!==undefined&&(!Array.isArray(image.fragments)||image.fragments.length!==visible.length
          ||image.fragments.some((item,i)=>!item||Object.keys(item).some(key=>!['blockIndex','fragment'].includes(key))
            ||item.blockIndex!==visible[i].blockIndex||item.fragment!==visible[i].fragment)))throw Error('math_render_projection_invalid');
        pageNotes=visible.map(item=>item.content).join('；');
      }else pageNotes = indexes.length ? indexes.map(i => document.blocks[i].content).join('；')
        : typeof image.description === 'string' ? image.description : '';
      const description = `《${excerpt(document.title, 80)}》公式解答，第 ${index + 1}/${output.images.length} 页${pageNotes ? `。本页内容：${excerpt(pageNotes, 800)}` : '。本页步骤见图片。'}`;
      images.push({ fileName, sha256: actual.sha256, width: actual.width, height: actual.height, description });
    }
    if(hasProjection&&projectionCursor!==projection.length)throw Error('math_render_projection_invalid');
    return { rendererId: output.id, images };
  }

  async #fallback(job) {
    const bytes = await this.#read(path.join(this.base, 'jobs', job.id, 'fallback.txt'), MAX_SOURCE_BYTES);
    if (sha(bytes) !== job.fallbackHash) throw Error('math_source_changed');
    return bytes.toString('utf8');
  }

  async #image(job) {
    const ref = job.images[job.next], filePath = path.join(this.documents, job.rendererId, ref.fileName);
    const image = inspectImage(await this.#read(filePath, MAX_IMAGE_BYTES), 'image/png');
    if (image.sha256 !== ref.sha256 || image.width !== ref.width || image.height !== ref.height) throw Error('math_image_changed');
    return { ...image, path: filePath, fileName: ref.fileName };
  }

  deliver(event, { remaining, sendImage, sendText } = {}) {
    const { key, limit } = eventScope(event), epoch = this.#epoch(key);
    return this.#serial(key, async () => {
      const job = this.#current(key), deliveries = [];
      const result = (extra = {}) => ({ ...(deliveries.at(-1) ?? {}), sent_text: deliveries.map(item => item.content).join('\n\n'),
        delivered_messages: deliveries, job: descriptor(job), ...extra });
      if (epoch !== this.#epoch(key)) throw forgotten();
      if (!job) return result({ empty: true });
      if (job.expiresAt <= this.now()) { job.status = 'expired'; await this.#save(); return result({ expired: true }); }
      if (!ACTIVE.has(job.status)) return result({ empty: true });
      if (typeof remaining !== 'function' || typeof sendImage !== 'function' || typeof sendText !== 'function') throw Error('math_delivery_options_invalid');
      const source = eventHash(key, event);
      if (source && [...this.jobs.values()].some(item => item.scope === key && item.sources.includes(source))) return result({ duplicate: true });
      let left = Math.max(0, Math.min(limit, Math.floor(Number(remaining()) || 0)));
      const budget = () => Math.max(0, Math.min(left, Math.floor(Number(remaining()) || 0)));
      if (!budget()) return result();
      if (source) {
        if (job.sources.length >= MAX_EVENTS) return result({ exhausted: true });
        job.sources.push(source);
        await this.#save(); // Persist event dedup before any network request.
      }
      const valid = () => epoch === this.#epoch(key) && job.expiresAt > this.now();
      const send = async (method, payload, content, page) => {
        if (!valid() || !budget()) return false;
        if (page) { job.inFlight = job.next; await this.#save(); }
        left--;
        let receipt;
        try {
          receipt = method === 'image' ? await sendImage(payload, content) : await sendText(payload);
          if (!realReceipt(receipt)) throw Error('math_send_receipt_missing');
        } catch (error) {
          // A transport failure may have happened after the remote server accepted the page.
          const uncertain = page && /timeout|timed.out|socket|connection|fetch|network|econn|und_err|aborted|receipt_missing/i.test(`${error?.name} ${error?.code} ${error?.message}`);
          if (uncertain) job.status = 'uncertain';
          else job.inFlight = null;
          await this.#save();
          throw error;
        }
        deliveries.push({ ...receipt, messageId: receipt.messageId ?? receipt.id ?? receipt.body?.id, content });
        if (page) { job.next++; job.inFlight = null; if (job.next >= job.total) job.status = 'complete'; await this.#save(); }
        return true;
      };
      if (job.status === 'uncertain') {
        const notice = '上次公式页发送时连接中断，未能确认送达位置。为避免重复发送，已暂停自动续发；完整解答仍保存在本机，请重新请求这道题。';
        try { await send('text', notice, notice, false); } catch { /* No confirmed receipt. */ }
        return result({ uncertain: true });
      }
      let pages;
      try { pages = textPages(await this.#fallback(job)); }
      catch {
        const notice = '这份公式解答的本机原文校验失败，已暂停发送。请重新请求这道题。';
        job.status = 'uncertain'; await this.#save();
        try { await send('text', notice, notice, false); } catch { /* Retain pending source for inspection. */ }
        return result({ failed: true });
      }
      let failure = false, fellBack = false;
      while (valid() && job.next < job.total && budget() > 1) {
        try {
          if (job.mode === 'images') {
            const image = await this.#image(job), description = job.images[job.next].description;
            if (!await send('image', image, description, true)) break;
          } else {
            if (!await send('text', pages[job.next], pages[job.next], true)) break;
          }
        } catch {
          if (job.status === 'uncertain') { failure = true; break; }
          if (job.mode === 'images' && job.next === 0) {
            job.mode = 'text'; job.next = 0; job.total = pages.length; job.inFlight = null; fellBack = true;
            await this.#save();
            continue;
          }
          failure = true;
          break;
        }
      }
      if (valid() && budget()) {
        const unfinished = job.total - job.next;
        let notice = `${job.mode === 'images' ? '公式图片' : '完整文字解答'}共 ${job.total} 页，已发送 ${job.next} 页`;
        notice += unfinished ? `，还剩 ${unfinished} 页。回复“继续公式”或 /mathnext 继续。` : '，本次解答已发送完毕。';
        if (job.status === 'uncertain') notice = '当前公式页未能确认送达，已暂停自动续发以避免重复；完整解答仍保存在本机，请重新请求这道题。';
        else if (failure) notice = `当前页发送失败，已成功发送的页不会重复。${notice}`;
        if (fellBack) notice = `公式图片暂时无法发送，已切换完整文字解答。${notice}`;
        try { await send('text', notice, notice, false); } catch { failure = true; }
      }
      return result({ failed: failure, pending: job.status === 'pending' });
    });
  }

  async #deleteRenderer(id, exceptId) {
    if (!UUID.test(id) || [...this.jobs.values()].some(job => job.id !== exceptId && job.status !== 'deleting' && job.rendererId === id)) return;
    const directory = path.join(this.documents, id);
    if (!within(this.documents, directory) || !samePath(path.dirname(directory), this.documents)) return;
    try { await this.#guard(directory, { directory: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    // rm must never traverse a symlink nested in the renderer output either.
    const visit = async current => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        await this.#guard(child, { directory: entry.isDirectory() });
        if (entry.isDirectory()) await visit(child);
      }
    };
    await visit(directory);
    await fs.rm(directory, { recursive: true });
  }

  forget(event) {
    const { key } = eventScope(event);
    this.epochs.set(key, this.#epoch(key) + 1);
    this.controllers.get(key)?.abort();
    return this.#serial(key, async () => {
      const removed = [...this.jobs.values()].filter(job => job.scope === key);
      for (const job of removed) job.status = 'deleting';
      this.latest.delete(key);
      await this.#save();
      for (const id of new Set(removed.map(job => job.rendererId).filter(Boolean))) await this.#deleteRenderer(id);
      for (const job of removed) {
        const directory = path.join(this.base, 'jobs', job.id);
        if (!await this.#guard(directory, { directory: true, missing: true })) {
          this.jobs.delete(job.id); await this.#save(); continue;
        }
        for (const file of ['fallback.txt', 'document.json']) {
          const target = path.join(directory, file);
          if (await this.#guard(target, { missing: true })) await fs.unlink(target);
        }
        await fs.rmdir(directory);
        this.jobs.delete(job.id);
        await this.#save();
      }
      return { forgotten: removed.length };
    });
  }
}
