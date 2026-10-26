// Numeric diagnostics only: field names are fixed, and no prompt text, IDs,
// URLs or error messages are retained. Lengths use the same UTF-16 units as
// the existing prompt_chars field; they are not token or billing estimates.
const fields = [
  'recent_messages', 'room_messages', 'group_turn', 'saved_memory', 'room_memory',
  'participants', 'conversation_context', 'rich_context', 'quoted_messages',
  'vocabulary', 'character_growth', 'media_catalog', 'voice_catalog',
  'capabilities', 'social_state', 'observed_topics', 'recent_topics'
];

export function promptMetrics(prompt) {
  if (typeof prompt !== 'string') return null;
  const result = { version: 1, total_chars: prompt.length, context_json_parsed: false,
    instruction_chars: null, context_chars: null, component_chars: {}, array_items: {} };
  const boundary = prompt.lastIndexOf('\n') + 1;
  const tail = prompt.slice(boundary);
  let context;
  try { context = JSON.parse(tail); } catch { return result; }
  if (!context || typeof context !== 'object' || Array.isArray(context)) return result;
  result.context_json_parsed = true;
  result.instruction_chars = boundary;
  result.context_chars = tail.length;
  for (const field of fields) {
    if (!Object.hasOwn(context, field)) continue;
    result.component_chars[field] = JSON.stringify(context[field]).length;
    if (Array.isArray(context[field])) result.array_items[field] = context[field].length;
  }
  return result;
}
