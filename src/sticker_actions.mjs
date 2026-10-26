// Creation authorization uses current sender words only. Catalog ranking may use
// caller-scoped conversation context, but never grants media or file access.
const MAX_PROMPT = 4000;
const MAX_TITLE = 80;
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim() : '';
const idOf = item => {
  const id = item?.messageId || item?.id;
  return typeof id === 'string' && id.length <= 512 && !/[\x00-\x20]/.test(id) ? id : '';
};
const name = /^(?:<@!?[^>\s]{1,100}>\s*|@?(?:小柯|小珂|柯霜|codex|chatgpt|gpt娘|小龙娘)(?=$|[\s，,:：]|请|帮|给|先|再|画|做|制作|生成|改|把|直接|你))\s*[，,:：]?\s*/i;

function currentMessages(input) {
  if (typeof input === 'string') return [{ content: input }];
  if (!input || typeof input !== 'object' || ['proactive', 'routing'].includes(input.mode)) return [];
  const turns = Array.isArray(input.turn_messages) ? input.turn_messages : Array.isArray(input.turnMessages) ? input.turnMessages : null;
  // A supplied batch is authoritative: do not authorize from an unrelated
  // fallback text, assistant item, or a message carrying another group scope.
  const source = turns || [input];
  return source.filter(item => item && typeof item === 'object'
    && (!item.role || item.role === 'user')
    && !item.is_self && !item.from_self && !item.author?.bot
    && !(input.group_openid && item.group_openid && input.group_openid !== item.group_openid))
    .map(item => ({ messageId: idOf(item), content: clean(item.content ?? item.text) }))
    .filter(item => item.content);
}

function withoutQuotedMaterial(text) {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/g, ' ')
    .trim();
}

function requestPrefix(text) {
  let value = text;
  // Permit a mention plus the character's name, but never an arbitrary person's
  // name or a reporting phrase such as "他说：".
  for (let i = 0; i < 3; i++) value = value.replace(name, '');
  value = value.replace(/^(?:麻烦|拜托|劳驾|请)\s*/, '');
  value = value.replace(name, '');
  value = value.replace(/^(?:我想让你|我希望你|我需要你|我要你|你)(?:现在)?\s*/, '');
  value = value.replace(/^(?:(?:先|再|现在|直接|马上|这次|就|继续)\s*[，,:：]?\s*){0,3}/, '');
  value = value.replace(/^(?:帮我|帮忙|给我|替我|为我|给你自己|为你自己|给自己|给我们|为我们|帮我们)\s*/, '');
  return value.replace(/^(?:(?:先|再|现在|直接|就)\s*){0,2}/, '');
}

function explicitCreation(content) {
  const unquoted = withoutQuotedMaterial(content);
  if (!unquoted) return false;
  // Questions about ability, negation, plans and conditional wishes do not
  // schedule work. A later, separate explicit instruction can authorize it.
  if (/(?:会不会|能不能|可不可以|能否|是否|有没有|有无).{0,24}(?:画|制作|生成|做.{0,8}表情|改图|修图)|(?:会|能|可以).{0,24}(?:画|制作|生成|改图|修图).{0,16}(?:吗|么|不[？?]|[？?])|(?:画图|绘画|绘图|出图|生图|制作表情).{0,10}(?:能力|功能)/.test(unquoted)) return false;
  if (/(?:不要|不用|无需|不必|别|先别|暂不|停止|取消).{0,12}(?:画|制作|生成|做|改|修)|(?:以后|下次|有空|如果|假如|假设|能的话).{0,20}(?:画|制作|生成|做|改图)/.test(unquoted)) return false;
  if (/(?:怎么|如何|为什么|多久|多长时间|多少钱|步骤|流程|教程|是什么|什么意思|要不要)|(?:制作|画图|改图|修图|做表情).{0,30}(?:吗|么)[？?]?\s*$/.test(unquoted)) return false;
  const directive = requestPrefix(unquoted);
  const originalDirective = requestPrefix(content);
  if (/^(?:画质|画风|画面|画像|画室|画册|画笔|画布|画作|画家|画廊|画展|画报|画板|画稿|画法|画师)/.test(directive)) return false;
  if (/^(?:(?:制作|生成|做)(?:表情包?|图片|图像|头像)|画图|画画|绘画|出图|生图|改图|修图)(?:真的?|很|挺|好|太|有|需要|必须|应该|通常|一般|是|的)/.test(directive)) return false;
  if (/^(?:画|绘制|绘画|重画|重绘|改图|修图|出图|生图)(?!过|了|的|得|不|图能力|图功能)/.test(directive)) return true;
  if (/^把.{1,100}(?:画成|做成|改成|改为|变成|换成)/.test(directive)
      && /(?:图|照片|头像|表情|贴纸|插画|漫画|绘画|图片|配色|发色|背景|龙娘)/.test(directive)) return true;
  if (!/^(?:制作|生成|做|设计|创作|绘制|修改|编辑|调整|更换)(?!过|了|的|得|不)/.test(directive)) return false;
  // A verb outside quotation marks may refer to a quoted caption. The caption
  // contributes the requested subject, never the authority to create it.
  return /(?:表情(?:包)?|头像|贴纸|图片|图像|插画|漫画|照片|壁纸|一[张幅套]|这题我会|this one i know)/i.test(originalDirective);
}

export function stickerCreationRequest(input) {
  const requests = currentMessages(input).filter(item => explicitCreation(item.content));
  return { allowed: requests.length > 0, requests,
    sourceIds: [...new Set(requests.map(item => item.messageId).filter(Boolean))] };
}

export function hasExplicitStickerCreationRequest(input) {
  return stickerCreationRequest(input).allowed;
}

export function resolveStickerCreation(input, mediaSuggestion) {
  const authorization = stickerCreationRequest(input);
  const prompt = clean(mediaSuggestion?.create_prompt);
  if (!authorization.allowed || !prompt || [...prompt].length > MAX_PROMPT) return null;
  const title = [...clean(mediaSuggestion?.title)].slice(0, MAX_TITLE).join('');
  return { prompt, title: title || '小柯专属表情', sourceIds: authorization.sourceIds };
}

const normalize = value => clean(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const tagsOf = item => (Array.isArray(item?.tags) ? item.tags : typeof item?.tags === 'string' ? item.tags.split(/[,，;；\s]+/) : [])
  .filter(tag => typeof tag === 'string');
const ownSticker = item => /^approved[_-](?:xiao[_-]?ke|ke[_-]?shuang|keshuang)(?:[_-]|$)/i.test(String(item?.id || ''))
  || /(?:小柯|小珂|柯霜|小龙娘|gpt娘|chatgpt|codex)/i.test([item?.title, item?.label, ...tagsOf(item)].join(' '));
const address = /^(?:<@!?[^>\s]{1,100}>\s*|@?(?:小柯|小珂|柯霜|codex|chatgpt|gpt娘|小龙娘)(?=$|[\s，,:：]|请|帮|给|先|再|发|来|找|挑|选|你))\s*[，,:：]?\s*/i;
const withoutAddress = text => {
  let result = clean(text);
  for (let i = 0; i < 3; i++) result = result.replace(address, '');
  return result;
};

// Mask references without changing offsets: a quoted caption can describe the
// requested image, but a quoted instruction cannot create a current request.
const maskReferences = text => text.replace(/```[\s\S]*?(?:```|$)|^\s*>.*$|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/gm,
  value => ' '.repeat(value.length));
const directiveText = text => withoutAddress(text).replace(/^(?:(?:麻烦|拜托|请|现在|先|再|继续|直接|帮我|帮忙|你|能不能|能否|可以|可不可以|能|我想要|我想看|但是|不过|还是|那就)[，,:：\s]*){0,8}/, '');
const isSendDirective = value => /^(?:发|来[一张个]|给.{0,8}(?:图|表情|一张|一个)|找|挑|选)/.test(directiveText(value))
  && !/^(?:不要|不用|别|先别|暂不|停止|取消)/.test(withoutAddress(value));

function sendingClauses(content) {
  const visible = maskReferences(content);
  const clauses = [];
  let start = 0;
  for (const boundary of visible.matchAll(/[，,。！？!?；;\n]/g)) {
    clauses.push({ text: content.slice(start, boundary.index), visible: visible.slice(start, boundary.index), end: boundary[0] });
    start = boundary.index + 1;
  }
  clauses.push({ text: content.slice(start), visible: visible.slice(start), end: '' });
  const requests = [];
  let reported = false;
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    const explicitSelf = /^(?:但|不过|还是|那就|我的意思|我(?:想|要|希望|需要))/.test(clause.visible.trim());
    if (explicitSelf) reported = false;
    if (!reported && isSendDirective(clause.visible)) {
      let request = clause.text;
      // A trailing preference is part of the request, preceding chat is not.
      while ((clause.end === ',' || clause.end === '，') && i + 1 < clauses.length
          && /^(?:最好|要用|要那|要你|用你|就用|就要|从你|从收藏|带|别|不要|不用)/.test(clauses[i + 1].visible.trim())) {
        const continuation = clauses[++i]; request += '，' + continuation.text;
        if (!['，', ','].includes(continuation.end)) break;
      }
      requests.push(request);
    }
    // Unquoted “他说，发…” is reported speech. A completed quote is already
    // masked, so a subsequent independent current request can still be read.
    if (/(?:他说|她说|他们说|别人说|原话是|转述|引用)[：:\s]*$/.test(clause.visible.trim())
        && !/[“”「」『』‘’"']/.test(clause.text)) reported = true;
    if (/[。！？!?；;\n]/.test(clause.end)) reported = false;
  }
  return requests;
}

/** Request preferences are per-message: two people asking for different stickers
 * remain two requests. Merely addressing 小柯 is not a preference for her image. */
export function stickerSelectionRequests(catalog, input) {
  return currentMessages(input).flatMap(message => {
    const clauses = sendingClauses(message.content);
    if (!clauses.length) return [];
    const text = clauses.join('，');
    const query = normalize(text);
    const titles = [], excludedTitles = [];
    for (const title of new Set((Array.isArray(catalog) ? catalog : []).map(item => clean(item?.title)))) {
      const term = normalize(title);
      if (term.length < 2) continue;
      const position = query.indexOf(term);
      if (position < 0) continue;
      const before = query.slice(Math.max(0, position - 18), position);
      const negative = /(?:不要|不用|别|不想要|不发|不选|不是)(?:再|选|发|拿|那|这|个|一张|张|用)*$/.test(before);
      (negative ? excludedTitles : titles).push(title);
    }
    const wantsSticker = /表情|贴纸|sticker|meme/i.test(text) || titles.length > 0;
    const wantsAvatar = /头像|avatar/i.test(text) && !/表情|贴纸|sticker|meme/i.test(text);
    if (!wantsSticker && !wantsAvatar && !/(?:你(?:收藏|存|收)|收藏过|收藏的|存过的|保存过的)/.test(text)) return [];
    const collected = /(?:你(?:收藏|存|收)|收藏过|收藏的|存过的|保存过的)/.test(text);
    return [{ ...message, titles, excludedTitles, collected,
      own: !collected && /(?:你自己的|自己的|你的|专属|本人)/.test(text), wantsSticker, wantsAvatar }];
  });
}

export function stickerMatchesRequest(item, request) {
  if (!item || !request) return false;
  if (request.excludedTitles?.some(title => normalize(title) === normalize(item.title))) return false;
  if (request.titles.length && !request.titles.some(title => normalize(title) === normalize(item.title))) return false;
  if (request.collected && item.source !== 'collected') return false;
  if (request.own && !ownSticker(item)) return false;
  if (request.wantsAvatar && item.type !== 'avatar') return false;
  if (request.wantsSticker && item.type === 'avatar') return false;
  return true;
}

function overlap(field, query) {
  const text = normalize(field);
  if (!text || !query) return 0;
  if (query.includes(text)) return Math.min(80, 12 + text.length * 4);
  // Lexical retrieval only; the same model call still decides meaning, irony,
  // recipient and fit using the full note/usage. There is no emotion dictionary.
  let score = 0;
  const seen = new Set();
  for (const size of [2, 3]) for (let i = 0; i <= text.length - size; i++) {
    const gram = text.slice(i, i + size);
    if (!seen.has(gram) && query.includes(gram)) { score += size === 3 ? 2 : 0.4; seen.add(gram); }
  }
  return Math.min(50, score);
}

/** Ranking is a hint, not an authorization or a semantic verdict. Preserve every
 * candidate and its notes. Recent use breaks equal-relevance ties only. */
export function rankStickerCatalog(catalog, inputOrText, { roomMessages = [] } = {}) {
  if (!Array.isArray(catalog)) return [];
  const messages = currentMessages(inputOrText);
  const current = messages.map(item => normalize(withoutAddress(item.content))).filter(Boolean);
  const room = (Array.isArray(roomMessages) ? roomMessages : []).filter(item => item && typeof item === 'object'
    && !(inputOrText?.group_openid && item.group_openid && inputOrText.group_openid !== item.group_openid))
    .slice(-16).map(item => normalize(withoutAddress(item.content ?? item.text))).filter(Boolean);
  if (!current.length && !room.length) return [...catalog];
  const requests = stickerSelectionRequests(catalog, inputOrText);
  return catalog.map((item, index) => {
    if (!item || typeof item !== 'object') return { item, index, score: -Infinity };
    const fields = [item.title, item.label, ...tagsOf(item), item.local_note ?? item.note, item.usage_hint ?? item.usage];
    const relevance = query => fields.reduce((sum, field) => sum + overlap(field, query), 0);
    let score = Math.max(0, ...current.map(relevance));
    score += room.reduce((sum, query, i) => sum + relevance(query) * (i + 1) / room.length, 0) / Math.max(1, room.length) * 0.6;
    for (const request of requests) {
      if (request.wantsSticker) score += item.type === 'sticker' ? 100 : item.type === 'avatar' ? -100 : 0;
      if (request.wantsAvatar && item.type === 'avatar') score += 6000;
      if (request.collected && item.source === 'collected') score += 4000;
      if (request.own && ownSticker(item)) score += 1500;
      if (request.titles.some(title => normalize(title) === normalize(item.title))) score += 8000 + (ownSticker(item) ? 10 : 0);
      if (request.excludedTitles?.some(title => normalize(title) === normalize(item.title))) score -= 8000;
    }
    return { item, index, score };
  }).sort((a, b) => b.score - a.score || Number(!!a.item?.recently_used) - Number(!!b.item?.recently_used) || a.index - b.index)
    .map(entry => entry.item);
}
