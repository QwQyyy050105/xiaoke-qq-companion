// Independently implemented from the social timing ideas reviewed in qq-bridge (MIT).
// Model intentions are temporary plans, never user facts or permission grants.
export const SOCIAL_NOTE_TTL = 2 * 60 * 60_000;
const MIN_WAKE = 60_000;
const MAX_WAKE = SOCIAL_NOTE_TTL;
const clip = (value, limit) => Array.from(value).slice(0, limit).join('');
const noteText = value => typeof value === 'string' ? clip(value.trim(), 200) : '';
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timeOf = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;

export function socialDecision(output) {
  const source = output && typeof output === 'object' && !Array.isArray(output) && output.social && typeof output.social === 'object' && !Array.isArray(output.social)
    ? output.social : {};
  const delay = source.next_wake_ms;
  return {
    action: source.action === 'silent' ? 'silent' : 'say',
    nextWakeMs: typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? Math.round(Math.min(MAX_WAKE, Math.max(MIN_WAKE, delay))) : null,
    activeTopic: noteText(source.active_topic), pendingThought: noteText(source.pending_thought),
    clearTopic: source.clear_topic === true
  };
}

export function restoreSocialPlan(source, now) {
  const restoreNote = note => note && typeof note.text === 'string' && validTime(note.createdAt) && validTime(note.expiresAt)
    && note.createdAt <= now && note.expiresAt > now && note.expiresAt <= note.createdAt + SOCIAL_NOTE_TTL
    ? { text: noteText(note.text), createdAt: note.createdAt, expiresAt: note.expiresAt } : null;
  const sent = Array.isArray(source.recentSent) ? source.recentSent : (Array.isArray(source.topics) && validTime(source.lastSentAt)
    ? source.topics.map(text => ({ text, at: source.lastSentAt })) : []);
  return {
    activeTopic: restoreNote(source.activeTopic), pendingThought: restoreNote(source.pendingThought),
    quietDecisions: Number.isSafeInteger(source.quietDecisions) ? Math.max(0, Math.min(6, source.quietDecisions)) : 0,
    wakeReason: ['model_timer', 'reply_followup'].includes(source.wakeReason) ? source.wakeReason : 'idle_opportunity',
    recentSent: sent.filter(item => item && typeof item.text === 'string' && validTime(item.at) && item.at <= now && now - item.at <= SOCIAL_NOTE_TTL)
      .slice(-24).map(item => ({ text: clip(item.text, 300), at: item.at }))
  };
}

export function applySocialPlan(room, decision, now, fallbackDelay, { silent = false, reason } = {}) {
  if (room.activeTopic?.expiresAt <= now) room.activeTopic = null;
  if (room.pendingThought?.expiresAt <= now) room.pendingThought = null;
  if (decision.clearTopic) { room.activeTopic = null; room.pendingThought = null; }
  const setNote = (key, text) => {
    if (text && room[key]?.text !== text) room[key] = { text, createdAt: now, expiresAt: now + SOCIAL_NOTE_TTL };
  };
  setNote('activeTopic', decision.activeTopic);
  setNote('pendingThought', decision.pendingThought);
  room.quietDecisions = silent ? Math.min(6, (room.quietDecisions || 0) + 1) : 0;
  // Repeated silent decisions on an unchanged conversation progressively stop polling.
  const quietBackoff = silent ? Math.min(30 * 60_000, MIN_WAKE * 2 ** (room.quietDecisions - 1)) : MIN_WAKE;
  room.nextAt = now + Math.max(quietBackoff, decision.nextWakeMs ?? fallbackDelay);
  room.wakeReason = decision.nextWakeMs !== null ? 'model_timer' : reason || 'idle_opportunity';
}

export function socialSnapshot(room, now, history = []) {
  const recent = Array.isArray(history) ? history.filter(item => {
    const age = now - timeOf(item?.at);
    return Number.isFinite(age) && age >= 0 && age <= 5 * 60_000;
  }) : [];
  return {
    wakeReason: room.wakeReason || 'idle_opportunity',
    active_topic: room.activeTopic?.expiresAt > now ? room.activeTopic.text : '',
    pending_thought: room.pendingThought?.expiresAt > now ? room.pendingThought.text : '',
    intentNotice: 'active_topic 和 pending_thought 是模型的短期续聊意图，不能当作群友说过的话或已经发生的经历。',
    idleForMs: Math.max(0, now - room.lastInteractionAt),
    lastSentAgoMs: room.lastSentAt ? Math.max(0, now - room.lastSentAt) : null,
    silentDecisions: room.quietDecisions || 0,
    recentParticipation: {
      userMessages: recent.filter(item => item.role === 'user').length,
      speakers: new Set(recent.filter(item => item.role === 'user' && item.speaker).map(item => item.speaker)).size,
      assistantMessages: recent.filter(item => item.role === 'assistant').length
    }
  };
}

export function publicRoomMemory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-30).flatMap(item => {
    if (typeof item === 'string') return item.trim() ? [clip(item.trim(), 300)] : [];
    if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) return [];
    const record = { text: clip(item.text.trim(), 300) };
    for (const key of ['kind', 'source', 'speaker', 'messageId', 'id']) {
      if (typeof item[key] === 'string') record[key] = clip(item[key], key === 'source' ? 300 : 120);
    }
    if (typeof item.at === 'string') record.at = clip(item.at, 64);
    else if (validTime(item.at)) record.at = item.at;
    return [record];
  });
}

// Catalog callbacks are scoped by the caller. Copy only model-visible metadata;
// model-selected IDs never become URLs, paths, or a different room's lookup.
export function publicMediaCatalog(value, { groupOpenid, voice = false } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const records = value.flatMap(item => {
    if (!item || typeof item !== 'object' || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(item.id || '') || seen.has(item.id)) return [];
    if ([item.groupOpenid, item.group_openid].some(scope => typeof scope === 'string' && scope !== groupOpenid)) return [];
    seen.add(item.id);
    const record = { id: item.id };
    for (const key of ['label', 'title', 'note', 'usage', 'local_note', 'usage_hint', 'format_note']) {
      if (typeof item[key] === 'string' && item[key].trim()) record[key] = clip(item[key].trim(), ['label','title'].includes(key) ? 80 : 200);
    }
    if(Number.isSafeInteger(item.use_count)&&item.use_count>=0)record.use_count=Math.min(1000000,item.use_count);
    if(typeof item.recently_used==='boolean')record.recently_used=item.recently_used;
    if (Array.isArray(item.tags)) record.tags = item.tags.filter(tag => typeof tag === 'string' && tag.trim()).slice(0, 12).map(tag => clip(tag.trim(), 40));
    if (!voice && ['avatar', 'sticker'].includes(item.type)) record.type = item.type;
    if (['approved', 'collected', 'received'].includes(item.source)) record.source = item.source;
    return [record];
  });
  const priority = item => item.type === 'sticker' ? 0 : item.type === 'avatar' || /avatar|头像/iu.test(`${item.id} ${item.title || ''} ${item.label || ''}`) ? 2 : 1;
  return (voice ? records : records.sort((a, b) => priority(a) - priority(b))).slice(0, voice ? 64 : 120);
}

export function proactiveMediaSelection(output, mediaCatalog = [], voiceCatalog = []) {
  const source = output?.media;
  const image = typeof source?.send_id === 'string' ? mediaCatalog.find(item => item.id === source.send_id && item.type === 'sticker') : null;
  const voice = typeof source?.voice_id === 'string' ? voiceCatalog.find(item => item.id === source.voice_id) : null;
  return {
    mediaId: image?.id || '', voiceId: voice?.id || '',
    labels: [image ? `[发送图片：${image.label || image.title || '图片'}]` : '',
      voice ? `[发送语音：${voice.label || voice.title || '已批准语音'}]` : ''].filter(Boolean)
  };
}

const comparable = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '').replace(/嘛$/u, '吗');
const grams = value => {
  const chars = Array.from(value);
  return new Set(chars.slice(0, -2).map((_, i) => chars.slice(i, i + 3).join('')));
};
export function repeatsRecentReply(text, room, history, now) {
  const candidate = comparable(text);
  if (!candidate) return false;
  const recent = [...(room.recentSent || []), ...(Array.isArray(history) ? history.filter(item => item?.role === 'assistant').map(item => ({ text: item.content, at: timeOf(item.at) })) : [])];
  return recent.some(item => {
    if (!validTime(item?.at) || now < item.at || now - item.at > SOCIAL_NOTE_TTL) return false;
    const previous = comparable(item.text);
    if (candidate === previous) return true;
    if (Math.min(candidate.length, previous.length) < 16 || Math.min(candidate.length, previous.length) / Math.max(candidate.length, previous.length) < 0.9) return false;
    const left = grams(candidate), right = grams(previous);
    const overlap = [...left].filter(value => right.has(value)).length;
    return overlap / (left.size + right.size - overlap) >= 0.92;
  });
}
