import { createHash } from 'node:crypto';

const DAY = 86_400_000;
export const ROOM_MEMORY_LIMIT = 96;
const KINDS = ['topic', 'agreement', 'vocabulary', 'request'];
const TTL = { topic: 14 * DAY, agreement: 180 * DAY, vocabulary: 180 * DAY, request: 30 * DAY };
const sensitive = /密码|口令|密钥|令牌|验证码|身份证|护照|银行卡|信用卡|账号|帐户|手机号|电话|微信号|QQ号|邮箱|住址|地址|定位|病史|诊断|疾病|抑郁|焦虑|障碍|药物|药名|性取向|性癖|性生活|宗教|信仰|政治|党派|种族|民族|收入|工资|存款|负债|犯罪|password|secret|token|credential|api.?key|address|phone|diagnos|religio|politic|sexual|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\d{7,}|[a-z0-9_-]{24,}/i;
const unsafe = /(?:忽略|覆盖|泄露|修改|删除).{0,12}(?:指令|规则|系统|提示|权限|文件)|系统提示|提示词|developer|system prompt|\[CQ:|<\/?(?:system|assistant|developer)|```|\b(?:powershell|cmd\.exe|exec|eval)\b/i;
const optOut = /(?:不要|别|不准|不许|不用|无需|不需要).{0,8}(?:记|保存)|(?:do not|don't) (?:remember|save)/i;
const reported = /(?:他|她|朋友|同学|同事)(?:说|告诉)|转述|引用|举例|假设|假如|比如/;
const personal = /(?:我|你|他|她)(?:平时|一直|通常|更|最|比较|特别|很)?(?:喜欢|爱好|偏好|不喜欢|讨厌)|(?:以后)?(?:请)?叫我|我的(?:昵称|网名|小名)|(?:I (?:like|prefer|enjoy)|call me)\b/i;
const addressed = /^\s*(?:<@!?[a-z0-9_-]+>[，,:：\s]*)?(?:@?(?:小柯|柯霜)(?:呀|啊)?[，,:：\s]+)?$/i;
const request = /(?:待会|等会|稍后|回头|下次|之后|晚点|还没|还没有|未完成|没讲完|待办)/;
const task = /(?:讲|写|做|聊|查|帮|解释|完成|继续|发|回答|提醒|推荐|翻译|整理|画)/;
const complete = /(?:已经|已)(?:做完|完成|讲完|解决)|(?:不用|不需要|不要再).{0,30}(?:讲|写|做|聊|查|帮|提醒|继续)|(?:取消|结束|聊完|翻篇|解决了|完成了|做完了|讲完了|算了)/;
const notComplete = /(?:还没|没有|没|未|尚未).{0,8}(?:完成|解决|讲完|做完|结束|聊完)|(?:不要|别|不|未).{0,4}(?:取消|结束|翻篇)/;
const correction = /(?:更正|纠正|修正|改正|记错|说错|改成|改为|替换为|更新为)/;
const removal = /(?:删除|删掉|移除|忘掉|忘记|不再保留|不要再记|别再记)/;
const amendmentNegated = /(?:别|不要|不用|不必|不准|不需要).{0,6}(?:删除|删掉|移除|忘掉|忘记|更正|纠正|修改|改成)|(?:是否|能否|可否|能不能|可不可以|怎么|如何).{0,12}(?:删除|删掉|忘掉|忘记|修改|更正)|(?:删除|删掉|忘掉|忘记|修改|更正).{0,12}(?:吗|么)[？?]?$/;
const hypotheticalAmendment = /^(?:如果|假如|假设|举例|比如|听说|我(?:之前|以前|昨天|曾经)?(?:想过|打算|计划)|我(?:之前|以前|昨天)(?:想|说过要))/;
const normalized = value => String(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const stamp = value => new Date(value).toISOString();
const validSpeaker = (speaker, privateOwner) => privateOwner === true ? speaker === 'owner' : /^member_[a-f0-9]{16}$/.test(speaker || '');

function contentSafe(source, message) {
  const personalSensitive = /(?:我|你|他|她|本人).{0,12}(?:患|病|症|治疗|就医|看医生|吃药|检查结果|健康|癌|肿瘤|HIV)|同性恋|跨性别|gender identity|transgender/i;
  return !sensitive.test(source) && !personalSensitive.test(source) && !unsafe.test(source) && !optOut.test(message) && !reported.test(message);
}

function completeSource(source, content) {
  let start = content.indexOf(source);
  while (start >= 0) {
    const prefix = content.slice(0, start), rest = content.slice(start + source.length);
    const left = start === 0 || /[\n。！？；.!?;]\s*$/.test(prefix) || addressed.test(prefix);
    const right = !rest || /[\n。！？；.!?;]$/.test(source) || /^\s*[\n。！？；.!?;]/.test(rest);
    // A quoted full assertion is not an assertion by the sender. Quoted terms inside definitions are fine.
    const quoted = ((prefix.match(/"/g) || []).length % 2) || (prefix.lastIndexOf('“') > prefix.lastIndexOf('”')) || (prefix.lastIndexOf('‘') > prefix.lastIndexOf('’'));
    if (left && right && !quoted && !/^[“”"‘’]/.test(source)) return true;
    start = content.indexOf(source, start + 1);
  }
  return false;
}

function categoryFits(kind, source) {
  if (personal.test(source)) return false;
  if (kind === 'topic' && (/喜欢|爱好|偏好|讨厌|昵称|网名|小名|出生|生日|性格|孤独|友善|幽默/.test(source) || /^(?:我(?!们)|你(?!们)|他|她|本人)/.test(source))) return false;
  if (kind === 'request') return request.test(source) && task.test(source) && !complete.test(source);
  if (kind === 'agreement') return /(?:本群|群里|我们|咱们|大家).{0,100}(?:约定|约好|以后|统一|轮流|每次)|(?:群约定|约定好|约好了)/.test(source);
  if (kind === 'vocabulary') return /(?:本群|群里|我们|咱们).{0,100}(?:叫作|叫做|称作|是指|指的是|意思是|代表)|.{2,32}(?:是指|指的是|意思是)/.test(source);
  return true;
}

function namesTarget(source, entry) {
  const old = normalized(entry.text), current = normalized(source);
  if (old.length >= 4 && current.includes(old)) return true;
  if (entry.kind !== 'vocabulary') return false;
  // A definition can be corrected by its exact named term, but a generic
  // "change that memory" never authorizes whichever ID the model picks.
  const term = entry.text.match(/(?:本群|群里|我们|咱们)?[“"‘「『]?([^，。！？；\n:：]{2,32}?)[”"’」』]?(?:叫作|叫做|称作|是指|指的是|意思是|代表)/)?.[1];
  const key = normalized(term || '').replace(/^(?:更正|纠正|修正|本群|群里|我们|咱们)+/, '');
  return key.length >= 2 && current.includes(key);
}

function activeEntries(entries, now, privateOwner) {
  return (Array.isArray(entries) ? entries : []).filter(entry => entry && KINDS.includes(entry.kind)
    && typeof entry.id === 'string' && typeof entry.text === 'string' && entry.text === entry.source
    && typeof entry.speaker === 'string' && validSpeaker(entry.speaker, privateOwner)
    && typeof entry.messageId === 'string' && Number.isFinite(Date.parse(entry.expiresAt)) && Date.parse(entry.expiresAt) > now);
}

export function pruneRoomMemory(entries, now = Date.now(), { privateOwner = false } = {}) {
  const valid = activeEntries(entries, now, privateOwner);
  return KINDS.flatMap(kind => valid.filter(entry => entry.kind === kind)
    .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, ROOM_MEMORY_LIMIT / KINDS.length));
}

// Every write uses an exact source in a supplied current-turn message. The model never chooses a file or room.
export function inspectRoomMemory(entries, candidates, messages, now = Date.now(), { privateOwner = false } = {}) {
  const result = structuredClone(pruneRoomMemory(entries, now, { privateOwner }));
  const diagnostics = { candidates: Array.isArray(candidates) ? candidates.length : 0, applied: 0, rejected: 0, unchanged: 0, deferred: 0, rejectionReasons: {} };
  const rejected = reason => { diagnostics.rejected++; diagnostics.rejectionReasons[reason] = (diagnostics.rejectionReasons[reason] || 0) + 1; };
  if (!Array.isArray(candidates) || !Array.isArray(messages)) return { entries: result, diagnostics };
  let applied = 0;
  for (const candidate of candidates.slice(0, 16)) {
    if (!candidate || !KINDS.includes(candidate.kind) || !['remember', 'resolve', 'update', 'delete'].includes(candidate.operation)
      || typeof candidate.source !== 'string' || typeof candidate.text !== 'string' || candidate.text !== candidate.source) { rejected('invalid_candidate'); continue; }
    const source = candidate.source;
    if (source !== source.trim() || source.length < 4 || source.length > 280) { rejected('invalid_source_length'); continue; }
    const message = messages.find(message => message && message.speaker === candidate.speaker && message.messageId === candidate.messageId);
    const amendment = ['update', 'delete'].includes(candidate.operation);
    if (!message) { rejected('source_message_missing'); continue; }
    if (!validSpeaker(message.speaker, privateOwner) || typeof message.content !== 'string') { rejected('invalid_source_identity'); continue; }
    if (!(amendment ? !sensitive.test(source) && !unsafe.test(source) && !reported.test(message.content)
        && !amendmentNegated.test(source) && !hypotheticalAmendment.test(source) : contentSafe(source, message.content))) { rejected('excluded_content'); continue; }
    if (!completeSource(source, message.content)) { rejected('not_complete_own_statement'); continue; }
    const evidence = { speaker: message.speaker, messageId: message.messageId, source,
      at: Number.isFinite(Date.parse(message.at)) ? message.at : stamp(now) };
    if (amendment) {
      const index = result.findIndex(entry => entry.id === candidate.targetId && entry.kind === candidate.kind && entry.speaker === message.speaker);
      const existing = result[index];
      if (!existing || !namesTarget(source, existing)) { rejected('amendment_target_unproven'); continue; }
      if (candidate.operation === 'delete') {
        if (!removal.test(source)) { rejected('removal_not_explicit'); continue; }
        // Deletion really forgets the content. Its current-turn evidence stays
        // in the public message history, not in a hidden copy of deleted data.
        result.splice(index, 1);
      } else {
        if (!correction.test(source) || removal.test(source) || !contentSafe(source, message.content) || !categoryFits(candidate.kind, source)) { rejected('correction_not_supported'); continue; }
        if (existing.source === source && existing.messageId === message.messageId) { diagnostics.unchanged++; continue; }
        existing.revisions = [...(Array.isArray(existing.revisions) ? existing.revisions : []), {
          source: existing.source, speaker: existing.speaker, messageId: existing.messageId, at: existing.at
        }].slice(-4);
        existing.text = source; existing.source = source; existing.messageId = message.messageId; existing.at = evidence.at;
        existing.evidence = [...(existing.evidence || []), evidence].slice(-4);
        existing.status = 'active'; delete existing.resolution;
        existing.updatedAt = stamp(now); existing.expiresAt = stamp(now + TTL[candidate.kind]);
      }
    } else if (candidate.operation === 'resolve') {
      const existing = result.find(entry => entry.id === candidate.targetId && entry.kind === candidate.kind && entry.speaker === message.speaker);
      if (!existing || existing.status === 'resolved' || !complete.test(source) || notComplete.test(source)) { rejected('resolution_not_supported'); continue; }
      existing.status = 'resolved'; existing.resolution = evidence;
      existing.updatedAt = stamp(now); existing.expiresAt = stamp(now + 7 * DAY);
    } else {
      if (candidate.targetId || correction.test(source) || removal.test(source)) { rejected('remember_operation_conflict'); continue; }
      if (!categoryFits(candidate.kind, source)) { rejected('category_mismatch'); continue; }
      const id = `room_${createHash('sha256').update(JSON.stringify([candidate.kind, message.speaker, source])).digest('hex').slice(0, 20)}`;
      const existing = result.find(entry => entry.id === id);
      if (existing) {
        const priorEvidence = Array.isArray(existing.evidence) ? existing.evidence : [];
        if (priorEvidence.some(item => item.messageId === message.messageId)) { diagnostics.unchanged++; continue; }
        existing.evidence = [...priorEvidence, evidence].slice(-4);
        existing.status = 'active'; delete existing.resolution;
        existing.updatedAt = stamp(now); existing.expiresAt = stamp(now + TTL[candidate.kind]);
      } else {
        result.push({ id, kind: candidate.kind, text: source, source, speaker: message.speaker, messageId: message.messageId,
          at: evidence.at, updatedAt: stamp(now), expiresAt: stamp(now + TTL[candidate.kind]), status: 'active', evidence: [evidence] });
      }
    }
    if (++applied >= 4) break;
  }
  diagnostics.applied = applied;
  diagnostics.deferred = Math.max(0, diagnostics.candidates - applied - diagnostics.rejected - diagnostics.unchanged);
  return { entries: pruneRoomMemory(result, now, { privateOwner }), diagnostics };
}

// Preserve the established return value for existing conversation callers.
export function mergeRoomMemory(entries, candidates, messages, now = Date.now(), options = {}) {
  return inspectRoomMemory(entries, candidates, messages, now, options).entries;
}

// Only explicit declarations are learned without a model; ordinary chat is not a notebook entry.
export function explicitRoomCandidates(messages, { allowRequests = false } = {}) {
  const candidates = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.content !== 'string' || /^\s*\//.test(message.content) || optOut.test(message.content)
      || reported.test(message.content) || correction.test(message.content) || removal.test(message.content)) continue;
    for (const segment of message.content.match(/[^。！？；\n]+[。！？；]?/g) || []) {
      const source = segment.trim().replace(/^\s*(?:<@!?[a-z0-9_-]+>[，,:：\s]*)?(?:@?(?:小柯|柯霜)(?:呀|啊)?[，,:：\s]+)?/i, '').trim();
      let kind;
      if (categoryFits('vocabulary', source)) kind = 'vocabulary';
      else if (categoryFits('agreement', source)) kind = 'agreement';
      else if (allowRequests && /待会|等会|稍后|回头|下次|之后|晚点|待办/.test(source) && categoryFits('request', source)) kind = 'request';
      else if (/(?:我们|咱们|大家).{0,30}(?:正在聊|接着聊|继续聊|还没聊完|这个话题)/.test(source)) kind = 'topic';
      if (kind) candidates.push({ kind, text: source, source, speaker: message.speaker, messageId: message.messageId, operation: 'remember', targetId: '' });
      if (candidates.length >= 16) return candidates;
    }
  }
  return candidates;
}

export function roomMemorySnapshot(entries, { now = Date.now(), query = '', limit = 24, maxChars = 6500, privateOwner = false } = {}) {
  const text = String(query).slice(0, 1000).toLowerCase();
  const terms = [...new Set((text.match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g) || []).flatMap(term => /^[a-z0-9]+$/.test(term)
    ? [term] : Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2))))].slice(0, 160);
  const score = entry => terms.reduce((value, term) => value + Number(entry.text.toLowerCase().includes(term)), 0);
  const sorted = pruneRoomMemory(entries, now, { privateOwner }).filter(entry => entry.status !== 'resolved')
    .map(entry => ({ entry, score: score(entry), updated: Date.parse(entry.updatedAt) }))
    .sort((a, b) => b.score - a.score || Number(b.entry.kind === 'request') - Number(a.entry.kind === 'request') || b.updated - a.updated)
    .map(item => item.entry);
  const result = []; let used = 0;
  for (const entry of sorted) {
    // Full evidence remains on disk; the model gets a compact attributed quote, not rewritten facts.
    const view = { id: entry.id, kind: entry.kind, text: entry.text, source: entry.source, speaker: entry.speaker,
      messageId: entry.messageId, at: entry.at, updatedAt: entry.updatedAt, expiresAt: entry.expiresAt, status: entry.status };
    const size = JSON.stringify(view).length;
    if (used + size > maxChars) continue;
    result.push(view); used += size;
    if (result.length >= Math.min(96, Math.max(1, limit))) break;
  }
  return result;
}
