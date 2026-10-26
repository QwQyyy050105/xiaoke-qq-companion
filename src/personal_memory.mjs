// Evidence remains verbatim; derived keys only organize the speaker's own facts.
const optOut = /(?:不要|别|不准|不许|不用|无需|不需要).{0,8}(?:记|保存)|(?:do not|don't) (?:remember|save)/i;
const sensitive = /密码|口令|密钥|令牌|验证码|身份证|护照|银行卡|信用卡|账号|帐户|手机号|电话|微信号|QQ号|邮箱|住址|地址|定位|病史|诊断|疾病|抑郁|焦虑|障碍|药物|药名|性取向|性癖|性生活|宗教|信仰|政治|党派|种族|民族|收入|工资|存款|负债|犯罪|password|secret|token|credential|api.?key|address|phone|diagnos|religio|politic|sexual|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\d{7,}|[a-z0-9_\-]{24,}/i;
const reported = /(?:他|她|朋友|同学|同事)(?:说|告诉)|转述|引用|举例|```/;
// Pronouns must be clauses/people, not characters inside a hobby such as 吉他.
const unsafe = /(?:^|[，,。；;：:\s])(?:他|她)(?:们)?(?:的|说|喜欢|希望|想|在|是|有)|(?:喜欢|讨厌)(?:他|她|他们|她们)(?:[。！!？?\s]|$)|别人|朋友|同学|同事|家人|妈妈|爸爸|告诉|转述|假设|如果|假如|例如|比如|可能|也许|忽略|指令|系统提示|泄露|权限|system prompt/i;
const addressed = /^\s*(?:<@!?[a-z0-9_-]+>[，,:：\s]*)?(?:@?(?:小柯|小珂|柯霜)(?:呀|啊)?[，,:：\s]+)?$/i;
const nicknamePrefix = /^(?:以后(?:请)?叫我|(?:请)?叫我|你(?:以后)?可以叫我|我的(?:昵称|网名|小名)(?:是|叫))/;
const nicknameCorrection = /^(?:以后)?(?:不要|别)(?:再)?叫我[^，,。！？；;\n]{1,24}[，,]\s*(?:以后)?(?:请)?(?:改叫我|叫我)[^，,。！？；;\n]{1,24}[。！!]?$/;
const projectPrefix = /^我(?:(?:正在|长期|一直)(?:做|学(?:习)?|研究|开发|准备)|(?:最近)?在(?:做|学(?:习)?|研究|开发|准备))/;
const selfStatement = /^(?:我(?:平时|一直|通常|更|最|比较|特别|很|现在|其实|还是|以前)?(?:喜欢|爱好|偏好|偏爱|更爱|不喜欢|讨厌)|比起[^。！？\n]{1,60}[，,]\s*我(?:更|还是|其实更)?(?:爱|喜欢|偏爱|偏好)|我对[^。！？\n]{1,60}(?:更|比较|很|特别)?感兴趣|我(?:更)?希望(?:你|回复)|我(?:希望|喜欢)(?:你|回复)|I (?:like|prefer|enjoy|am (?:learning|working on))\b|(?:Please )?call me\b)/i;
const interactionDirective = /^(?:以后|下次|平时)(?:请|可以)?(?:回复|回答|说话|聊天)(?:时)?(?:尽量)?(?:简短|短一点|短点|长一点|详细|自然|随意|轻松|少点|少一点|不要|别)/;
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
// Preserve meaningful symbols (C++, C#) and qualifiers. Only these unambiguous
// food/drink nouns share a key with their literal eating/drinking expression.
const objectKey = value => {
  const text = value.trim().replace(/[。！!\s]+$/u, '').replace(/(?:了|啦|呀|呢)$/u, '')
    .normalize('NFKC').toLowerCase().replace(/[\s“”"‘’]/gu, '');
  const consumed = text.match(/^(?:喝(咖啡|红茶|绿茶|奶茶|牛奶|可乐|果汁|豆浆)|吃(米饭|面条|饺子|火锅|寿司|巧克力))$/u);
  return consumed ? consumed[1] || consumed[2] : text;
};

function completeSource(source, message) {
  for (let start = message.indexOf(source); start >= 0; start = message.indexOf(source, start + 1)) {
    const before = message.slice(0, start), after = message.slice(start + source.length);
    const left = !start || /[\n。！？；.!?;]\s*$/.test(before) || addressed.test(before);
    const right = !after || /[\n。！？；.!?;]$/.test(source) || /^\s*[\n。！？；.!?;]/.test(after);
    const insideQuote = (before.match(/"/g) || []).length % 2 || before.lastIndexOf('“') > before.lastIndexOf('”') || before.lastIndexOf('‘') > before.lastIndexOf('’');
    if (left && right && !insideQuote && !/^[“”"‘’]/.test(source)) return true;
  }
  return false;
}

function describe(source) {
  if (nicknamePrefix.test(source) || nicknameCorrection.test(source) || /^(?:Please )?call me\b/i.test(source)) return { kind: 'nickname', key: 'nickname', text: source };
  if (projectPrefix.test(source) || /^I am (?:learning|working on)\b/i.test(source)) return { kind: 'project', key: `project:${normalized(source)}`, text: source };
  if (/回复|回答|称呼|说话|语气|聊天|你.{0,8}(?:简短|自然|长篇)/.test(source)) {
    const dimension = /回复|回答/.test(source) && /简短|短一点|短点|长一点|详细|长篇/.test(source) ? 'length' : normalized(source);
    return { kind: 'interaction', key: `interaction:${dimension}`, text: source };
  }
  const preference = source.match(/^我(?:平时|一直|通常|更|最|比较|特别|很|现在|其实|还是|以前)?(?:喜欢|爱好|偏好|偏爱|更爱|不喜欢|讨厌)(.+?)[。！!\s]*$/);
  const comparison = source.match(/^比起([^，,。！？；;\n]{1,60})[，,]\s*我(?:更|还是|其实更)?(?:爱|喜欢|偏爱|偏好)([^，,。！？；;\n]{1,60})[。！!]?$/u);
  if (comparison) {
    const other = objectKey(comparison[1]), preferred = objectKey(comparison[2]);
    if (other && preferred && other !== preferred) return { kind: 'preference',
      key: `preference_pair:${JSON.stringify([other, preferred].sort())}`, text: source,
      comparison: { preferred, other } };
  }
  return { kind: 'preference', key: `preference:${objectKey(preference?.[1] || source)}`, text: source };
}

export function inspectPersonalCandidates(candidates, message, { limit = 2 } = {}) {
  const accepted = [], rejected = [];
  if (!Array.isArray(candidates) || typeof message !== 'string') return { accepted, rejected };
  for (const item of candidates.slice(0, 16)) {
    let reason = '';
    const source = typeof item?.source === 'string' ? item.source.trim() : '';
    if (optOut.test(message)) reason = 'opt_out';
    else if (reported.test(message)) reason = 'reported_or_code';
    else if (typeof item?.text !== 'string' || item.text.trim() !== source || source.length < 4 || source.length > 180) reason = 'invalid_evidence';
    else if (!completeSource(source, message)) reason = 'not_complete_own_statement';
    else if (!selfStatement.test(source) && !nicknamePrefix.test(source) && !nicknameCorrection.test(source) && !projectPrefix.test(source) && !interactionDirective.test(source)) reason = 'not_explicit_personal_fact';
    else if (sensitive.test(source) || unsafe.test(source)) reason = 'excluded_content';
    if (reason) { rejected.push({ reason }); continue; }
    if (!accepted.some(value => value.source === source)) accepted.push({ ...describe(source), source });
    if (accepted.length >= limit) break;
  }
  return { accepted, rejected };
}

export function explicitPersonalCandidates(message) {
  if (typeof message !== 'string' || /^\s*\//.test(message)) return [];
  const stripped = message.replace(/^\s*(?:<@!?[a-z0-9_-]+>[，,:：\s]*)?(?:@?(?:小柯|小珂|柯霜)(?:呀|啊)?[，,:：\s]+)?/i, '');
  const parts = stripped.match(/[^\n。！？；.!?;]+[。！？；.!?;]?/g) || [];
  return parts.map(source => ({ text: source.trim(), source: source.trim() })).filter(item => item.source.length >= 4).slice(0, 16);
}

export function memoryOptOut(text) { return typeof text === 'string' && optOut.test(text); }
export function memoryWorthReviewing(text) {
  return typeof text === 'string' && text.length <= 4000 && !/^\s*\//.test(text) && !optOut.test(text)
    && /我|叫|约定|以后|下次|待会|回头|没讲完|梗|更正|记错|忘掉|删掉|不再/.test(text);
}
