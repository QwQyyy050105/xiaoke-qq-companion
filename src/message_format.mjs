// Inspired by qq-bridge md-to-plain.js (MIT, Derpyu520 and contributors).
// Keep mathematical symbols, URLs and emoji intact when presenting QQ text.
export function plainMessage(value) {
  let text = String(value ?? '').replace(/\r\n/g, '\n');
  text = text.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  text = text.replace(/`([^`\n]+)`/g, '$1');
  text = text.replace(/!\[([^\]\n]{0,500})\]\(([^)\s]{1,2000})\)/g, (_, alt) => alt || '[图片链接]');
  text = text.replace(/\[([^\]\n]{1,500})\]\((https?:\/\/[^)\s]{1,2000})\)/g, '$1（$2）');
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/\*(?!\s)([^*\n]*?[^\s*])\*/g, '$1').replace(/~~([^~\n]+)~~/g, '$1');
  return text.replace(/^#{1,6}\s+/gm, '').replace(/^>\s?/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeMessages(reply, messages) {
  if (!Array.isArray(messages) || !messages.length) return { reply: plainMessage(reply), messages: [] };
  const bubbles = messages.filter(value => typeof value === 'string').map(plainMessage).filter(Boolean).slice(0, 3);
  if (!bubbles.length || bubbles.some(value => value.length > 1800)) return { reply: plainMessage(reply), messages: [] };
  const unique = bubbles.filter((value, index) => index === 0 || value !== bubbles[index - 1]);
  return { reply: unique.join('\n\n'), messages: unique };
}

export function requestedWebSearch(input) {
  if (input?.chatSettings?.allowWebSearch === false || ['routing', 'visual_review', 'owner_work', 'channel'].includes(input?.mode)) return false;
  const turns = Array.isArray(input?.turnMessages) && input.turnMessages.length ? input.turnMessages : [{ content: input?.text }];
  return !turns.some(message => {
    const text = String(message?.content || '').replace(/^\s*>.*$/gm, '');
    return /(?:不要|不用|别|无需).{0,8}(?:联网|上网|搜索|查)|(?:do not|don't|no)\s+(?:browse|search|web)/i.test(text);
  });
}
