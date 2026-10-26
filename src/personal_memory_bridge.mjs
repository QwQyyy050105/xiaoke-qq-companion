import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const bucket = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const scopeFor = (group, member) => group ? 'member_' + hash(JSON.stringify([group, member])) : 'private_owner';
const sender = event => event.group_openid ? event.author?.member_openid || event.author?.id : event.author?.user_openid || event.author?.id;
const unavailable = '长期记忆这边暂时没保存成功，这条还不能算记住了。';

// The capture file is authoritative once canonical mode is enabled. Legacy
// arrays are transfer inputs only, never a fallback after a failed load/forget.
export class PersonalMemoryBridge {
  constructor(bot, { required = false } = {}) {
    this.bot = bot;
    this.enabled = required || typeof bot.memoryCapture?.rememberManual === 'function';
    this.importFailures = new Set();
  }
  get available() {
    return Boolean(this.bot.memoryCapture && typeof this.bot.memoryCapture.rememberManual === 'function'
      && typeof this.bot.memoryCapture.importLegacy === 'function');
  }
  source(event) {
    const member = sender(event), group = event.group_openid;
    return { scope: scopeFor(group, member), speaker: group ? this.bot.groupSpeaker(group, member) : 'owner',
      messageId: event.id, content: String(event.content || ''), at: event.timestamp };
  }
  record(scope) {
    if (scope === 'private_owner') return { scope, context: this.bot.state, contextKey: null, ownerSpeaker: 'owner' };
    const key = scope.slice(7);
    if (!scope.startsWith('member_') || !bucket(key) || !this.bot.state.groups[key]) throw Error('personal_memory_scope_invalid');
    return { scope, context: this.bot.state.groups[key], contextKey: key, ownerSpeaker: 'member_' + key.slice(0, 16) };
  }
  async initialize() {
    if (!this.enabled) return;
    this.bot.state.pendingPersonalForgets ??= {};
    for (const scope of Object.keys(this.bot.state.pendingPersonalForgets)) {
      this.validateIntent(scope, this.bot.state.pendingPersonalForgets[scope]);
      try { await this.resumeForget(scope); } catch { this.bot.onMemoryError('personal_memory_forget_incomplete'); }
    }
    if (!this.available) return;
    const scopes = [ ...(this.bot.state.owner ? ['private_owner'] : []),
      ...Object.keys(this.bot.state.groups).filter(bucket).map(key => 'member_' + key) ];
    for (const scope of scopes) {
      if (this.bot.state.pendingPersonalForgets[scope]) continue;
      try { await this.importScope(scope); } catch { this.importFailures.add(scope); this.bot.onMemoryError('personal_memory_import_failed'); }
    }
  }
  async importScope(scope) {
    if (!this.available) throw Error('personal_memory_unavailable');
    const { context, ownerSpeaker } = this.record(scope), notes = structuredClone(context.memory || []);
    if (!Array.isArray(notes)) throw Error('personal_memory_legacy_invalid');
    if (!notes.length) { this.importFailures.delete(scope); return; }
    const fingerprint = hash(JSON.stringify(notes));
    const receipt = await this.bot.memoryCapture.importLegacy({ scope, notes, ownerSpeaker, sourceFingerprint: fingerprint });
    if (!receipt?.canonical) throw Error('personal_memory_import_unconfirmed');
    // An intervening write is not part of this transfer and must not be erased.
    if (hash(JSON.stringify(context.memory || [])) !== fingerprint) throw Error('personal_memory_legacy_changed');
    context.memory = [];
    try { await this.bot.persist(); } catch {
      // Capture committed successfully. Keep its authoritative projection even
      // if removing the redundant legacy array could not yet be persisted.
      context.memory = notes; this.importFailures.delete(scope);
      this.bot.onMemoryError('personal_memory_legacy_cleanup_pending'); return;
    }
    this.importFailures.delete(scope);
  }
  relevantPending(event) {
    const scope = this.source(event).scope, room = event.group_openid ? hash(event.group_openid) : 'private_owner';
    return Object.entries(this.bot.state.pendingPersonalForgets || {}).filter(([key, entry]) => key === scope || entry.roomKey === room).map(([key]) => key);
  }
  blocksRoom(group) {
    const room = group ? hash(group) : 'private_owner';
    return Object.values(this.bot.state.pendingPersonalForgets || {}).some(entry => entry.roomKey === room);
  }
  async ensure(event) {
    if (!this.enabled) return true;
    try {
      for (const scope of this.relevantPending(event)) await this.resumeForget(scope);
      const scope = this.source(event).scope;
      const context = scope === 'private_owner' ? this.bot.state : this.bot.state.groups[scope.slice(7)];
      if (this.available && (this.importFailures.has(scope) || context?.memory?.length)) await this.importScope(scope);
      return true;
    } catch { this.bot.onMemoryError('personal_memory_recovery_incomplete'); return false; }
  }
  recall(group, member, legacy = [], query = '', options = {}) {
    if (!this.enabled) return legacy;
    const scope = scopeFor(group, member);
    if (!this.available || this.importFailures.has(scope) || this.bot.state.pendingPersonalForgets?.[scope] || this.blocksRoom(group)) return [];
    return this.bot.memoryCapture.recall(scope, { query, ...options });
  }
  validateIntent(scope, intent) {
    const row = this.record(scope);
    if (!intent || intent.version !== 1 || intent.contextKey !== row.contextKey
      || (scope === 'private_owner' ? intent.roomKey !== 'private_owner' : !bucket(intent.roomKey))
      || intent.growthKey !== (scope === 'private_owner' ? 'private:' + hash(this.bot.state.owner || '') : 'group:' + intent.roomKey)) throw Error('personal_memory_forget_intent_invalid');
    return row;
  }
  async forget(event) {
    const { scope } = this.source(event), { contextKey } = this.record(scope);
    const previous = this.bot.state.pendingPersonalForgets[scope];
    if (!previous) {
      this.bot.state.pendingPersonalForgets[scope] = { version: 1, contextKey,
        roomKey: event.group_openid ? hash(event.group_openid) : 'private_owner',
        growthKey: (event.group_openid ? 'group:' : 'private:') + hash(event.group_openid || sender(event)),
        requestedAt: new Date(this.bot.now()).toISOString() };
      try { await this.bot.persist(); } catch (cause) {
        delete this.bot.state.pendingPersonalForgets[scope];
        throw Object.assign(new Error('personal_memory_forget_not_recorded'), { code: 'personal_memory_forget_not_recorded', cause });
      }
    }
    await this.resumeForget(scope);
  }
  async resumeForget(scope) {
    const intent = this.bot.state.pendingPersonalForgets?.[scope];
    if (!intent) return;
    const { context } = this.validateIntent(scope, intent);
    if (!this.available) throw Error('personal_memory_unavailable');
    if (this.bot.characterGrowth) {
      if (typeof this.bot.characterGrowth.forgetScope !== 'function') throw Error('personal_memory_growth_recovery_unavailable');
      await this.bot.characterGrowth.forgetScope(intent.growthKey);
    }
    await this.bot.memoryCapture.forget(scope, intent.roomKey);
    context.history = []; context.memory = []; delete context.expression;
    if (intent.roomKey !== 'private_owner') {
      const room = this.bot.state.rooms[intent.roomKey];
      if (room) { room.recent = []; room.memory = []; delete room.expression; }
      const prefix = 'group:' + intent.roomKey + ':';
      for (const key of Object.keys(this.bot.state.silentGroupMessages || {})) if (key.startsWith(prefix)) delete this.bot.state.silentGroupMessages[key];
    }
    delete this.bot.state.pendingPersonalForgets[scope];
    try { await this.bot.persist(); } catch (error) { this.bot.state.pendingPersonalForgets[scope] = intent; throw error; }
    this.importFailures.delete(scope);
  }
  allNotes(event) {
    return this.recall(event.group_openid, sender(event), [], '', { limit: 256, maxChars: 256000, deduplicate: false });
  }
  async remember(event, send) {
    if (!this.available) return send(unavailable);
    try {
      const result = await this.bot.memoryCapture.rememberManual(this.source(event));
      if (!['saved', 'duplicate'].includes(result?.status)) return send(unavailable);
      if (result.status === 'duplicate' && !result.id) return send('这条保存请求之前处理过了，当前保留的内容用 /memory 查看');
      return send('记住了');
    } catch { this.bot.onMemoryError('manual_memory_save_failed'); return send(unavailable); }
  }
  async amend(event, send) {
    const text = String(event.content || '').trim();
    const command = text.match(/^\/memory-(delete|edit)\s+(\S+)(?:\s+([\s\S]+))?$/);
    const remove = text.match(/^(?:请)?(?:忘掉|删除|删掉)保存的[「“]([^」”]+)[」”][。！!]?$/);
    const edit = text.match(/^(?:请)?把保存的[「“]([^」”]+)[」”]改成[「“]([^」”]+)[」”][。！!]?$/);
    if (!command && !remove && !edit) return false;
    if (!this.available) { await send(unavailable); return true; }
    const notes = this.allNotes(event), found = command ? notes.filter(note => note.id === command[2]) : notes.filter(note => note.text === (remove?.[1] || edit?.[1]));
    if (found.length !== 1) { await send('没有找到唯一对应的笔记，用 /memory 看一下当前条目和编号'); return true; }
    const operation = remove || command?.[1] === 'delete' ? 'delete' : 'update';
    const replacementText = command?.[3] || edit?.[2];
    let result;
    try {
      result = await this.bot.memoryCapture.amendNote({ ...this.source(event), targetId: found[0].id,
        targetText: found[0].text, operation, ...(operation === 'update' ? { replacementText } : {}) });
    } catch { this.bot.onMemoryError('manual_memory_amend_failed'); await send('这条笔记还没改成功，原记录保留着'); return true; }
    // Delivery failure does not undo a committed note change. Let the caller
    // handle that failure; never send a false storage-failure acknowledgement.
    await send(result?.status === 'deleted' ? '这条忘掉了' : result?.status === 'updated' ? '改好了' : result?.status === 'duplicate' ? '这条已经处理过了' : '这条笔记已经变化，先用 /memory 看一下当前内容');
    return true;
  }
  page(event, page = 1) {
    if (!this.available) return '长期记忆暂时不可用，这不代表记录是空的';
    const facts = this.recall(event.group_openid, sender(event), [], '', { limit: 256, maxChars: 256000, deduplicate: false });
    if (!facts.length) return '目前没有专门保存的长期记忆。';
    const pages = [''];
    for (const item of facts) {
      const text = `[${item.id}] ${item.text}`;
      if (pages.at(-1) && pages.at(-1).length + text.length > 1400) pages.push('');
      pages[pages.length - 1] += (pages.at(-1) ? '\n\n' : '') + text;
    }
    if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) return `共 ${pages.length} 页，可用 /memory 页码 查看`;
    return pages[page - 1] + (pages.length > 1 ? `\n\n${page}/${pages.length} 页${page < pages.length ? `，下一页：/memory ${page + 1}` : ''}` : '');
  }
}
