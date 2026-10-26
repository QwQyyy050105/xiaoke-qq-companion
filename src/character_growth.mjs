import {isAbsolute as isPortableAbsolute} from 'node:path';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { durableWriteFile } from './durable_write.mjs';

const KINDS = new Set(['style', 'interest', 'rapport']);
const UPDATE_KEYS = ['operation', 'id', 'kind', 'text', 'source_message_id', 'source_excerpt'];
const ENTRY_KEYS = ['id', 'kind', 'text', 'source_message_id', 'source_excerpt', 'updatedAt', 'fingerprint'];
const CHANGE_KEYS = [...ENTRY_KEYS, 'operation', 'revision'];
const MAX_BYTES = 16 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safe = (value, max, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0)
  && [...value].length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const messageId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value);
const entryId = value => typeof value === 'string' && /^growth_[a-f0-9]{32}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const emptyScope = () => ({ revision: 0, entries: [], changes: [] });
function fail(code) { throw Object.assign(new Error(code), { code }); }

function scopeKey(event) {
  if (!record(event)) fail('character_growth_scope_invalid');
  if (Object.hasOwn(event, 'group_openid') && event.group_openid !== undefined && event.group_openid !== null && event.group_openid !== '') {
    if (!messageId(event.group_openid)) fail('character_growth_scope_invalid');
    return `group:${hash(event.group_openid)}`;
  }
  if (event.chat_type === 'group') fail('character_growth_scope_invalid');
  const user = event.author?.user_openid || event.author?.id;
  if (!messageId(user)) fail('character_growth_scope_invalid');
  return `private:${hash(user)}`;
}

function validateEntry(entry, change = false) {
  if (!exact(entry, change ? CHANGE_KEYS : ENTRY_KEYS) || !entryId(entry.id) || !KINDS.has(entry.kind)
      || !safe(entry.text, 160, change && entry.operation === 'delete') || !messageId(entry.source_message_id)
      || !safe(entry.source_excerpt, 160) || !integer(entry.updatedAt) || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
      || (change && (!['upsert', 'delete'].includes(entry.operation) || !integer(entry.revision) || entry.revision < 1))) {
    fail('character_growth_store_invalid');
  }
}

function validateState(state) {
  if (!exact(state, ['version', 'scopes']) || state.version !== 1 || !record(state.scopes)) fail('character_growth_store_invalid');
  for (const [key, value] of Object.entries(state.scopes)) {
    if (!/^(?:group|private):[a-f0-9]{64}$/.test(key) || !exact(value, ['revision', 'entries', 'changes'])
        || !integer(value.revision) || !Array.isArray(value.entries) || value.entries.length > 16
        || !Array.isArray(value.changes) || value.changes.length > 32) fail('character_growth_store_invalid');
    const ids = new Set();
    for (const entry of value.entries) {
      validateEntry(entry);
      if (ids.has(entry.id)) fail('character_growth_store_invalid');
      ids.add(entry.id);
    }
    let previous = 0;
    for (const change of value.changes) {
      validateEntry(change, true);
      if (change.revision > value.revision || change.revision < previous) fail('character_growth_store_invalid');
      previous = change.revision;
    }
    if (value.revision === 0 && (value.entries.length || value.changes.length)) fail('character_growth_store_invalid');
  }
  return state;
}

async function readStore(file) {
  let handle;
  try {
    const physical = await realpath(file);
    if (!isPortableAbsolute(physical)) fail('character_growth_requires_d_path');
    const expected = path.join(await realpath(path.dirname(file)), path.basename(file));
    if (physical.toLowerCase() !== expected.toLowerCase()) fail('character_growth_store_path_invalid');
    handle = await open(file, 'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BYTES) fail('character_growth_store_invalid');
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('character_growth_store_changed');
    }
    let state;
    try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))); }
    catch { fail('character_growth_store_invalid'); }
    return validateState(state);
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, scopes: {} };
    throw error;
  } finally { await handle?.close(); }
}

function validateUpdates(updates, messages, event) {
  if (!Array.isArray(updates) || updates.length > 2) fail('character_growth_updates_invalid');
  if (!updates.length) return [];
  if (!Array.isArray(messages)) fail('character_growth_evidence_invalid');
  const sources = new Map();
  for (const source of messages) {
    if (!record(source)) continue;
    const id = source.id || source.messageId || source.message_id;
    const content = source.content ?? source.text;
    if (!messageId(id) || typeof content !== 'string') continue;
    // Sources are supplied by the caller from this actual turn. An explicit
    // foreign scope remains invalid even if its ID/text happens to match.
    if (source.group_openid && source.group_openid !== event.group_openid) continue;
    if (!event.group_openid && source.author && (source.author.user_openid || source.author.id)
        && (source.author.user_openid || source.author.id) !== (event.author?.user_openid || event.author?.id)) continue;
    if (sources.has(id) && sources.get(id) !== content) fail('character_growth_evidence_ambiguous');
    sources.set(id, content);
  }
  return updates.map(update => {
    if (!exact(update, UPDATE_KEYS) || !['upsert', 'delete'].includes(update.operation) || !KINDS.has(update.kind)
        || typeof update.id !== 'string' || (update.id !== '' && !entryId(update.id))
        || (update.operation === 'delete' && !entryId(update.id))
        || !safe(update.text, 160, update.operation === 'delete') || !messageId(update.source_message_id)
        || !safe(update.source_excerpt, 160)) fail('character_growth_update_invalid');
    if (!sources.get(update.source_message_id)?.includes(update.source_excerpt)) fail('character_growth_evidence_invalid');
    // A retry keeps its original target: new entries use the empty input ID,
    // whereas separate existing targets and different kinds are distinct edits.
    // Rephrasing the evidence slice alone must not create another edit.
    const fingerprint = hash(JSON.stringify([update.source_message_id, update.operation, update.kind, update.id, update.text]));
    return { ...clone(update), fingerprint };
  });
}

export class CharacterGrowth {
  static async open(options) {
    const growth = new CharacterGrowth(options);
    await mkdir(growth.dataDir, { recursive: true });
    const physical = await realpath(growth.dataDir);
    if (!isPortableAbsolute(physical)) fail('character_growth_requires_d_path');
    growth.state = await readStore(growth.file);
    return growth;
  }

  constructor({ dataDir, now = Date.now, save = durableWriteFile } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !isPortableAbsolute(dataDir) || dataDir.includes('\0')) {
      fail('character_growth_requires_d_path');
    }
    if (typeof now !== 'function' || typeof save !== 'function') fail('character_growth_options_invalid');
    this.dataDir = dataDir; this.file = path.join(dataDir, 'character_growth.json');
    this.now = now; this.save = save; this.state = { version: 1, scopes: {} };
    this.queue = Promise.resolve(); this.epochs = new Map();
  }

  snapshot(event) {
    const state = this.state.scopes[scopeKey(event)] || emptyScope();
    return clone({ revision: state.revision, entries: state.entries });
  }

  summary(event) {
    const state = this.state.scopes[scopeKey(event)] || emptyScope();
    if (!state.entries.length && !state.changes.length) return '这段对话里还没有保存新的性格成长。';
    const labels = { style: '表达', interest: '兴趣', rapport: '相处' };
    const entries = state.entries.map(entry => `${labels[entry.kind]}：${entry.text}`);
    const changes = state.changes.slice(-5).map(change => `${change.operation === 'delete' ? '移除' : '更新'}${labels[change.kind]}：${change.text || '一条旧习惯'}`);
    return `小柯在这段对话中的成长 · 第 ${state.revision} 版\n${entries.length ? entries.join('\n') : '目前没有保留的成长条目。'}\n\n最近变化：\n${changes.join('\n')}`;
  }

  serialize(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async commit(next, current) {
    if (!current()) fail('character_growth_cancelled');
    const bytes = JSON.stringify(validateState(next));
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail('character_growth_capacity');
    // Only the canonical file is committed. A crash after staging leaves an
    // uncommitted .draft which open() never reads. save must atomically write and
    // flush the supplied file; the default durable writer does so.
    const draft = `${this.file}.${randomUUID()}.draft`;
    let committed = false;
    try {
      await this.save(draft, bytes);
      if (!current()) fail('character_growth_cancelled');
      // This rename is the commit point. There is deliberately no await between
      // the final guard/epoch check, atomic publication and memory publication,
      // so a JS cancellation cannot arrive in a rollback-dependent window.
      // This is process recovery/atomic publication, not a power-loss guarantee
      // for the OS or filesystem's directory metadata.
      renameSync(draft, this.file);
      committed = true;
      this.state = next;
    } finally {
      if (!committed) await unlink(draft).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  apply(event, updates = [], { expectedRevision, messages = [], reply, guard = () => true } = {}) {
    const key = scopeKey(event);
    const epoch = this.epochs.get(key) || 0;
    const checked = validateUpdates(updates, messages, event);
    if (typeof guard !== 'function') fail('character_growth_guard_invalid');
    // reply is deliberately not evidence. Only caller-supplied actual messages
    // (including an already-delivered reply, if appropriate) may ground a change.
    void reply;
    const current = () => {
      try { return guard() === true && (this.epochs.get(key) || 0) === epoch; } catch { return false; }
    };
    return this.serialize(async () => {
      if (!current()) fail('character_growth_cancelled');
      const previous = this.state.scopes[key] || emptyScope();
      const known = new Set([...previous.entries, ...previous.changes].map(item => item.fingerprint));
      const unique = checked.filter(item => { if (known.has(item.fingerprint)) return false; known.add(item.fingerprint); return true; });
      if (!unique.length) return { changed: false, ...this.snapshot(event), changes: [] };
      if (!integer(expectedRevision) || expectedRevision !== previous.revision) fail('character_growth_revision_conflict');
      const next = clone(this.state);
      const scope = clone(previous);
      const at = this.now();
      if (!integer(at) || !Number.isSafeInteger(scope.revision + 1)) fail('character_growth_clock_invalid');
      scope.revision++;
      const changes = [];
      for (const update of unique) {
        const index = update.id ? scope.entries.findIndex(entry => entry.id === update.id) : -1;
        if (update.id && index < 0) fail('character_growth_target_unknown');
        if (update.operation === 'delete' && scope.entries[index].kind !== update.kind) fail('character_growth_target_mismatch');
        const id = update.id || `growth_${randomUUID().replaceAll('-', '')}`;
        const entry = { id, kind: update.kind, text: update.text, source_message_id: update.source_message_id,
          source_excerpt: update.source_excerpt, updatedAt: at, fingerprint: update.fingerprint };
        if (update.operation === 'delete') scope.entries.splice(index, 1);
        else if (index >= 0) scope.entries[index] = entry;
        else scope.entries.push(entry);
        changes.push({ ...entry, operation: update.operation, revision: scope.revision });
      }
      if (scope.entries.length > 16) fail('character_growth_capacity');
      scope.changes = [...scope.changes, ...changes].slice(-32);
      next.scopes[key] = scope;
      await this.commit(next, current);
      return { changed: true, ...this.snapshot(event), changes: clone(changes) };
    });
  }

  forget(event) {
    return this.forgetScope(scopeKey(event)).then(() => this.snapshot(event));
  }
  forgetScope(key) {
    if (typeof key !== 'string' || !/^(?:group|private):[a-f0-9]{64}$/.test(key)) fail('character_growth_scope_invalid');
    this.epochs.set(key, (this.epochs.get(key) || 0) + 1);
    return this.serialize(async () => {
      const previous = this.state.scopes[key] || emptyScope();
      if (!Number.isSafeInteger(previous.revision + 1)) fail('character_growth_revision_conflict');
      const next = clone(this.state);
      next.scopes[key] = { revision: previous.revision + 1, entries: [], changes: [] };
      await this.commit(next, () => true);
      return { revision: next.scopes[key].revision, entries: [], changes: [] };
    });
  }
}
