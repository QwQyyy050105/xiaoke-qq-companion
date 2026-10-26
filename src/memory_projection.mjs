// Lossless prompt-only projection; disk state and attribution are never changed.
export function compactMemoryEvidence(data) {
 const project = entries => Array.isArray(entries) ? entries.map(entry => {
  if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' || entry.source !== entry.text || entry.text.length < 32) return entry;
  const {source,...rest}=entry; return {...rest,source_equals_text:true};
 }) : entries;
 return {...data,...(data.room_memory ? {room_memory:project(data.room_memory)} : {}),...(data.saved_memory ? {saved_memory:project(data.saved_memory)} : {})};
}
