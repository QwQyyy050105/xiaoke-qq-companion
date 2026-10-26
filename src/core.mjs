import {expressionView,normalizeExpression} from './character.mjs';
import { inspectPersonalCandidates } from './personal_memory.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { durableWriteFile } from './durable_write.mjs';
import { join } from 'node:path';
import { explicitRoomCandidates, mergeRoomMemory, roomMemorySnapshot } from './room_memory.mjs';
import { PRIVATE_OWNER_ROOM } from './memory_capture.mjs';
import { normalizeMathDocument, mathDocumentText } from './math_document.mjs';
import { validateStickerSelection } from './sticker_context.mjs';
import { PersonalMemoryBridge } from './personal_memory_bridge.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const senderId = event => event.group_openid
  ? event.author?.member_openid || event.author?.id
  : event.author?.user_openid || event.author?.id;
const eventKey = event => event.group_openid ? `group:${hash(event.group_openid)}:${event.id}` : event.id;
const turnMessagesFor = event => {
  if (!event.group_openid || !Array.isArray(event.turn_messages)) return [];
  const seen = new Set();
  return event.turn_messages.slice(0, 20).filter(message => {
    const member = message?.author?.member_openid || message?.author?.id;
    if (!message || typeof message.id !== 'string' || !message.id || typeof member !== 'string' || !member
      || typeof message.content !== 'string' || (message.group_openid && message.group_openid !== event.group_openid) || seen.has(message.id)) return false;
    seen.add(message.id); return true;
  });
};
const sourceIdsFor = event => {
  if (!event.group_openid) return [event.id];
  const turn = turnMessagesFor(event);
  return [...new Set((turn.length ? turn.map(message => message.id) : [...(event.source_ids || []), event.id])
    .filter(id => typeof id === 'string' && id))];
};
const receiptId = receipt => {
  const value = receipt?.messageId || receipt?.id || receipt?.body?.id;
  return typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f]/.test(value) ? value : null;
};
const deliveredReceipts = delivery => {
  const seen = new Set();
  const receipts = (Array.isArray(delivery?.delivered_messages) ? delivery.delivered_messages : []).filter(item => {
    const id = receiptId(item);
    if (!id || typeof item?.content !== 'string' || !item.content.trim() || seen.has(id)) return false;
    seen.add(id); return true;
  }).slice(0, 16).map(item => ({ content: item.content.trim(), messageId: receiptId(item),
    ...(typeof item.referenceId === 'string' ? { referenceId: item.referenceId } : {}) }));
  if (!receipts.length && receiptId(delivery) && typeof delivery?.sent_text === 'string' && delivery.sent_text.trim()) {
    receipts.push({ content: delivery.sent_text.trim(), messageId: receiptId(delivery) });
  }
  return receipts;
};
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function saveJson(path, value) {
  await durableWriteFile(path, JSON.stringify(value, null, 2));
}
export function splitReply(text, limit = 1800) {
  const chars = Array.from(text.trim());
  const result = [];
  for (let start = 0; start < chars.length && result.length < 4; start += limit) result.push(chars.slice(start, start + limit).join(''));
  if (chars.length > limit * 4) result[3] = result[3].slice(0, -20) + '…（内容较长，可以让我接着说）';
  return result;
}

// Compatibility entry point; the source validator also powers background capture.
export function supportedMemories(candidates, message) {
  return inspectPersonalCandidates(candidates, message).accepted.map(item => item.source);
}

export class Companion {
  constructor({ dataDir, pairingHash, generate, memoryCapture, memoryCaptureRequired = false, characterGrowth, onMemoryError = () => {}, onTiming = () => {}, prepareInput = async () => ({}), releaseInput = async () => {}, progressDelayMs = 25000, now = Date.now, maxQueueAgeMs = 270000 }) {
    this.dataDir = dataDir; this.pairingHash = pairingHash; this.generate = generate;
    this.prepareInput = prepareInput;
    this.memoryCapture = memoryCapture; this.onMemoryError = onMemoryError;
    this.characterGrowth = characterGrowth;
    this.onTiming = onTiming;
    this.releaseInput = releaseInput;
    this.progressDelayMs = progressDelayMs; this.now = now; this.maxQueueAgeMs = maxQueueAgeMs;
    this.queues = new Map(); this.pending = 0; this.inFlight = new Set();
    this.persistence = Promise.resolve(); this.lastBusy = new Map();
    this.deliveryTokens = new Map();
    this.personalMemoryBridge = new PersonalMemoryBridge(this, { required: memoryCaptureRequired });
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    this.statePath = join(this.dataDir, 'state.json');
    this.state = await readJson(this.statePath, { owner: null, history: [], memory: [], seen: [] });
    this.state.groups ??= {};
    this.state.rooms ??= {};
    this.state.deliveryEpochs ??= {};
    this.state.deliveredAssistantReceipts = [...new Set((this.state.deliveredAssistantReceipts || [])
      .filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))].slice(-2000);
    this.state.silentGroupMessages = Object.fromEntries(Object.entries(this.state.silentGroupMessages || {})
      .filter(([key, value]) => key.startsWith('group:') && Number.isFinite(value?.receivedAt)).slice(-500));
    await this.personalMemoryBridge.initialize();
    return this;
  }
  persist() {
    // Observation and proactive delivery can persist while a model reply is running.
    const snapshot = structuredClone(this.state);
    const write = this.persistence.then(() => saveJson(this.statePath, snapshot));
    this.persistence = write.catch(() => {});
    return write;
  }
  deliveryScope(event) {
    const member = senderId(event || {});
    if (typeof member !== 'string' || !member || typeof event?.id !== 'string' || !event.id) return null;
    if (event.group_openid) return typeof event.group_openid === 'string'
      ? `group:${hash(event.group_openid)}` : null;
    if (event.chat_type === 'group' || !this.state.owner || member !== this.state.owner) return null;
    return `private:${hash(member)}`;
  }
  deliveryEpoch(event) {
    const scope = this.deliveryScope(event);
    if (!scope) return null;
    const epoch = this.state.deliveryEpochs[scope] || 0;
    const actor = hash(senderId(event)), originId = event.id;
    const key = hash(JSON.stringify([scope, epoch, actor, originId]));
    if (!this.deliveryTokens.has(key)) {
      this.deliveryTokens.set(key, Object.freeze({ scope, epoch, actor, originId }));
      if (this.deliveryTokens.size > 2000) this.deliveryTokens.delete(this.deliveryTokens.keys().next().value);
    }
    return this.deliveryTokens.get(key);
  }
  invalidateDeliveries(event) {
    const scope = this.deliveryScope(event);
    if (!scope) return null;
    this.state.deliveryEpochs[scope] = (this.state.deliveryEpochs[scope] || 0) + 1;
    for (const [key, value] of this.deliveryTokens) if (value.scope === scope) this.deliveryTokens.delete(key);
    return this.state.deliveryEpochs[scope];
  }
  isDeliveryCurrent(event, epoch, guard = () => true) {
    if (!epoch || typeof guard !== 'function' || !guard()) return false;
    const current = this.deliveryEpoch(event);
    return Boolean(current && current.scope === epoch.scope && current.epoch === epoch.epoch
      && current.actor === epoch.actor && current.originId === epoch.originId);
  }
  deliveryReceiptKey(event, messageId) {
    return hash(JSON.stringify([this.deliveryScope(event), messageId]));
  }
  deliveryMembers(event) {
    if (!event.group_openid) return [{ context: this.state, messages: [{ id: event.id, content: String(event.content || '').trim() }] }];
    const messages = turnMessagesFor(event), members = new Map();
    for (const message of messages.length ? messages : [event]) {
      const member = message.author?.member_openid || message.author?.id;
      if (typeof member !== 'string' || !member) continue;
      if (!members.has(member)) members.set(member, { context: this.state.groups[hash(JSON.stringify([event.group_openid, member]))]
        ??= { history: [], memory: [] }, speaker: this.groupSpeaker(event.group_openid, member), messages: [] });
      members.get(member).messages.push({ id: message.id, content: String(message.content || '').trim() });
    }
    return [...members.values()];
  }
  appendDeliveredRoom(event, content, messageId, members, referenceId, { beforeFinal = false } = {}) {
    const room = this.room(event.group_openid);
    if (room.recent.some(item => item.role === 'assistant' && item.messageId === messageId)) return null;
    const speakers = members.map(member => member.speaker).filter(Boolean);
    const entry = { role: 'assistant', speaker: 'xiao_ke', content: content.slice(0, 4000), messageId,
      originId: event.id, ...(speakers.length ? { reply_to: speakers.at(-1) } : {}),
      ...(speakers.length > 1 ? { reply_to_speakers: speakers } : {}),
      ...(typeof referenceId === 'string' ? { referenceId } : {}), at: new Date(this.now()).toISOString(),
      ...(!beforeFinal ? { deferredSpeech: true } : {}) };
    const index = beforeFinal ? room.recent.findIndex(item => item.role === 'assistant' && item.originId === event.id && item.deferredSpeech) : -1;
    const recent = [...room.recent];
    if (index < 0) recent.push(entry); else recent.splice(index, 0, entry);
    room.recent = recent.slice(-60);
    const key = hash(JSON.stringify([String(event.id), String(messageId), entry.content]));
    room.assistantSeen = [...new Set([...room.assistantSeen, key])].slice(-1000);
    return entry;
  }
  async recordDeliveredAssistant(event, text, receipt, { epoch, guard = () => true } = {}) {
    const messageId = receiptId(receipt);
    if (!messageId || typeof text !== 'string' || !text.trim() || receipt?.success === false
      || !this.isDeliveryCurrent(event, epoch, guard)) return false;
    const key = this.deliveryReceiptKey(event, messageId);
    if (this.state.deliveredAssistantReceipts.includes(key)) return false;
    const members = this.deliveryMembers(event), content = text.trim().slice(0, 4000);
    const appended = [];
    for (const member of members) {
      if (member.context.history.some(item => item.role === 'assistant' && item.messageId === messageId)) continue;
      const entry = { role: 'assistant', content, messageId, originId: event.id, deferredSpeech: true };
      const previous = member.context.history, next = [...previous, entry].slice(-40);
      member.context.history = next;
      appended.push({ context: member.context, entry, previous, next });
    }
    const room = event.group_openid ? this.room(event.group_openid) : null;
    const oldRecent = room?.recent, oldSeen = room?.assistantSeen;
    const roomEntry = event.group_openid ? this.appendDeliveredRoom(event, content, messageId, members,
      receipt?.referenceId ?? receipt?.ext_info?.ref_idx ?? receipt?.body?.ext_info?.ref_idx) : null;
    const nextRecent = room?.recent, nextSeen = room?.assistantSeen;
    const oldReceipts = this.state.deliveredAssistantReceipts;
    const nextReceipts = [...oldReceipts, key].slice(-2000);
    this.state.deliveredAssistantReceipts = nextReceipts;
    // Guard, mutation and queued snapshot are synchronous. A later forget queues
    // its cleared state afterward; never restore a pre-await history snapshot.
    try { await this.persist(); }
    catch (error) {
      if (this.isDeliveryCurrent(event, epoch, guard)) {
        for (const { context, entry, previous, next } of appended) context.history = context.history === next ? previous : context.history.filter(item => item !== entry);
        if (roomEntry) {
          room.recent = room.recent === nextRecent ? oldRecent : room.recent.filter(item => item !== roomEntry);
          if (room.assistantSeen === nextSeen) room.assistantSeen = oldSeen;
        }
        this.state.deliveredAssistantReceipts = this.state.deliveredAssistantReceipts === nextReceipts ? oldReceipts
          : this.state.deliveredAssistantReceipts.filter(value => value !== key);
      }
      throw error;
    }
    return this.isDeliveryCurrent(event, epoch, guard);
  }
  room(groupOpenid) {
    return this.state.rooms[hash(groupOpenid)] ??= { recent: [], observed: [], assistantSeen: [] };
  }
  groupSpeaker(groupOpenid, memberOpenid) {
    return `member_${hash(JSON.stringify([groupOpenid, memberOpenid])).slice(0, 16)}`;
  }
  groupContext(groupOpenid) {
    if (typeof groupOpenid !== 'string' || !groupOpenid) return [];
    if (this.personalMemoryBridge.enabled && this.personalMemoryBridge.blocksRoom(groupOpenid)) return [];
    return structuredClone(this.state.rooms[hash(groupOpenid)]?.recent || []);
  }
  groupExpression(groupOpenid) {
    if(typeof groupOpenid!=='string'||!groupOpenid)return expressionView(null,this.now());
    if(this.personalMemoryBridge.enabled&&this.personalMemoryBridge.blocksRoom(groupOpenid))return expressionView(null,this.now());
    return structuredClone(expressionView(this.state.rooms[hash(groupOpenid)]?.expression,this.now()));
  }
  async setGroupExpression(groupOpenid, value, guard = () => true) {
    const expression = normalizeExpression(value, this.now());
    if (!expression || typeof groupOpenid !== 'string' || !groupOpenid || !guard()) return false;
    const room = this.state.rooms[hash(groupOpenid)];
    if (!room) return false;
    // No await between the version guard, mutation and queued snapshot. A later
    // /forget or ordinary reply therefore persists after this update.
    room.expression = expression;
    await this.persist();
    return true;
  }
  groupMemory(groupOpenid, { query = '', limit = 24, maxChars = 6500 } = {}) {
    if (typeof groupOpenid !== 'string' || !groupOpenid) return [];
    if (this.personalMemoryBridge.enabled && this.personalMemoryBridge.blocksRoom(groupOpenid)) return [];
    const entries = [...(this.state.rooms[hash(groupOpenid)]?.memory || []), ...(this.memoryCapture?.recallRoom(hash(groupOpenid), { query, limit, maxChars }) || [])];
    return roomMemorySnapshot([...new Map(entries.map(entry => [entry.id, entry])).values()], { now: this.now(), query, limit, maxChars });
  }
  privateRoomMemory(options = {}) {
    if (this.personalMemoryBridge.enabled && this.personalMemoryBridge.blocksRoom(null)) return [];
    return this.memoryCapture?.recallRoom(PRIVATE_OWNER_ROOM, options) || [];
  }
  personalMemory(groupOpenid, memberId, legacy = [], query = '') {
    if (this.personalMemoryBridge.enabled) return this.personalMemoryBridge.recall(groupOpenid, memberId, legacy, query);
    const scope = groupOpenid ? `member_${hash(JSON.stringify([groupOpenid, memberId]))}` : 'private_owner';
    const facts = this.memoryCapture?.recall(scope, { query }) || [];
    return [...legacy.filter(note => !facts.some(fact => fact.text === note)), ...facts];
  }
  async captureMemory(event) {
    if (!this.memoryCapture) return;
    if (this.personalMemoryBridge.enabled && this.personalMemoryBridge.relevantPending(event).length) return;
    const member = senderId(event);
    if (!member || !event.id) return;
    try {
      await this.memoryCapture.observe({ scope: event.group_openid ? `member_${hash(JSON.stringify([event.group_openid, member]))}` : 'private_owner',
        room: event.group_openid ? hash(event.group_openid) : PRIVATE_OWNER_ROOM, speaker: event.group_openid ? this.groupSpeaker(event.group_openid, member) : 'owner',
        messageId: event.id, content: String(event.content || ''), at: event.timestamp });
    } catch { this.onMemoryError('memory_capture_save_failed'); }
  }
  async observeGroup(event) {
    const member = senderId(event);
    if (!event.group_openid || !event.id || !member) return false;
    const room = this.room(event.group_openid);
    const key = String(event.id);
    if (room.observed.includes(key)) return false;
    room.observed = [...room.observed, key].slice(-1000);
    let content = typeof event.content === 'string' ? event.content.trim() : '';
    // Pairing codes are not useful conversational context even when pasted publicly.
    if (/^\/pair(?:\s|$)/.test(content)) content = '[群内配对命令，内容已省略]';
    if (content) {
      const referenceId = typeof event.reference_id === 'string' && event.reference_id.length > 0 && event.reference_id.length <= 512 ? event.reference_id : undefined;
      const message = { role: 'user', speaker: this.groupSpeaker(event.group_openid, member), content: content.slice(0, 4000), messageId: key,
        ...(referenceId ? { referenceId } : {}), at: new Date(this.now()).toISOString() };
      room.recent.push(message);
      room.recent = room.recent.slice(-60);
      room.memory = mergeRoomMemory(room.memory, explicitRoomCandidates([message]), [message], this.now());
    }
    await this.captureMemory(event);
    await this.persist();
    return true;
  }
  async recordGroupAssistant(groupOpenid, text, { speaker, speakers, messageId, originId, referenceId } = {}) {
    if (typeof groupOpenid !== 'string' || !groupOpenid || typeof text !== 'string' || !text.trim()) return false;
    const room = this.room(groupOpenid);
    const content = text.trim().slice(0, 4000);
    const dedupId = originId || messageId;
    const key = dedupId ? hash(JSON.stringify([String(originId || ''), String(messageId || ''), content])) : null;
    if (key ? room.assistantSeen.includes(key) : room.recent.at(-1)?.role === 'assistant' && room.recent.at(-1)?.content === content) return false;
    if (key) room.assistantSeen = [...room.assistantSeen, key].slice(-1000);
    const recipients = Array.isArray(speakers) ? [...new Set(speakers.filter(value => typeof value === 'string' && value.startsWith('member_')))] : [];
    room.recent.push({ role: 'assistant', speaker: 'xiao_ke', content, ...(speaker ? { reply_to: speaker } : {}),
      ...(recipients.length > 1 ? { reply_to_speakers: recipients } : {}), ...(messageId ? { messageId: String(messageId) } : {}), ...(typeof referenceId === 'string' ? { referenceId } : {}), ...(originId ? { originId: String(originId) } : {}), at: new Date(this.now()).toISOString() });
    room.recent = room.recent.slice(-60);
    await this.persist();
    return true;
  }
  clearGroupContext(groupOpenid) {
    if (groupOpenid) {
      const room = this.room(groupOpenid); room.recent = []; room.memory = [];
      const prefix = `group:${hash(groupOpenid)}:`;
      for (const key of Object.keys(this.state.silentGroupMessages)) if (key.startsWith(prefix)) delete this.state.silentGroupMessages[key];
    }
  }
  canReply(event) {
    return Boolean(senderId(event) && (event.group_openid || this.state.owner === senderId(event)));
  }
  handle(event, send) {
    if (['/reset', '/forget'].includes(String(event.content || '').trim()) && this.canReply(event)) this.invalidateDeliveries(event);
    const sources = sourceIdsFor(event);
    const keys = sources.map(id => eventKey({ ...event, id }));
    // A durable silent result is distinct from an actual reply. Keep ordinary
    // replay filtering across restarts, but allow one true mention to upgrade it.
    const seenKeys = keys.filter(key => this.state.seen.includes(key));
    const mentionUpgrade = Boolean(event.group_openid && event.explicit_mention === true && seenKeys.length
      && seenKeys.every(key => Object.hasOwn(this.state.silentGroupMessages, key)));
    if (keys.some(key => this.inFlight.has(key)) || (!mentionUpgrade && keys.length && keys.every(key => this.state.seen.includes(key)))) return Promise.resolve();
    if (mentionUpgrade) event = { ...event, allow_silence: false,
      _receivedAt: Math.min(Number.isFinite(event._receivedAt) ? event._receivedAt : this.now(),
        ...seenKeys.map(key => this.state.silentGroupMessages[key].receivedAt)) };
    const turn = turnMessagesFor(event);
    const observed = event.group_openid
      ? turn.length ? Promise.all(turn.map(message => this.observeGroup({ ...event, ...message, group_openid: event.group_openid }))) : this.observeGroup(event)
      : Promise.resolve(false);
    observed.catch(() => {});
    const enqueuedAt = this.now();
    const eventTime = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
    const receivedAt = Number.isFinite(event._receivedAt) ? Math.min(enqueuedAt, event._receivedAt) : enqueuedAt;
    const replyStartedAt = Number.isFinite(eventTime) ? Math.min(receivedAt, eventTime) : receivedAt;
    const expired = () => Boolean(event.group_openid && this.now() - replyStartedAt >= this.maxQueueAgeMs);
    const deliver = async (text, options) => {
      if (expired()) { const error = new Error('group_reply_expired'); error.code = 'GROUP_REPLY_EXPIRED'; throw error; }
      return send(text, options);
    };
    if (this.pending >= 8) {
      if (!this.canReply(event)) return Promise.resolve();
      keys.forEach(key => this.inFlight.add(key));
      return observed.then(async () => {
        if (mentionUpgrade) {
          seenKeys.forEach(key => delete this.state.silentGroupMessages[key]);
          await this.persist();
        }
        const busyKey = event.group_openid ? `group:${hash(event.group_openid)}` : `private:${senderId(event)}`;
        const now = this.now();
        if (!expired() && (!this.lastBusy.has(busyKey) || now - this.lastBusy.get(busyKey) >= 30000)) {
          this.lastBusy.set(busyKey, now);
          try { await deliver('这会儿消息有点多，这条暂时排不进来，等我回完前面的再说。'); }
          catch (error) { this.lastBusy.delete(busyKey); throw error; }
        }
        this.state.seen = [...new Set([...this.state.seen, ...keys])].slice(-500);
        await this.persist();
        return { status: expired() ? 'expired' : 'busy' };
      })
        .finally(() => keys.forEach(key => this.inFlight.delete(key)));
    }
    keys.forEach(key => this.inFlight.add(key));
    this.pending++;
    const scope = event.group_openid ? `group:${hash(event.group_openid)}` : `private:${senderId(event)}`;
    const job = (this.queues.get(scope) || Promise.resolve()).then(async () => {
      try {
        await observed;
        if (mentionUpgrade) {
          // Consume before any model or send attempt; an uncertain delivery must
          // never reopen the same explicit upgrade, including after restart.
          seenKeys.forEach(key => delete this.state.silentGroupMessages[key]);
          await this.persist();
        }
        if (expired()) {
          this.state.seen = [...new Set([...this.state.seen, ...keys])].slice(-500);
          await this.persist();
          return { status: 'expired' };
        }
        return await this.process({ ...event, _queuedAt: enqueuedAt }, deliver, { mentionUpgrade });
      }
      catch (error) {
        if (error.code === 'GROUP_REPLY_EXPIRED' || expired()) {
          this.state.seen = [...new Set([...this.state.seen, ...keys])].slice(-500);
          await this.persist();
          return { status: 'expired' };
        }
        const failedKeys = new Set(keys);
        if (!mentionUpgrade) this.state.seen = this.state.seen.filter(id => !failedKeys.has(id));
        await this.persist();
        throw error;
      }
    });
    const settled = job.finally(() => { this.pending--; keys.forEach(key => this.inFlight.delete(key)); });
    const tail = settled.catch(() => {});
    this.queues.set(scope, tail);
    void tail.then(() => { if (this.queues.get(scope) === tail) this.queues.delete(scope); });
    return settled;
  }
  async process(event, send, { mentionUpgrade = false } = {}) {
    const processStarted = this.now();
    const id = senderId(event);
    const isGroup = Boolean(event.group_openid);
    const key = eventKey(event);
    if (!id || !event.id || (!mentionUpgrade && this.state.seen.includes(key)) || (event.chat_type === 'group' && !isGroup)) return;
    const text = (event.content || '').trim();
    const turn = turnMessagesFor(event);
    if (turn.length > 1 && turn.some(message => /^\s*\//.test(message.content) || /^(?:安静一会儿|出来聊聊)[。！!～~]?$/.test(message.content.trim()))) throw new Error('invalid_group_turn');
    if (!isGroup && !this.state.owner) {
      const candidate = text.startsWith('/pair ') ? hash(text.slice(6).trim()) : '';
      if (!candidate) return send('我收到你的消息啦。这里还没完成主人配对，请把设置时提供的 /pair 配对码发到这个私聊，连上后就能直接聊天。');
      if (!this.pairingHash || !/^[a-f0-9]{64}$/.test(this.pairingHash)) return send('本机配对设置不完整，需要先修复设置。');
      if (!timingSafeEqual(Buffer.from(candidate), Buffer.from(this.pairingHash))) return send('这个配对码没有匹配，请核对本机设置提供的配对码，再在这里发送。');
      this.state.owner = id;
      this.state.seen.push(event.id);
      await this.persist();
      await send('连上啦，我是小柯。以后你在这里说话，我就能接到。今天想和我聊什么？');
      return;
    }
    if (!isGroup && id !== this.state.owner) return;
    if (!await this.personalMemoryBridge.ensure(event)) return send('刚才的记忆清理或转存还没完成，暂时不能接着使用这段旧记录。');
    if (['/reset', '/forget'].includes(text)) this.invalidateDeliveries(event);
    const turnDeliveryEpoch = this.deliveryEpoch(event);
    this.state.seen = [...new Set([...this.state.seen, ...sourceIdsFor(event).map(id => eventKey({ ...event, id }))])].slice(-500);
    await this.persist();
    if (isGroup && /^\/pair(?:\s|$)/.test(text)) return send('群聊里直接 @ 我就能聊天。主人配对请在单聊中完成，配对码不要发到群里。');
    // A group member never receives the private owner's history or another member's context.
    const context = isGroup
      ? (this.state.groups[hash(JSON.stringify([event.group_openid, id]))] ??= { history: [], memory: [] })
      : this.state;
    if (text === '/reset') {
      await this.characterGrowth?.forget(event);
      context.history = []; this.clearGroupContext(event.group_openid); await this.memoryCapture?.resetRoom(isGroup ? hash(event.group_openid) : PRIVATE_OWNER_ROOM); await this.persist(); return send(isGroup ? '这段个人对话、本群共享聊天和话题记忆已清空，明确保存的个人记忆仍在。我们重新聊。' : '这段聊天记录和私聊话题记忆已清空，明确保存的个人记忆仍在。我们重新聊。');
    }
    if (text === '/forget') {
      if (this.personalMemoryBridge.enabled) {
        try { await this.personalMemoryBridge.forget(event); }
        catch (error) {
          this.onMemoryError('personal_memory_forget_incomplete');
          return send(error?.code === 'personal_memory_forget_not_recorded'
            ? '清空请求还没保存成功，旧记录仍在；请稍后重试。'
            : '清空还没完成，已保留清理记录；恢复后会接着处理，不会把它当成已经清空。');
        }
        return send(isGroup ? '你的当前聊天、个人记忆、本群共享聊天和话题记忆都已清空。' : '当前对话的聊天记录和保存的记忆都已清空。');
      }
      await this.characterGrowth?.forget(event);
      await this.memoryCapture?.forget(isGroup ? `member_${hash(JSON.stringify([event.group_openid, id]))}` : 'private_owner', isGroup ? hash(event.group_openid) : PRIVATE_OWNER_ROOM);
      context.history = []; context.memory = []; delete context.expression; if(isGroup)delete this.room(event.group_openid).expression; this.clearGroupContext(event.group_openid); await this.persist(); return send(isGroup ? '你的当前聊天、个人记忆、本群共享聊天和话题记忆都已清空。' : '当前对话的聊天记录和保存的记忆都已清空。');
    }
    const memoryPage = text.match(/^\/memory(?:\s+(\d+))?$/);
    if (memoryPage && this.personalMemoryBridge.enabled) return send(this.personalMemoryBridge.page(event, Number(memoryPage[1] || 1)));
    if (text === '/memory') { const facts = this.personalMemory(event.group_openid, id, context.memory, text); return send(facts.length ? facts.map(fact => typeof fact === 'string' ? fact : fact.text).join('\n') : '目前没有专门保存的长期记忆。'); }
    if (text === '/roommemory') {
      const entries = isGroup ? this.groupMemory(event.group_openid) : this.privateRoomMemory();
      const labels = { topic: '话题', agreement: '约定', vocabulary: '词汇', request: '未完成需求' };
      return send(entries.length ? entries.map(entry => `${labels[entry.kind]}：${entry.text}`).join('\n') : isGroup ? '本群目前没有保存的话题记忆。' : '这段私聊目前没有保存的话题记忆。');
    }
    if (text.startsWith('/remember ')) {
      if (this.personalMemoryBridge.enabled) return this.personalMemoryBridge.remember(event, send);
      const note = text.slice(10).trim().slice(0, 1000);
      if (!context.memory.includes(note)) context.memory.push(note);
      context.memory = context.memory.slice(-30);
      await this.persist(); return send('记住了。用 /memory 可以查看，/forget 可以清空。');
    }
    if (this.personalMemoryBridge.enabled && await this.personalMemoryBridge.amend(event, send)) return;
    if (text === '/help') return send((isGroup ? '群里可以接着话题聊。可见群消息作为本群共享上下文；个人记忆按群和成员分别保存，与私聊隔离。' : '直接发文字就能聊。\n主人私聊工作：/work 任务内容 创建独立文本文件提案；/workstatus [编号] 查看；/answer 编号 答案 补充；/approve 编号 明确批准；/reject 编号 拒绝；/cancel 编号 取消。审批仅写入该任务独立工作目录，不执行shell。') + '\n/remember 内容：长期记住\n/memory [页码]：查看当前对话记忆和编号\n/memory-edit 编号 新内容：编辑一条保存的笔记\n/memory-delete 编号：删除一条保存的笔记\n/roommemory：查看本群话题、约定、词汇与未完成需求\n/reset：清空当前最近聊天及本群共享上下文和话题记忆\n/forget：清空当前聊天、个人记忆及本群共享上下文和话题记忆\n聊天保存在本项目的本机资料目录；生成回复时会把当前授权会话的上下文与记忆交给你配置的模型服务。Mock 演示不会上传。');
    if (!isGroup) await this.captureMemory(event);
    const prepared = await this.prepareInput(event);
    try {
    const extra = prepared && typeof prepared === 'object' && !Array.isArray(prepared) ? { ...prepared } : {};
    if (this.characterGrowth) extra.characterGrowth = this.characterGrowth.snapshot(event);
    for (const field of ['history', 'memory', 'text', 'mode', 'roomHistory', 'roomMemory', 'speaker', 'participants', 'turnMessages']) delete extra[field];
    const hasMedia = (Array.isArray(extra.visionFiles) && extra.visionFiles.length > 0) || (Array.isArray(extra.mediaCatalog) && extra.mediaCatalog.length > 0)
      || (Array.isArray(extra.richContext) && extra.richContext.length > 0);
    const turnText = turn.length ? turn.map(message => message.content).join('\n') : text;
    if (!turnText.trim() && !hasMedia) return send(event.attachments?.length ? '这条附件暂时没读到，可以加一句文字说明。' : '你好呀，我在。想聊什么？');
    if (turnText.length > 8000) return send('这条有点长，分成几段发给我吧。');
    let progressDelivery = Promise.resolve();
    let generated, generationError;
    const speaker = isGroup ? this.groupSpeaker(event.group_openid, id) : undefined;
    const inputIds = new Set(sourceIdsFor(event));
    const roomHistory = isGroup ? this.groupContext(event.group_openid).filter(entry => !(entry.role === 'user' && inputIds.has(entry.messageId))) : undefined;
    const members = new Map();
    const turnMessages = [];
    const memorySources = [];
    for (const message of turn.length ? turn : [{ ...event, content: text }]) {
      const member = isGroup ? message.author?.member_openid || message.author?.id : id;
      const memberContext = isGroup ? (this.state.groups[hash(JSON.stringify([event.group_openid, member]))] ??= { history: [], memory: [] }) : context;
      if (!members.has(member)) members.set(member, { context: memberContext, speaker: isGroup ? this.groupSpeaker(event.group_openid, member) : undefined, messages: [] });
      const participant = members.get(member);
      participant.messages.push(message.content.trim());
      if (isGroup) {
        const parsedTime = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
        const receivedTime = Number.isFinite(message._receivedAt) ? message._receivedAt : this.now();
        const publicMessage = { speaker: participant.speaker, content: message.content, messageId: message.id,
          ...(typeof message.allow_silence === 'boolean' || message.explicit_mention === true
            ? { attention: message.explicit_mention === true ? 'mentioned' : message.allow_silence === false ? 'addressed' : 'ambient' } : {}),
          at: new Date(Number.isFinite(parsedTime) ? parsedTime : receivedTime).toISOString() };
        memorySources.push(publicMessage);
        turnMessages.push(publicMessage);
      }
    }
    const participants = [...members.entries()].map(([memberId, member]) => ({ speaker: member.speaker, memory: this.personalMemory(event.group_openid, memberId, member.context.memory, turnText) }));
    const multipleParticipants = isGroup && members.size > 1;
    if (isGroup) {
      const room = this.room(event.group_openid);
      room.memory = mergeRoomMemory(room.memory, explicitRoomCandidates(memorySources, { allowRequests: true }), memorySources, this.now());
      await this.persist();
    }
    const progressTimer = this.progressDelayMs > 0 && isGroup && event.explicit_mention !== false && event.allow_silence !== true ? setTimeout(() => {
      progressDelivery = Promise.resolve().then(() => send('还在想这句')).catch(() => {});
    }, this.progressDelayMs) : null;
    const generationStarted = this.now();
    try { generated = await this.generate({ ...extra, messageId:event.id, history: multipleParticipants ? [] : context.history, memory: multipleParticipants ? [] : this.personalMemory(event.group_openid, id, context.memory, turnText), text, ...((isGroup?this.room(event.group_openid):context).expression?{expressionState:expressionView((isGroup?this.room(event.group_openid):context).expression,this.now())}:{}),
      ...(isGroup ? { roomHistory, roomMemory: this.groupMemory(event.group_openid, { query: turnText }), speaker, participants, turnMessages }
        : this.memoryCapture ? { roomMemory: this.privateRoomMemory({ query: turnText }) } : {}) }); }
    catch (error) { generationError = error; }
    finally { clearTimeout(progressTimer); }
    const generationFinished = this.now();
    // Keep the progress reply and answer in order, including their QQ msg_seq values.
    await progressDelivery;
    if (generationError) throw generationError;
    const expression=normalizeExpression(generated?.expression,this.now());
    if(expression && this.isDeliveryCurrent(event,turnDeliveryEpoch)) {
      (isGroup?this.room(event.group_openid):context).expression=expression;
      await this.persist();
    }
    // Growth is grounded in received words, not in whether a text bubble was
    // sent. Listening and deferred voice are equally valid learning moments.
    if (this.characterGrowth && generated?.character_updates?.length) {
      const sources = (turn.length ? turn : [event]).map(message => ({id:message.id,content:message.content || ''}));
      try { await this.characterGrowth.apply(event, generated.character_updates, {
        expectedRevision:extra.characterGrowth.revision, messages:sources,
        guard:() => this.isDeliveryCurrent(event, turnDeliveryEpoch)
      }); } catch { this.onMemoryError(new Error('character_growth_not_committed')); }
    }
    const stickerChoice=validateStickerSelection({catalog:extra.mediaCatalog||[],input:event,media:generated?.media,roomMessages:roomHistory||[]});
    if(!stickerChoice.allowed&&generated?.media?.send_id){
      generated={...generated,media:{...generated.media,send_id:''}};
      if(!generated.reply?.trim()&&!generated.media.voice_id&&!generated.media.create_prompt&&!generated.speech?.text){
        if(isGroup&&event.allow_silence===true&&event.explicit_mention!==true)generated.social={...generated.social,action:'silent'};
        else generated.reply='我这会儿没找到贴合这句话的表情。';
      }
    }
    const mathDocument = normalizeMathDocument(generated?.math_document);
    const answer = (typeof generated === 'string' ? generated : generated?.reply) || (mathDocument ? mathDocumentText(mathDocument) : '');
    const hasOutputMedia = [generated?.media?.send_id, generated?.media?.voice_id, generated?.media?.create_prompt, generated?.speech?.text]
      .some(value => typeof value === 'string' && value.trim());
    const social = generated?.social && typeof generated.social === 'object' && !Array.isArray(generated.social) && ['say', 'silent'].includes(generated.social.action)
      ? { action: generated.social.action, next_wake_ms: Number.isFinite(generated.social.next_wake_ms) ? Math.max(0, generated.social.next_wake_ms) : null,
        active_topic: typeof generated.social.active_topic === 'string' ? generated.social.active_topic.slice(0, 280) : '',
        pending_thought: typeof generated.social.pending_thought === 'string' ? generated.social.pending_thought.slice(0, 280) : '', clear_topic: generated.social.clear_topic === true,
        ...(generated.social.wait && typeof generated.social.wait === 'object' && !Array.isArray(generated.social.wait) ? { wait: {
          mode: ['timer', 'condition', 'indefinite'].includes(generated.social.wait.mode) ? generated.social.wait.mode : 'timer',
          keywords: Array.isArray(generated.social.wait.keywords) ? generated.social.wait.keywords.filter(value => typeof value === 'string' && value.trim()).slice(0, 12).map(value => value.slice(0, 60)) : [],
          speakers: Array.isArray(generated.social.wait.speakers) ? generated.social.wait.speakers.filter(value => typeof value === 'string' && /^member_[a-f0-9]{16}$/.test(value)).slice(0, 20) : [],
          match: generated.social.wait.match === 'all' ? 'all' : 'any'
        } } : {}) } : undefined;
    const collectionDeclined=/(?:不要|不用|别|不许|不想).{0,10}(?:收藏|保存|记住|存图)/.test(turnText);
    const rememberSticker = !collectionDeclined && (generated?.media?.remember_sticker === true || generated?.media?.image_kind === 'sticker') && extra.visionFiles?.some(f=>f.id===generated.media.note_id) && typeof generated?.media?.note==='string' && Boolean(generated.media.note.trim());
    if (!rememberSticker && !hasOutputMedia && isGroup && event.allow_silence === true && event.explicit_mention !== true && social?.action === 'silent' && typeof answer === 'string' && !answer.trim()) {
      for (const id of sourceIdsFor(event)) {
        const source = turn.find(message => message.id === id) || event;
        this.state.silentGroupMessages[eventKey({ ...event, id })] = {
          receivedAt: Number.isFinite(source._receivedAt) ? source._receivedAt : this.now()
        };
      }
      const retained = new Set(this.state.seen);
      this.state.silentGroupMessages = Object.fromEntries(Object.entries(this.state.silentGroupMessages)
        .filter(([key]) => retained.has(key)).slice(-500));
      await this.persist();
      return { status: 'silent', social };
    }
    if (typeof answer !== 'string' || (!answer.trim() && !hasOutputMedia && !rememberSticker)) throw new Error('empty_model_reply');
    const metadata = { chatReply: true };
    if(typeof generated?.speech?.text==='string' && generated.speech.text.trim())metadata.speech={text:generated.speech.text.trim(),mood:generated.speech.mood};
    if (mathDocument) metadata.math_document = mathDocument;
    if (Array.isArray(generated?.messages)) metadata.messages = generated.messages.filter(item => typeof item === 'string' && item.trim()).slice(0, 3);
    if (generated?.media && typeof generated.media === 'object' && !Array.isArray(generated.media)) metadata.media = {
      send_id: typeof generated.media.send_id === 'string' ? generated.media.send_id.slice(0, 200) : '',
      ...(rememberSticker?{remember_sticker:true}:{}),
      collect_id: collectionDeclined ? '' : rememberSticker ? generated.media.note_id : typeof generated.media.collect_id === 'string' ? generated.media.collect_id.slice(0, 200) : '',
      label: typeof generated.media.label === 'string' ? generated.media.label.slice(0, 120) : '',
      ...(typeof generated.media.create_prompt === 'string' && generated.media.create_prompt.trim() ? {
        create_prompt: generated.media.create_prompt,
        title: typeof generated.media.title === 'string' ? generated.media.title.slice(0, 80) : ''
      } : {}),
      ...(typeof generated.media.voice_id === 'string' && generated.media.voice_id ? { voice_id: generated.media.voice_id.slice(0, 200) } : {}),
      ...(!collectionDeclined && typeof generated.media.note_id === 'string' && generated.media.note_id && extra.visionFiles?.some(file => file.id === generated.media.note_id) ? {
        note_id: generated.media.note_id.slice(0, 200), note: typeof generated.media.note === 'string' ? generated.media.note.slice(0, 300) : '',
        usage: typeof generated.media.usage === 'string' ? generated.media.usage.slice(0, 200) : '',
        tags: Array.isArray(generated.media.tags) ? generated.media.tags.filter(tag => typeof tag === 'string').slice(0, 12).map(tag => tag.slice(0, 60)) : []
      } : {})
    };
    if (typeof generated?.delivery?.reply_to_message_id === 'string' && generated.delivery.reply_to_message_id) metadata.delivery = {
      reply_to_message_id: generated.delivery.reply_to_message_id.slice(0, 512)
    };
    if (isGroup && Array.isArray(generated?.delivery?.mention_speakers)) metadata.delivery = { ...metadata.delivery,
      mention_speakers: [...new Set(generated.delivery.mention_speakers.filter(value => typeof value === 'string' && /^member_[a-f0-9]{16}$/.test(value)))].slice(0, 5) };
    if (['info', 'warning', 'error'].includes(generated?.feedback?.level) && typeof generated.feedback.message === 'string' && generated.feedback.message.trim()) {
      metadata.feedback = { level: generated.feedback.level, message: generated.feedback.message.slice(0, 500) };
    }
    if (isGroup && Array.isArray(generated?.vocabulary_actions)) metadata.vocabulary_actions = generated.vocabulary_actions
      .filter(action => action?.operation === 'propose').slice(0, 4);
    if (mathDocument) { delete metadata.messages; delete metadata.media; delete metadata.speech; }
    const deliveryStarted = this.now();
    const delivery = await send(answer, metadata);
    const deliveredAt = this.now();
    const deferredSpeech = Boolean(delivery?.deferredSpeech);
    const receivedAt = Number.isFinite(event._receivedAt) ? event._receivedAt : event._queuedAt ?? processStarted;
    void Promise.resolve().then(() => this.onTiming({ at: new Date(deliveredAt).toISOString(), is_group: isGroup,
      queue_ms: Math.max(0, processStarted - receivedAt), prepare_ms: Math.max(0, generationStarted - processStarted),
      model_ms: Math.max(0, generationFinished - generationStarted), postprocess_ms: Math.max(0, deliveryStarted - generationFinished),
      delivery_ms: Math.max(0, deliveredAt - deliveryStarted), total_ms: Math.max(0, deliveredAt - receivedAt),
      history_items: context.history.length, room_items: roomHistory?.length || 0, vision_inputs: extra.visionFiles?.length || 0 })).catch(() => {});
    if (deferredSpeech) {
      if (!this.isDeliveryCurrent(event, turnDeliveryEpoch)) return { status: 'deferred_speech' };
      const actual = deliveredReceipts(delivery), recipients = this.deliveryMembers(event);
      const unseen = actual.filter(receipt => !this.state.deliveredAssistantReceipts.includes(this.deliveryReceiptKey(event, receipt.messageId)));
      for (const member of recipients) {
        const users = member.messages.filter(message => !member.context.history.some(item => item.role === 'user' && item.messageId === message.id))
          .map(message => ({ role: 'user', content: message.content, messageId: message.id }));
        const progress = unseen.filter(receipt => !member.context.history.some(item => item.role === 'assistant' && item.messageId === receipt.messageId))
          .map(receipt => ({ role: 'assistant', content: receipt.content, messageId: receipt.messageId, originId: event.id }));
        // A very fast background completion can arrive before send() returns its
        // deferred result. Keep the original user/progress before that receipt.
        const before = member.context.history.findIndex(item => item.role === 'assistant' && item.originId === event.id && item.deferredSpeech);
        if (before < 0) member.context.history.push(...users, ...progress);
        else member.context.history.splice(before, 0, ...users, ...progress);
        member.context.history = member.context.history.slice(-40);
      }
      if (isGroup) for (const receipt of actual) this.appendDeliveredRoom(event, receipt.content, receipt.messageId, recipients, receipt.referenceId, { beforeFinal: true });
      this.state.deliveredAssistantReceipts = [...new Set([...this.state.deliveredAssistantReceipts,
        ...actual.map(receipt => this.deliveryReceiptKey(event, receipt.messageId))])].slice(-2000);
      // The generated answer, personality changes and resolved room requests
      // remain uncommitted until actual delivery; background user capture above
      // is independent and still runs normally.
      await this.persist();
      return { status: 'deferred_speech' };
    }
    if(!answer.trim()&&!hasOutputMedia){await this.persist();return {status:"silent",social};}
    const deliveredText = typeof delivery?.sent_text === 'string' && delivery.sent_text.trim() ? delivery.sent_text
      : answer || (Array.isArray(delivery?.delivered_messages) ? delivery.delivered_messages.map(item => item.content || '').filter(Boolean).join('\n') : '[媒体回复已送达]');
    const receipts = Array.isArray(delivery?.delivered_messages) ? delivery.delivered_messages.filter(item => item
      && typeof item.content === 'string' && item.content.trim() && typeof item.messageId === 'string' && item.messageId.length > 0 && item.messageId.length <= 512)
      .slice(0, 16).map(item => ({ content: item.content,
        messageId: item.messageId, ...(typeof item.referenceId === 'string' && item.referenceId.length > 0 && item.referenceId.length <= 512 ? { referenceId: item.referenceId } : {}) })) : [];
    for (const member of members.values()) {
      const ownText = member.messages.join('\n');
      for (const note of this.memoryCapture || this.personalMemoryBridge.enabled ? [] : supportedMemories(generated?.memories, ownText)) {
        if (!member.context.memory.includes(note)) member.context.memory.push(note);
      }
      member.context.memory = member.context.memory.slice(-30);
      member.context.history.push(...member.messages.map(content => ({ role: 'user', content })), { role: 'assistant', content: deliveredText });
      member.context.history = member.context.history.slice(-40);
    }
    const deliveredId = delivery?.id || delivery?.body?.id;
    if (isGroup) {
      const room = this.room(event.group_openid);
      room.memory = mergeRoomMemory(room.memory, generated?.room_memories, memorySources, this.now());
    }
    if (isGroup) {
      const recipients = { speaker, speakers: participants.map(participant => participant.speaker), originId: event.id };
      if (receipts.length) {
        for (const receipt of receipts) await this.recordGroupAssistant(event.group_openid, receipt.content, { ...recipients,
          messageId: receipt.messageId, referenceId: receipt.referenceId });
      } else await this.recordGroupAssistant(event.group_openid, deliveredText, { ...recipients,
        messageId: deliveredId, referenceId: delivery?.ext_info?.ref_idx ?? delivery?.body?.ext_info?.ref_idx });
    }
    await this.persist();
    return { status: 'replied', ...(social ? { social } : {}) };
    } finally {
      // Prepared images also need releasing when validation or persistence exits before generation.
      await this.releaseInput(prepared, event);
    }
  }
}
