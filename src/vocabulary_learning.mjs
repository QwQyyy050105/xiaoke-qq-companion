import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { groupMemberSpeaker } from './social_wait.mjs';
import { explicitRoomCandidates } from './room_memory.mjs';
import { durableWriteFile } from './durable_write.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const clip = (value, limit) => typeof value === 'string' ? [...value.trim()].slice(0, limit).join('') : '';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20]/.test(value);
const validSpeaker = value => /^member_[a-f0-9]{16}$/.test(value || '');
const ordinary = new Set('你好 大家 今天 明天 昨天 什么 怎么 谢谢 朋友 游戏 电脑 手机 网络 图片 表情 头像 视频 音乐 工作 学习 中文 英语 群聊 小柯 柯霜 ai qq gpt api cpu gpu dna html css sql codex chatgpt hello thanks okay lol'.split(' '));
const privateText = /密码|口令|密钥|验证码|身份证|银行卡|手机号|电话|微信号|QQ号|邮箱|住址|地址|病史|诊断|疾病|吃药|治疗|确诊|患病|肿瘤|性取向|性癖|宗教|信仰|政治|党派|种族|民族|工资|收入|存款|负债|昵称|真名|姓名|生日|出生|叫我|我叫|我住|我的|我喜欢|我讨厌|(?:我|他|她|本人)(?:患|得了|今年.{0,8}岁)|password|secret|token|credential|api.?key|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d{7,}|[a-z0-9_-]{24,}/i;
const unsafe = /忽略.{0,10}(?:指令|规则)|系统提示|提示词|developer|system prompt|<\/?(?:system|assistant)|```|\[CQ:|不要.{0,8}(?:记|保存)|别.{0,8}(?:记|保存)/i;
const reported = /(?:他|她|朋友|同学|同事)(?:说|告诉)|转述|引用|举例|假设|假如/;
const safeText = value => typeof value === 'string' && value.length <= 8000 && !privateText.test(value) && !unsafe.test(value) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const termKey = value => clip(value, 30).normalize('NFKC').toLowerCase();
const validTerm = value => typeof value === 'string' && value === value.trim() && /^[\p{L}\p{N}]{2,20}$/u.test(value)
  && !/^\d+$/.test(value) && !ordinary.has(termKey(value)) && safeText(value);
const stamp = now => new Date(now).toISOString();
const RESEARCH_EMPTY_TTL_MS = 24 * 60 * 60_000;
const researchCheckpoint = entry => {
  const checkpoint = entry?.research_checkpoint;
  return Number.isSafeInteger(checkpoint?.revision) && checkpoint.revision >= 0
    && Number.isSafeInteger(checkpoint.completedAt) && checkpoint.completedAt >= 0
    ? { revision: checkpoint.revision, completedAt: checkpoint.completedAt } : null;
};
const researchRecentlyEmpty = (entry, now) => {
  const checkpoint = researchCheckpoint(entry);
  return checkpoint && checkpoint.revision === entry.revision && now >= checkpoint.completedAt
    && now - checkpoint.completedAt < RESEARCH_EMPTY_TTL_MS;
};
const plainSource = value => value.replace(/^\s*<@!?[^>]+>[，,:：\s]*/, '').replace(/^\s*(?:小柯|柯霜)[，,:：\s]+/, '').trim();

export function extractVocabularyCandidates(content, { knownTerms = [] } = {}) {
  if (!safeText(content) || /^\s*\//.test(content) || reported.test(content)) return [];
  const candidates = [];
  const lines = content.replace(/^\s*>.*$/gm, '').match(/[^。！？；\n]+[。！？；]?/g) || [];
  for (const part of lines) {
    const source = plainSource(part);
    if (source.length < 3 || source.length > 280 || !safeText(source)) continue;
    const definition = source.match(/^(?:本群|群里|我们(?:群里)?|咱们)?\s*[“"‘「『]?([\p{L}\p{N}]{2,20})[”"’」』]?\s*(是指|指的是|意思是|代表|就是)\s*([^。！？；]+)[。！]?$/u);
    const quotedAssertion = /^(?:本群|群里|我们(?:群里)?|咱们)?\s*[“"‘「『][\p{L}\p{N}]{2,20}(?:是指|指的是|意思是|代表|就是)/u.test(source);
    const explicitDefinition = definition && (definition[2] !== '就是' || /^(?:本群|群里|我们|咱们)/.test(source) || knownTerms.some(term => termKey(term) === termKey(definition[1])));
    if (explicitDefinition && !quotedAssertion && validTerm(definition[1]) && !/[?？吗么]$/.test(definition[3]) && !/[”"’」』]$/.test(source.replace(/[。！]$/, ''))) {
      candidates.push({ term: definition[1], source, meaning: clip(definition[3], 200), declared: true });
    } else {
      const words = [...source.matchAll(/[“"‘「『]([\p{L}\p{N}]{2,12})[”"’」』]/gu)].map(match => match[1]);
      for (const match of source.matchAll(/(?:^|[，,\s])([\p{L}\p{N}]{2,12})(?:是什么梗|是什么意思|是啥梗|啥意思|这个词)/gu)) words.push(match[1]);
      for (const match of source.matchAll(/\b([a-z]{2,8})\b/gi)) if (!/[aeiou]/i.test(match[1]) || /(?:yyds|awsl|xswl)/i.test(match[1])) words.push(match[1]);
      for (const term of new Set(words)) if (validTerm(term) && source.length <= 160) candidates.push({ term, source, meaning: '', declared: false });
    }
    if (candidates.length >= 4) break;
  }
  return candidates.slice(0, 4);
}

function messagesFor(event) {
  if (!validId(event?.group_openid) || event.is_self || event.from_self || event.author?.bot) return [];
  const turns = Array.isArray(event.turn_messages) ? event.turn_messages : [event];
  return turns.slice(0, 20).flatMap(item => {
    const member = item?.author?.member_openid || item?.author?.id;
    if (!item || !validId(item.id) || !validId(member) || item.is_self || item.from_self || item.author?.bot
      || (item.group_openid && item.group_openid !== event.group_openid) || !safeText(item.content)) return [];
    return [{ messageId: item.id, speaker: groupMemberSpeaker(event.group_openid, member), content: item.content }];
  });
}

function evidenceView(item) {
  if (!item || !validSpeaker(item.speaker) || !validId(item.messageId) || !safeText(item.source) || item.source.length > 280) return null;
  return { speaker: item.speaker, messageId: item.messageId, source: item.source, at: clip(item.at, 40), ...(item.meaning ? { meaning: clip(item.meaning, 200) } : {}) };
}
function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 1500) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')
      || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname) || /(?:token|secret|key|password)=/i.test(url.search)) return '';
    return url.href;
  } catch { return ''; }
}
function webView(item) {
  if (!item || !safeText(item.meaning) || !item.meaning) return null;
  const sources = (Array.isArray(item.sources) ? item.sources : []).slice(0, 3).flatMap(source => {
    const url = sourceUrl(source?.url);
    return url ? [{ url, title: clip(source.title, 150), excerpt: safeText(source.excerpt || '') ? clip(source.excerpt, 300) : '', verified: source.verified === true }] : [];
  });
  return sources.length ? { meaning: clip(item.meaning, 200), sources, at: clip(item.at, 40), kind: 'web_research' } : null;
}
function entryView(entry) {
  if (!entry || !validTerm(entry.term) || !/^vocab_[a-f0-9]{20}$/.test(entry.id)) return null;
  return { id: entry.id, term: entry.term, status: ['pending', 'confirmed', 'rejected'].includes(entry.status) ? entry.status : 'pending',
    meaning: safeText(entry.meaning || '') ? clip(entry.meaning, 200) : '', confirmedBy: ['member', 'owner_local'].includes(entry.confirmedBy) ? entry.confirmedBy : '',
    revision: Number.isSafeInteger(entry.revision) ? entry.revision : 0, createdAt: clip(entry.createdAt, 40), updatedAt: clip(entry.updatedAt, 40),
    observations: (entry.observations || []).slice(-6).map(evidenceView).filter(Boolean),
    member_confirmations: (entry.member_confirmations || []).slice(-6).map(evidenceView).filter(Boolean),
    web_evidence: (entry.web_evidence || []).slice(-3).map(webView).filter(Boolean),
    review: entry.review && ['owner_local', 'model_research'].includes(entry.review.origin) ? {
      origin: entry.review.origin, operation: clip(entry.review.operation, 20), note: safeText(entry.review.note || '') ? clip(entry.review.note, 160) : '', at: clip(entry.review.at, 40)
    } : null };
}
// Keep technical no-result checkpoints off the model-facing vocabulary view.
function storedEntryView(entry) {
  const view = entryView(entry), checkpoint = researchCheckpoint(entry);
  return view && checkpoint ? { ...view, research_checkpoint: checkpoint } : view;
}

export class VocabularyLearning {
  constructor({ dataDir, now = Date.now, save = durableWriteFile }) {
    if (!isAbsolute(dataDir || '')) throw new Error('vocabulary_absolute_data_dir_required');
    this.dataDir = dataDir; this.now = now; this.save = save; this.queue = Promise.resolve(); this.tickets = new Map();
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    this.file = join(this.dataDir, 'vocabulary_state.json');
    this.state = { version: 1, rooms: Object.create(null) };
    let saved;
    try { if ((await stat(this.file)).size > 64 * 1024 * 1024) throw new Error('vocabulary_state_too_large'); saved = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved && (!saved.rooms || typeof saved.rooms !== 'object' || Array.isArray(saved.rooms))) throw new Error('vocabulary_state_invalid');
    for (const [scope, room] of Object.entries(saved?.rooms || {}).slice(0, 128)) {
      if (!/^[a-f0-9]{64}$/.test(scope) || !room || !Array.isArray(room.entries)) continue;
      this.state.rooms[scope] = { epoch: Number.isSafeInteger(room.epoch) ? room.epoch : 0,
        seen: Array.isArray(room.seen) ? room.seen.filter(id => /^[a-f0-9]{64}$/.test(id)).slice(-256) : [],
        observedEpochs: Array.isArray(room.observedEpochs) ? room.observedEpochs.filter(item => /^[a-f0-9]{64}$/.test(item?.id) && Number.isSafeInteger(item.epoch))
          .slice(-256).map(item => ({ id: item.id, epoch: item.epoch })) : [], entries: room.entries.slice(-100).map(storedEntryView).filter(Boolean) };
    }
    return this;
  }
  mutate(work) {
    const job = this.queue.catch(() => {}).then(async () => {
      const before = this.state;
      let result, next;
      this.state = structuredClone(before);
      try {
        result = work(); next = this.state;
      } finally { this.state = before; }
      // Readers keep seeing the committed version while disk IO is pending.
      await this.save(this.file, JSON.stringify(next));
      this.state = next;
      return result;
    });
    this.queue = job; return job;
  }
  room(groupId, create = false) {
    if (!validId(groupId)) return null;
    const scope = digest(groupId);
    if (!this.state.rooms[scope] && create && Object.keys(this.state.rooms).length < 128) this.state.rooms[scope] = { epoch: 0, seen: [], observedEpochs: [], entries: [] };
    return this.state.rooms[scope] || null;
  }
  add(room, term, message, source, declaration) {
    let entry = room.entries.find(item => termKey(item.term) === termKey(term));
    if (!entry) {
      if (room.entries.length >= 100) {
        const replaceable = room.entries.filter(item => item.status !== 'confirmed')
          .sort((a, b) => Number(b.status === 'rejected') - Number(a.status === 'rejected') || Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0];
        if (!replaceable) return false;
        room.entries = room.entries.filter(item => item !== replaceable);
      }
      entry = { id: `vocab_${digest(termKey(term)).slice(0, 20)}`, term, status: 'pending', meaning: '', confirmedBy: '', revision: 0,
        createdAt: stamp(this.now()), updatedAt: stamp(this.now()), observations: [], member_confirmations: [], web_evidence: [], review: null };
      room.entries.push(entry);
    }
    if (entry.observations.some(item => item.messageId === message.messageId && item.source === source)) return false;
    const evidence = { speaker: message.speaker, messageId: message.messageId, source, at: stamp(this.now()) };
    entry.observations = [...entry.observations, evidence].slice(-6);
    if (declaration) {
      const confirmation = { ...evidence, meaning: declaration };
      entry.member_confirmations = [...entry.member_confirmations.filter(item => item.speaker !== message.speaker), confirmation].slice(-6);
      const meanings = new Set(entry.member_confirmations.map(item => item.meaning.normalize('NFKC').toLowerCase()));
      if (meanings.size === 1) { entry.status = 'confirmed'; entry.meaning = declaration; entry.confirmedBy = 'member'; }
      else { entry.status = 'pending'; entry.meaning = ''; entry.confirmedBy = ''; }
      entry.review = null;
    }
    entry.revision++; entry.updatedAt = stamp(this.now()); delete entry.research_checkpoint;
    return true;
  }
  observe(event) {
    return this.mutate(() => {
      const messages = messagesFor(event), room = messages.length ? this.room(event.group_openid, true) : null;
      if (!room) return { changed: false, roomCandidates: [] };
      let changed = false; const roomCandidates = [];
      for (const message of messages) {
        const key = digest(message.messageId);
        if (room.seen.includes(key)) continue;
        room.seen = [...room.seen, key].slice(-256);
        room.observedEpochs = [...room.observedEpochs, { id: key, epoch: room.epoch }].slice(-256);
        for (const found of extractVocabularyCandidates(message.content, { knownTerms: room.entries.map(item => item.term) })) {
          changed = this.add(room, found.term, message, found.source, found.declared ? found.meaning : '') || changed;
          if (found.declared) roomCandidates.push(...explicitRoomCandidates([{ ...message, content: found.source }]));
        }
      }
      return { changed, roomCandidates };
    });
  }
  context(groupId, { query = '', limit = 12 } = {}) {
    const entries = this.room(groupId)?.entries || [], search = termKey(query);
    const relevance = entry => search === termKey(entry.term) ? 1000 : search.includes(termKey(entry.term)) ? entry.term.length : 0;
    return structuredClone([...entries].sort((a, b) => relevance(b) - relevance(a)
      || Number(b.status === 'confirmed') - Number(a.status === 'confirmed') || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, Math.min(30, Math.max(1, limit))).map(entryView));
  }
  prepareResearch(groupId, { limit = 3 } = {}) {
    const room = this.room(groupId);
    const candidates = room?.entries.filter(entry => entry.status === 'pending' && !entry.web_evidence.length
      && !researchRecentlyEmpty(entry, this.now())).slice(0, Math.min(3, Math.max(1, limit))) || [];
    if (!candidates.length) return null;
    const token = randomUUID(), scope = digest(groupId);
    if (this.tickets.size >= 64) this.tickets.delete(this.tickets.keys().next().value);
    this.tickets.set(token, { scope, epoch: room.epoch, expiresAt: this.now() + 30 * 60_000, entries: candidates.map(entry => ({ id: entry.id, revision: entry.revision })) });
    return { token, revisionKey: digest(JSON.stringify([room.epoch, candidates.map(entry => [entry.id, entry.revision])])),
      context: { mode: 'vocabulary_research', instruction: 'Research only these unfamiliar terms with read-only web_search. Do not upload whole group messages or member IDs to search. Search the term itself. Separate internet usage from this group. Report sources and uncertainty; web findings never confirm a group-specific meaning.',
      candidates: candidates.map(entry => ({ id: entry.id, term: entry.term, observed_examples: entry.observations.slice(-2).map(item => clip(item.source, 80)) })) } };
  }
  releaseResearch(token) { this.tickets.delete(token); }
  applyModelActions(event, actions, { researchToken, verifiedSources = [], researchCompleted = false, isCurrent = () => true } = {}) {
    let consumed = false;
    return this.mutate(() => {
      const room = this.room(event?.group_openid), messages = messagesFor(event);
      const noChange = () => researchCompleted ? { applied: 0, checkpointed: 0, researchCurrent: false } : { applied: 0 };
      if (!room || !Array.isArray(actions) || (researchCompleted && !isCurrent())) return noChange();
      const ticket = this.tickets.get(researchToken), scope = digest(event.group_openid);
      const validTicket = ticket && ticket.scope === scope && ticket.epoch === room.epoch && ticket.expiresAt > this.now();
      const eligible = validTicket ? room.entries.filter(entry => entry.status === 'pending'
        && ticket.entries.some(item => item.id === entry.id && item.revision === entry.revision)) : [];
      if (researchCompleted && !eligible.length) return noChange();
      const verified = new Set(verifiedSources.map(item => sourceUrl(typeof item === 'string' ? item : item?.url)).filter(Boolean));
      let applied = 0;
      for (const action of actions.slice(0, 4)) {
        if (action?.operation === 'propose') {
          const message = messages.find(item => item.messageId === action.messageId && item.speaker === action.speaker);
          if (!message || !validTerm(action.term) || !safeText(action.source) || action.source.length > 160 || !action.source.includes(action.term)
            || !message.content.includes(action.source) || reported.test(message.content) || /^\s*>/.test(action.source)
            || !room.observedEpochs.some(item => item.id === digest(message.messageId) && item.epoch === room.epoch)) continue;
          if (this.add(room, action.term, message, action.source, '')) applied++;
          continue;
        }
        const entry = room.entries.find(item => item.id === action?.candidate_id);
        if (!entry || entry.status !== 'pending' || !validTicket || !ticket.entries.some(item => item.id === entry.id && item.revision === entry.revision)) continue;
        if (action.operation === 'research') {
          const report = webView({ meaning: action.meaning, at: stamp(this.now()), sources: (Array.isArray(action.sources) ? action.sources : []).map(item => ({ ...item, verified: verified.has(sourceUrl(item?.url)) })) });
          if (!report) continue;
          entry.web_evidence = [...entry.web_evidence, report].slice(-3);
        } else if (action.operation === 'reject') {
          if (!safeText(action.note) || !action.note.trim()) continue;
          entry.status = 'rejected'; entry.review = { origin: 'model_research', operation: 'reject', note: clip(action.note, 160), at: stamp(this.now()) };
        } else continue;
        entry.revision++; entry.updatedAt = stamp(this.now()); applied++;
      }
      let checkpointed = 0;
      if (researchCompleted) for (const entry of eligible) {
        if (entry.status !== 'pending' || entry.web_evidence.length
          || !ticket.entries.some(item => item.id === entry.id && item.revision === entry.revision)) continue;
        entry.research_checkpoint = { revision: entry.revision, completedAt: this.now() }; checkpointed++;
      }
      consumed = Boolean(validTicket);
      return researchCompleted ? { applied, checkpointed, researchCurrent: true } : { applied };
    }).then(result => { if (consumed) this.releaseResearch(researchToken); return result; });
  }
  forget(groupId) {
    return this.mutate(() => {
      const room = this.room(groupId);
      if (!room) return false;
      room.entries = []; room.epoch++;
      return true;
    }).then(result => {
      if (result) for (const [token, ticket] of this.tickets) if (ticket.scope === digest(groupId)) this.releaseResearch(token);
      return result;
    });
  }
  snapshot() {
    return Object.entries(this.state.rooms).map(([scope, room]) => ({ scope, candidates: structuredClone(room.entries.map(entryView)) }));
  }
  // Trusted local operator UI only. Never route this method through model tools.
  review(scope, id, { operation, meaning = '' } = {}) {
    return this.mutate(() => {
      const room = /^[a-f0-9]{64}$/.test(scope || '') ? this.state.rooms[scope] : null;
      const entry = room?.entries.find(item => item.id === id);
      if (!entry || !['confirm', 'reject', 'delete'].includes(operation)) return false;
      if (operation === 'delete') room.entries = room.entries.filter(item => item !== entry);
      else {
        if (operation === 'confirm' && (!safeText(meaning) || !meaning.trim() || meaning.length > 200)) return false;
        entry.status = operation === 'confirm' ? 'confirmed' : 'rejected'; entry.meaning = operation === 'confirm' ? meaning.trim() : '';
        entry.confirmedBy = operation === 'confirm' ? 'owner_local' : '';
        entry.review = { origin: 'owner_local', operation, note: '', at: stamp(this.now()) }; entry.revision++; entry.updatedAt = stamp(this.now());
      }
      room.epoch++;
      return true;
    });
  }
}
