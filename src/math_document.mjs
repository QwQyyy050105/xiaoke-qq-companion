// A bounded, declarative document; never executable TeX, HTML, paths or URLs.
export function normalizeMathDocument(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['title', 'blocks', 'summary'].includes(key))
    || typeof value.title !== 'string' || value.title.length > 80
    || typeof value.summary !== 'string' || value.summary.length > 1000
    || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 32) return null;
  let length = value.title.length + value.summary.length;
  const blocks = [];
  for (const block of value.blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)
      || Object.keys(block).some(key => !['type', 'content'].includes(key))
      || !['text', 'math'].includes(block.type) || typeof block.content !== 'string'
      || !block.content.trim() || block.content.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(block.content)) return null;
    length += block.content.length;
    if (length > 24000) return null;
    blocks.push({ type: block.type, content: block.content.trim() });
  }
  return { title: value.title.trim(), blocks, summary: value.summary.trim() };
}

export function mathDocumentText(document) {
  if (!document) return '';
  return [document.title, ...document.blocks.map(block => block.content), document.summary].filter(Boolean).join('\n\n');
}

export function isMathLayoutRequest(event) {
  return (event?.turn_messages?.length ? event.turn_messages : [event]).some(item => {
    const text = String(item?.addressed_content ?? item?.content ?? '').replace(/^\s*>.*$/gm, '');
    return /(?:解答|解析|解法|题解|公式|分式|极限|推导|数学)[\s\S]{0,28}(?:做|排|制|生成|发|变)[\s\S]{0,14}(?:图|PDF)|(?:图|PDF)[\s\S]{0,14}(?:展示|排版|显示)[\s\S]{0,14}(?:解答|公式|数学)/i.test(text);
  });
}
