// Prompt-only references for exact duplicate indexes. Original disk state and
// validation inputs remain intact; no new body, identity or time is inferred.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => same(value, right[index]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
};

export function compactConversationIndexes(data, { clippedRoomMessageIds = new Set() } = {}) {
  const context = data?.conversation_context, room = data?.room_messages;
  if (context?.kind !== 'group' || !Array.isArray(room) || !room.length) return data;
  const byId = new Map();
  for (const item of room) {
    if (!record(item) || typeof item.messageId !== 'string' || !item.messageId) continue;
    const rows = byId.get(item.messageId) || [];
    rows.push(item); byId.set(item.messageId, rows);
  }
  let changed = false;
  const indexes = {};
  for (const key of ['own_recent_messages', 'recent_message_index']) {
    if (!Array.isArray(context[key])) continue;
    indexes[key] = context[key].map(item => {
      if (!record(item) || typeof item.messageId !== 'string' || !item.messageId
        || Object.keys(item).length <= 1 || clippedRoomMessageIds.has(item.messageId)) return item;
      const rows = byId.get(item.messageId);
      // Ambiguous IDs, a missing row, or any unique/different metadata must keep
      // the full index entry. Array order and every retained index are preserved.
      if (rows?.length !== 1 || !Object.keys(item).every(field => Object.hasOwn(rows[0], field) && same(item[field], rows[0][field]))) return item;
      changed = true;
      return { messageId: item.messageId };
    });
  }
  return changed ? { ...data, conversation_context: { ...context, ...indexes } } : data;
}
