// QQ permits at most five replies to one message. Progress and image replies
// share that budget with the final text bubbles.
export function deliveryPlan(content, { messages = [], image = false, used = 0, limit = 5 } = {}) {
  const allowed = limit === 4 ? 4 : 5;
  const remaining = Math.max(0, allowed - Math.max(0, Math.floor(used)));
  const slots = remaining - Number(image);
  const selected = Array.isArray(messages) ? messages.filter(text => typeof text === 'string' && text.trim()).slice(0, 3) : [];
  const bubbles = (selected.length ? selected : [String(content || '')]).map(text => text.trim()).filter(Boolean);
  if (!remaining || (bubbles.length && slots < 1)) throw new Error('qq_reply_limit');
  if (bubbles.length <= slots && bubbles.every(text => Array.from(text).length <= 1800)) return { texts:bubbles, image };
  const chars = Array.from(bubbles.join('\n\n'));
  const texts = [];
  for (let offset = 0; offset < chars.length && texts.length < slots; offset += 1800) texts.push(chars.slice(offset, offset + 1800).join(''));
  if (chars.length > slots * 1800 && texts.length) {
    const ending = '…（这条内容较长，可以让我接着说）';
    texts[texts.length - 1] = Array.from(texts.at(-1)).slice(0, 1800 - Array.from(ending).length).join('') + ending;
  }
  return { texts, image };
}
