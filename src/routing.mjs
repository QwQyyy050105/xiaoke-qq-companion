import {characterRequest} from './character.mjs';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const speakerFor = (group, member) => `member_${hash(JSON.stringify([group, member])).slice(0, 16)}`;
const names = '(?:柯霜|小柯|小珂|Codex|GPT娘)';
const directName = new RegExp(`^(?:(?:喂|嘿|嗨|hi|hello)[，,！!\\s]*)?(?:请|麻烦)?@?${names}(?:$|[\\s，,：:！!？?]|你|我|咱|今天|今晚|现在|这个|好无聊|在吗|在不在|能不能|可以|能|会不会|帮|给|来|陪|出来|安静|接着|继续)`, 'i');
// Without punctuation, accept request-shaped verbs, not descriptions such as “小柯看起来…” or “小柯说过…”.
const namedRequest = new RegExp(`^(?:(?:喂|嘿|嗨|hi|hello)[，,！!\\s]*)?(?:请|麻烦)?@?${names}(?:发(?:给我|一下|下|个|张|点|一|图|头像|照片|表情)|看(?:看|一下|下|这|那)|讲(?:讲|一下|下|个|点|一)|说(?:说|一下|下|个|点|一)|读(?:读|一下|下|这|那|一遍)|解答(?:一下|下|这|那)|算(?:算|一下|下|这|那|一)|(?:发|看|讲|说|读|解答|算)(?:$|[\\s，,：:！!？?]))`, 'i');
const trailingName = new RegExp(`(?:[，,！!？?\\s])${names}[！!？?。\\s]*$`, 'i');
const calledByName = text => directName.test(text) || namedRequest.test(text) || (trailingName.test(text) && /[？?]|(?:你|帮我|陪我|出来|安静|请)/i.test(text));
const unquote = value => String(value ?? '').replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|‘[^’]*’/g, ' ').replace(/^\s*>.*$/gm, ' ').trim();
const closed = text => {
  const plain = text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  return !plain || /^(?:哈+|呵+|嗯+|哦+|噢+|好(?:的|呀|啊|吧|哦)?|收到|知道了|明白了|谢谢|谢了|笑死|ok|okay|yes|no)$/.test(plain);
};
const timeOf = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const botMetadata = event => event?.is_self === true || event?.from_self === true || event?.self_message === true
  || event?.author?.bot === true || event?.author?.is_bot === true || event?.author?.isBot === true
  || (validId(event?.author?.id) && [event?.self_id, event?.bot_id, event?.self?.id].some(id => id && id === event.author.id));
const mentionOther = event => event?.mentions_other_members === true;
export const isExplicitGroupMention = event => event?.explicit_mention === true
  || [event?.event_type, event?.t].includes('GROUP_AT_MESSAGE_CREATE');
// These routed candidates can still choose silence in the combined reply pass.
const optionalReplyReasons = new Set(['ambient_candidate', 'contextual_candidate', 'classified_continuation', 'clear_continuation']);
// QQ uses key=value strings; keep everything after the first '=' (including padding).
const sceneQuoteIds = event => (Array.isArray(event?.message_scene?.ext) ? event.message_scene.ext : [])
  .filter(value => typeof value === 'string' && value.startsWith('ref_msg_idx='))
  .map(value => value.slice('ref_msg_idx='.length)).filter(validId);
const quoteIds = event => [event?.message_reference?.message_id, event?.message_reference?.id,
  event?.referenced_message?.id, event?.reply_to?.message_id, event?.reply_to?.messageId,
  typeof event?.reply_to === 'string' ? event.reply_to : null, ...sceneQuoteIds(event)].filter(validId);
const salientFollowup = text => /^(?:(?:那|所以|嗯)[，,\s]*)?(?:你(?:刚才|说|觉得|认为|怎么看|怎么|为什么|能|会|有|要|来)|刚才(?:你|那个|说的|提到|这)|接着(?:说|讲|聊|呢|吧|刚才)|接下来呢|继续(?:说|讲|聊|刚才|那个)|继续[吧啊呀。！!\s]*$|再(?:说|讲|解释|展开)|那(?:你|具体|为什么|怎么)|这个(?:意思|例子|说法)|能(?:再|不能)|可以(?:再|接着|继续))/.test(text);
const directFollowup = text => /^(?:(?:那|所以|嗯)[，,\s]*)?(?:你刚才(?:说|讲|提到|问|推荐|解释|举)|刚才你(?:说|讲|提到|问|推荐|解释|举)|(?:接着|继续)(?:说|讲|聊)(?=$|[\s，,。.!！?？吧啊呀呢]|下去|刚才|那个|这个|一点|一下))/.test(text);
const control = text => /^\/(?:quiet|wake|forget|reset|help|memory|roommemory|remember)(?:\s|$)/i.test(text)
  || /^(?:安静一会儿|出来聊聊)[。！!～~]?$/u.test(text);
const CONTEXT_WINDOW = 20 * 60_000;
const DIRECT_FOLLOWUP_WINDOW = 2 * 60_000;
const pendingContext = options => ({
  pendingSpeakers: Array.isArray(options?.pendingSpeakers) ? options.pendingSpeakers.filter(value => typeof value === 'string').slice(-32) : [],
  pendingMessages: Array.isArray(options?.pendingMessages) ? options.pendingMessages.slice(-12).map(item => {
    if (typeof item === 'string') return { content: item.slice(0, 4000) };
    if (!item || typeof item !== 'object') return null;
    const content = typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : '';
    return { content: content.slice(0, 4000),
      ...(typeof item.speaker === 'string' ? { speaker: item.speaker } : {}),
      ...(typeof item.at === 'number' || typeof item.at === 'string' ? { at: item.at } : {}),
      ...(typeof item.messageId === 'string' ? { messageId: item.messageId } : {}) };
  }).filter(item => item?.content) : []
});

export class GroupRouter {
  constructor({ now = Date.now, classify, decideWithReply = false, ambientParticipation = false, aliases = [] } = {}) {
    this.now = now;
    this.calledByName=text=>calledByName(text)||(typeof aliases==='function'?aliases():aliases).some(alias=>typeof alias==='string'&&alias.length>0&&(text===alias||text.startsWith(alias+'，')||text.startsWith(alias+',')||text.startsWith(alias+' ')));
    this.classify = classify;
    this.decideWithReply = decideWithReply;
    this.ambientParticipation = ambientParticipation === true;
    this.seen = new Map();
    this.pending = new Map();
    this.groupActivity = new Map();
  }

  async decide(event, roomHistory = [], options = {}) {
    const group = event?.group_openid;
    const member = event?.author?.member_openid || event?.author?.id;
    if (!validId(group) || !validId(member) || !validId(event?.id)) return { addressed: false, reason: 'invalid_group_event' };
    if (botMetadata(event)) return { addressed: false, reason: 'bot_or_self' };
    const key = hash(JSON.stringify([group, event.id]));
    // Serialise variants; an explicit upgrade still goes through inbox delivery deduplication.
    const prior = this.pending.get(key) ?? Promise.resolve();
    const work = prior.catch(() => {}).then(() => this.route(event, roomHistory, key, speakerFor(group, member), pendingContext(options)));
    this.pending.set(key, work);
    try { return await work; }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }

  async route(event, roomHistory, key, speaker, context) {
    const previous = this.seen.get(key);
    const explicit = isExplicitGroupMention(event);
    if (previous?.addressed && !(previous.optional && !previous.explicit && explicit)) return { addressed: false, reason: 'already_addressed' };
    if (previous?.addressed === false && !explicit) {
      return { addressed: false, reason: 'duplicate_ignored' };
    }
    const result = await this.judge(event, roomHistory, speaker, context);
    this.seen.delete(key);
    this.seen.set(key, { addressed: result.addressed, optional: optionalReplyReasons.has(result.reason), explicit });
    while (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    if (result.addressed && !['contextual_candidate','ambient_candidate'].includes(result.reason)) {
      const groupKey = hash(event.group_openid);
      this.groupActivity.delete(groupKey);
      this.groupActivity.set(groupKey, this.now());
      while (this.groupActivity.size > 1000) this.groupActivity.delete(this.groupActivity.keys().next().value);
    }
    return result;
  }

  async judge(event, roomHistory, speaker, context) {
    if (isExplicitGroupMention(event)) {
      return { addressed: true, reason: 'explicit_mention' };
    }
    const text = typeof event.content === 'string' ? event.content.trim() : '';
    if (!text) return { addressed: false, reason: 'empty_content' };
    const history = Array.isArray(roomHistory) ? roomHistory.filter(item => item && !(item.role === 'user' && item.messageId === event.id)) : [];
    const references = quoteIds(event);
    if (references.some(id => history.some(item => item.role === 'assistant' && (item.messageId === id || item.referenceId === id)))) {
      return { addressed: true, reason: 'references_bot_reply' };
    }
    if (mentionOther(event)) return { addressed: false, reason: 'mentions_other_member' };
    if(characterRequest(text))return {addressed:true,reason:'called_by_name'};
    const unquoted = unquote(text);
    if (this.calledByName(unquoted)) return { addressed: true, reason: 'called_by_name' };
    const current = this.now();
    const recent = at => { const age = current - timeOf(at); return Number.isFinite(age) && age >= 0 && age <= CONTEXT_WINDOW; };
    // A group conversation belongs to every participant, not the last reply_to member.
    const activeTopic = history.some(item => recent(item.at) && (item.role === 'assistant'
      || (item.role === 'user' && (item.addressed === true || item.explicit_mention === true || this.calledByName(unquote(item.content))))));
    const pendingTopic = context.pendingMessages.length > 0 || context.pendingSpeakers.length > 0;
    if (!activeTopic && !pendingTopic && !recent(this.groupActivity.get(hash(event.group_openid)))) {
      // An expired reply window is not proof that a new shared topic is irrelevant.
      // The production combined pass can choose silence without a second model call.
      if(this.ambientParticipation&&this.decideWithReply&&!control(text)&&!/^\s*\//.test(text))return {addressed:true,reason:'ambient_candidate'};
      return { addressed: false, reason: 'outside_group_topic_window' };
    }
    if (control(text)) return { addressed: true, reason: 'continuation_command' };
    // Clear continuations need no extra model turn; an old topic or a quote to somebody else still needs context classification.
    const recentBot = history.some(item => item.role === 'assistant' && current - timeOf(item.at) >= 0 && current - timeOf(item.at) <= DIRECT_FOLLOWUP_WINDOW);
    if (recentBot && references.length === 0 && directFollowup(unquoted)) return { addressed: true, reason: 'clear_continuation' };
    // Evaluate conversational relevance and compose in one model call. A candidate
    // is allowed to stay silent and must not extend the activity window itself.
    if (this.decideWithReply) return { addressed: true, reason: 'contextual_candidate' };
    if (typeof this.classify === 'function') {
      try {
        const result = await this.classify({ text, speaker, roomHistory: structuredClone(history.slice(-24)), ...structuredClone(context) });
        if (typeof result === 'boolean') return { addressed: result, reason: result ? 'classified_continuation' : 'classified_unrelated' };
      } catch { /* Missing classification must never turn the time window into an automatic reply. */ }
    }
    const followup = !closed(unquoted) && salientFollowup(unquoted);
    return { addressed: followup, reason: followup ? 'clear_continuation' : 'no_clear_address' };
  }
}
