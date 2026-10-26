import { createHash } from 'node:crypto';

const clean = (value, max = 200) => typeof value === 'string' ? [...value.replace(/[\x00-\x1f\x7f]/g, ' ').trim()].slice(0, max).join('') : '';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20]/.test(value);
const validSpeaker = value => /^member_[a-f0-9]{16}$/.test(value || '');
const time = value => typeof value === 'number' ? value : Date.parse(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const roleView = role => ({ name: clean(role?.name, 80), aliases: (Array.isArray(role?.aliases) ? role.aliases : []).map(value => clean(value, 40)).filter(Boolean).slice(0, 12), description: clean(role?.description, 1000) });

function messageView(item, max = 300) {
  if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') return null;
  if (item.role === 'user' && !validSpeaker(item.speaker)) return null;
  const result = { role: item.role, speaker: item.role === 'assistant' ? 'xiao_ke' : item.speaker, content: clean(item.content, max) };
  for (const key of ['messageId', 'referenceId']) if (validId(item[key])) result[key] = item[key];
  if (Number.isFinite(time(item.at))) result.at = new Date(time(item.at)).toISOString();
  return result;
}

async function historyFor(groupId, getRoomHistory) {
  if (!validId(groupId) || typeof getRoomHistory !== 'function') return [];
  const history = await getRoomHistory(groupId);
  return (Array.isArray(history) ? history : []).filter(item => item && (!item.group_openid || item.group_openid === groupId)).slice(-100);
}

// Read-only equivalents of active-members, own-recent and conversation metadata.
// The callbacks receive only the current group. No account-wide group/member API
// or private per-member memory is consulted or exposed.
export async function readConversationContext({ event, getRoomHistory, getRoomMemory, role, now = Date.now() } = {}) {
  const groupId = event?.group_openid;
  const base = { kind: validId(groupId) ? 'group' : 'private', role: roleView(role) };
  if (!validId(groupId)) return base;
  const [history, memory] = await Promise.all([historyFor(groupId, getRoomHistory), typeof getRoomMemory === 'function' ? getRoomMemory(groupId) : []]);
  const safe = history.map(item => messageView(item)).filter(Boolean);
  const members = new Map();
  for (const item of safe) {
    const at = time(item.at);
    if (item.role !== 'user' || !Number.isFinite(at) || at > now || now - at > 2 * 60 * 60_000) continue;
    const current = members.get(item.speaker) || { speaker: item.speaker, message_count: 0, last_spoke_at: item.at };
    current.message_count++;
    if (at >= time(current.last_spoke_at)) { current.last_spoke_at = item.at; current.last_message_id = item.messageId || ''; }
    members.set(item.speaker, current);
  }
  return { ...base, conversation_id: `group_${digest(groupId).slice(0, 20)}`,
    coverage: 'Only messages actually observed in this group; not a complete QQ roster or server history.',
    observed_message_count: safe.length,
    active_members: [...members.values()].sort((a, b) => time(b.last_spoke_at) - time(a.last_spoke_at)).slice(0, 20),
    own_recent_messages: safe.filter(item => item.role === 'assistant').slice(-8),
    recent_message_index: safe.slice(-30).map(({ content, ...metadata }) => metadata),
    vocabulary: (Array.isArray(memory) ? memory : []).filter(item => item?.kind === 'vocabulary' && validSpeaker(item.speaker)
      && item.status !== 'resolved' && typeof item.text === 'string' && item.text === item.source).slice(-18)
      .map(item => ({ id: clean(item.id, 80), text: clean(item.text, 280), speaker: item.speaker, messageId: clean(item.messageId, 512) })) };
}

export async function readObservedMessage({ groupOpenid, messageId, getRoomHistory } = {}) {
  if (!validId(messageId)) return null;
  const history = await historyFor(groupOpenid, getRoomHistory);
  const item = history.find(item => item.messageId === messageId || item.referenceId === messageId);
  if (!item) return null;
  const result = messageView(item, 200);
  return result ? { ...result, text_truncated: [...item.content].length > 200 } : null;
}
