// The extractor may relate differently worded statements, but it cannot choose
// another person's store or manufacture source evidence. Keep original wording.
const kinds = new Set(['nickname', 'preference', 'interaction', 'project']);
const sensitive = /密码|口令|密钥|令牌|验证码|身份证|护照|银行卡|信用卡|账号|帐户|手机号|电话|微信号|QQ号|邮箱|住址|地址|定位|病史|诊断|疾病|抑郁|焦虑|障碍|药物|药名|性取向|性癖|性生活|宗教|信仰|政治|党派|种族|民族|收入|工资|存款|负债|犯罪|password|secret|token|credential|api.?key|address|phone|diagnos|religio|politic|sexual|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\d{7,}|[a-z0-9_\-]{24,}/i;
const reported = /(?:他|她|朋友|同学|同事)(?:说|告诉)|转述|引用|举例|```|(?:^|[，,。；;：:\s])(?:他|她)(?:们)?(?:的|说|喜欢|希望|想|在|是|有)/;
const unsafe = /假设|如果|假如|例如|比如|可能|也许|忽略|指令|系统提示|泄露|权限|system prompt|<\/?(?:system|assistant|developer)|别人|朋友|同学|同事|家人|妈妈|爸爸|室友|同桌|(?:我|本人)(?:觉得|认为|听说|听到|看到|猜测|梦见|梦到)|(?:我|本人).{0,12}(?:患|病|症|治疗|就医|看医生|吃药|健康|癌|肿瘤|HIV)|同性恋|跨性别|gender identity|transgender/i;
const optOut = /(?:不要|别|不准|不许|不用|无需|不需要).{0,8}(?:记|保存)|(?:do not|don't) (?:remember|save)/i;
const blanketOptOut = /(?:不要|别|不准|不许|不用|无需|不需要).{0,4}(?:记|保存)(?:住|下)?(?:这句|这段|这条消息|这次聊天|下面|以下)|(?:do not|don't) (?:remember|save) this/i;
const deletion = /忘掉|忘记|删除|删掉|移除|不再保留|不要再记|别再记/;
const deletionRequest = /(?:^|[。！？；，,:：\s])(?:请|麻烦)?(?:你|小柯|小珂|柯霜)?(?:把|将)?(?:忘掉|忘记|删除|删掉|移除|不再保留|不要再记|别再记)|(?:请|麻烦)(?:你)?(?:把|将)[^。！？\n]{1,100}(?:忘掉|忘记|删除|删掉|移除)|(?:^|[。！？；，,:：\s])(?:把|将)[^。！？\n]{1,100}(?:忘掉|忘记|删除|删掉|移除)/;
const negated = /(?:不要|别|不用|不必|不准|不需要).{0,6}(?:忘掉|忘记|删除|删掉|移除|更正|纠正|修正|改成)|(?:是否|能否|可否|能不能|可不可以|怎么|如何).{0,12}(?:删除|删掉|忘掉|忘记|修改|更正)|(?:删除|删掉|忘掉|忘记|修改|更正).{0,12}(?:吗|么)[？?]?$/;
const ownProposition = /^(?:我|本人)(?:(?:现在|已经|其实|以前|之前|原来|最近|以后|目前|平时|一直|通常|更|最|比较|特别|很|早就|确实|也|又|不再|不想再|已经不|现在不|早就不|还是|已经改成|已经改为))*?(?:不(?:喜欢|爱|玩|学|做|准备|打|看|听|喝|吃)|(?:喜欢|爱好|偏好|偏爱|更爱|讨厌|玩|打|看|听|喝|吃)(?!的)|想|打算|准备|在|正在|做|学|研究|开发|改|换|退坑|戒掉|停止|结束|转|希望|要求|决定|叫|是|的(?:昵称|网名|小名|名字|称呼)(?:是|叫|改|换))/;
const ownNicknameDirective = /^(?:以后)?(?:请)?(?:(?:别|不要)(?:再)?叫我|改叫我|叫我)/;
const interactionDirective = /^(?:以后|下次|平时|现在)?(?:请|可以)?(?:回复|回答|说话|语气|聊天)(?:方式|风格|时|要|别|不要|改|换|尽量)/;
const correctionPrelude = /^(?:更正|纠正|修正|改正)(?:一下)?(?:[：:]|\s)*|^(?:之前|刚才)?(?:我)?(?:记错|说错)了(?:[：:]|\s)*/;
const directAddress = /^(?:<@!?[a-z0-9_-]+>\s*)?(?:@?(?:小柯|小珂|柯霜)(?:呀|啊)?\s+)?/i;
const ownSubject = /^(?:我|本人)/;
const predicateModifiers = /^(?:(?:现在|已经|其实|以前|之前|原来|最近|以后|目前|平时|一直|通常|更|最|比较|特别|很|早就|确实|也|又|还是|正在|在))+/;
const changedPredicate = /^(?:不再|不想再|改|换|转而|退坑|戒掉|停止|结束)/;
const negativePredicate = /^不(?:喜欢|爱|玩|学|做|准备|打|看|听|喝|吃)/;
const perceptionPredicate = /^(?:听|看|读|转述|复述|讲述|引用|报道|记录|听说|听到|看到)/;
const addressed = /^\s*(?:<@!?[a-z0-9_-]+>[，,:：\s]*)?(?:@?(?:小柯|小珂|柯霜)(?:呀|啊)?[，,:：\s]+)?$/i;
const trace = value => Object.fromEntries(['id','key','source','speaker','messageId','at','origin','ownerSpeaker','originalCommand','importedAt']
  .filter(key => value[key] !== undefined).map(key => [key,value[key]]));

function ownCorrection(message) {
  let introduced = false;
  for (const raw of message.split(/[。！？；，,:：\n]/u)) {
    const clause = raw.trim().replace(directAddress, '').trim();
    if (!clause) continue;
    const own = clause.replace(correctionPrelude, '').trim();
    const prelude = introduced || own !== clause;
    if (ownProposition.test(own)) {
      const body = own.replace(ownSubject, ''), predicate = body.replace(predicateModifiers, '');
      // The change must be the speaker's predicate. A correction nested inside
      // something they hear, watch, or like reading belongs to that object.
      if (changedPredicate.test(predicate)
        || negativePredicate.test(predicate) && (/了|啦/.test(predicate) || /^(?:现在|已经|早就)/.test(body))
        || /^的(?:昵称|网名|小名|名字|称呼)(?:改|换)/.test(body)
        || prelude && !perceptionPredicate.test(predicate)) return true;
    }
    if (ownNicknameDirective.test(own) && (prelude || /^(?:以后)?(?:请)?(?:(?:别|不要)(?:再)?叫我|改叫我)/.test(own))) return true;
    const directed = own.replace(/^(?:我|本人)(?:现在|以后|更)?(?:希望|要求)(?:你)?/, '');
    if (interactionDirective.test(directed) && (prelude || /^(?:以后|下次|平时|现在)?(?:请|可以)?(?:回复|回答|说话|语气|聊天)(?:方式|风格|时)?(?:改|换|别|不要|不再)/.test(directed))) return true;
    // A correction prelude may introduce the immediately following proposition.
    // A name or an embedded 我 in somebody else's clause is never an owner.
    introduced = own !== clause && !own;
  }
  return false;
}

function ownDeletion(message) {
  return message.split(/[。！？；，,:：\n]/u).some(raw => {
    const clause = raw.trim().replace(directAddress, '').trim();
    if (!deletionRequest.test(clause)) return false;
    const object = clause.replace(/^(?:请|麻烦)?(?:你|小柯|小珂|柯霜)?(?:把|将)?(?:忘掉|忘记|删除|删掉|移除|不再保留|不要再记|别再记)\s*/, '')
      .replace(/^(?:请|麻烦)?(?:你)?(?:把|将)\s*/, '');
    const predicate = object.replace(ownSubject, '').replace(predicateModifiers, '');
    return ownProposition.test(object) && !perceptionPredicate.test(predicate)
      || /^(?:我|本人)的(?:昵称|网名|小名|名字|称呼|偏好|喜好|记忆|记录)/.test(object)
      || interactionDirective.test(object);
  });
}

function completeSource(source, message) {
  for (let at = message.indexOf(source); at >= 0; at = message.indexOf(source, at + 1)) {
    const before = message.slice(0, at), after = message.slice(at + source.length);
    const left = !at || /[\n。！？；.!?;]\s*$/.test(before) || addressed.test(before);
    const right = !after || /[\n。！？；.!?;]$/.test(source) || /^\s*[\n。！？；.!?;]/.test(after);
    const quoted = (before.match(/"/g) || []).length % 2 || before.lastIndexOf('“') > before.lastIndexOf('”') || before.lastIndexOf('‘') > before.lastIndexOf('’');
    if (left && right && !quoted && !/^[“”"‘’]/.test(source)) return true;
  }
  return false;
}

export function personalUpdateIntent(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000 || /^\s*\//.test(message)
    || sensitive.test(message) || reported.test(message) || unsafe.test(message) || blanketOptOut.test(message) || negated.test(message)) return { review: false, deletion: false };
  const remove = deletion.test(message) && ownDeletion(message);
  if (optOut.test(message) && !remove) return { review: false, deletion: false };
  return { review: remove || ownCorrection(message), deletion: remove };
}

function targetTerms(value) {
  const terms = new Set();
  for (const token of String(value || '').toLowerCase().match(/[a-z][a-z0-9+#_-]*|[\p{Script=Han}]{2,}/gu) || []) {
    if (/^[a-z]/.test(token)) terms.add(token);
    else for (let size=2;size<=4;size++) for(let i=0;i+size<=token.length;i++) terms.add(token.slice(i,i+size));
    if (terms.size >= 4096) break;
  }
  return [...terms].slice(0,4096);
}

export function personalUpdateTargets(facts, { query = '' } = {}) {
  const eligible = (Array.isArray(facts) ? facts : []).filter(fact => fact && kinds.has(fact.kind) && typeof fact.id === 'string'
    && typeof fact.source === 'string' && fact.source === fact.text);
  let selected = eligible.slice(-64);
  if (eligible.length > 64 && query) {
    const words=targetTerms(query), texts=eligible.map(fact=>fact.source.toLowerCase());
    const weights=words.map(word=>({word,weight:Math.log(1+eligible.length/(texts.filter(text=>text.includes(word)).length||1))}));
    const indices=eligible.map((fact,index)=>({index,score:weights.reduce((sum,{word,weight})=>sum+(texts[index].includes(word)?weight:0),0)}))
      .sort((a,b)=>b.score-a.score||b.index-a.index).slice(0,64).map(item=>item.index).sort((a,b)=>a-b);
    selected=indices.map(index=>eligible[index]);
  }
  return selected
    .map(fact => Object.fromEntries(['id','kind','key','text','source','speaker','messageId','at','savedAt','observedOrder','observedAt',
      'origin','ownerSpeaker','recordType','noteKind','importedAt','importedAfterOrder']
      .filter(key => fact[key] !== undefined).map(key => [key, structuredClone(fact[key])])));
}

// Receipt order is assigned by observe(), not supplied by the model or QQ text.
// Legacy pending jobs without an order cannot overwrite newly ordered facts.
export function personalSourceIsCurrent(fact, message) {
  if (fact?.origin === 'legacy_unverified') return Number.isSafeInteger(fact.importedAfterOrder)
    && Number.isSafeInteger(message?.observedOrder) && fact.importedAfterOrder < message.observedOrder;
  if (Number.isSafeInteger(fact?.observedOrder)) return Number.isSafeInteger(message?.observedOrder) && fact.observedOrder <= message.observedOrder;
  const saved = Date.parse(fact?.savedAt || ''), observed = Date.parse(message?.observedAt || message?.at || '');
  return Number.isFinite(saved) && Number.isFinite(observed) && saved <= observed;
}

function sameRevision(current, captured) {
  return ['id','kind','key','source','speaker','messageId','savedAt','observedOrder','observedAt','origin','ownerSpeaker',
    'recordType','noteKind','importedAt','importedAfterOrder'].every(key => current[key] === captured[key]);
}

export function inspectPersonalUpdates(facts, candidates, message, { targets = [], now = Date.now() } = {}) {
  let next = structuredClone(Array.isArray(facts) ? facts : []);
  const result = { facts: next, applied: 0, rejected: [] }, touched = new Set();
  if (!Array.isArray(candidates) || typeof message?.content !== 'string') return result;
  for (const candidate of candidates.slice(0, 16)) {
    const reject = reason => result.rejected.push(reason);
    if (!candidate || !['update','delete'].includes(candidate.operation) || !kinds.has(candidate.kind)
      || typeof candidate.targetId !== 'string' || typeof candidate.targetSource !== 'string'
      || typeof candidate.source !== 'string' || candidate.text !== candidate.source
      || candidate.source !== candidate.source.trim() || candidate.source.length < 4 || candidate.source.length > 280) { reject('invalid_update'); continue; }
    if (candidate.speaker !== message.speaker || candidate.messageId !== message.messageId) { reject('source_identity_mismatch'); continue; }
    const source = candidate.source, intent = personalUpdateIntent(source), whole = personalUpdateIntent(message.content);
    if (!whole.review || !intent.review || !completeSource(source, message.content)) { reject('correction_not_explicit'); continue; }
    if (candidate.operation === 'delete' ? !intent.deletion : intent.deletion) { reject('operation_not_explicit'); continue; }
    if (touched.has(candidate.targetId)) { reject('duplicate_target'); continue; }
    const captured = targets.find(fact => fact.id === candidate.targetId && fact.source === candidate.targetSource);
    const current = next.find(fact => fact.id === candidate.targetId);
    const targetOwner = captured?.origin === 'legacy_unverified' && captured.recordType === 'note' ? captured.ownerSpeaker : captured?.speaker;
    if (!captured || !current || captured.kind !== candidate.kind || targetOwner !== message.speaker) { reject('target_not_owned'); continue; }
    if (!sameRevision(current, captured)) { reject('target_changed'); continue; }
    if (!personalSourceIsCurrent(captured, message)) { reject('source_older_than_target'); continue; }
    touched.add(candidate.targetId);
    if (candidate.operation === 'delete') {
      const erased = [current, ...(current.replaces || [])], matches = item => erased.some(old => old.id === item.id || old.source === item.source);
      next = next.filter(fact => fact.id !== current.id && fact.source !== current.source).map(fact => {
        if (!Array.isArray(fact.replaces)) return fact;
        const replaces = fact.replaces.filter(item => !matches(item));
        const copy = { ...fact }; if (replaces.length) copy.replaces = replaces; else delete copy.replaces;
        return copy;
      });
    } else {
      if (source === current.source) { reject('unchanged_update'); continue; }
      const duplicate = next.find(fact => fact.id !== current.id && fact.source === source && fact.messageId === message.messageId && fact.speaker === message.speaker);
      next = next.filter(fact => fact.id !== current.id && fact !== duplicate);
      const history = [trace(current), ...(duplicate?.replaces || []).map(trace)];
      const replaces = [...new Map(history.map(item => [JSON.stringify([item.id,item.source,item.messageId]),item])).values()].slice(-4);
      // A fast-saved replacement already owns the ID derived from its new key.
      // Retaining the retired key's ID would collide if that interest returns.
      next.push({ id: duplicate?.id || current.id, kind: current.kind, key: duplicate?.key || current.key, text: source, source,
        origin: 'observed_statement',
        speaker: message.speaker, messageId: message.messageId, at: message.at, savedAt: new Date(now).toISOString(),
        ...(Number.isSafeInteger(message.observedOrder) ? { observedOrder: message.observedOrder } : {}),
        ...(typeof message.observedAt === 'string' ? { observedAt: message.observedAt } : {}), replaces });
    }
    result.applied++;
  }
  result.facts = [...next.filter(row => row.recordType === 'note'), ...next.filter(row => row.recordType !== 'note').slice(-64)]; return result;
}
