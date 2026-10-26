// QQ IDs can be hundreds of characters. Use reversible, request-local labels;
// retain every message body and restore original IDs before any validation/write.
// Media catalogs and quote diagnostics use these other spellings for the same
// QQ references. Keep media asset IDs and literal message text untouched.
const referenceKeys = new Set(['messageId', 'referenceId', 'originId', 'last_message_id', 'reply_to_message_id',
  'message_id', 'reference_id', 'sourceMessageId', 'source_message_id']);

export function compactReferences(input) {
  const originals = new Set();
  const visit = (value, transform) => {
    if (Array.isArray(value)) return value.map(item => visit(item, transform));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      referenceKeys.has(key) && typeof item === 'string' && item ? transform(item) : visit(item, transform)]));
  };
  // Do not traverse AbortSignal or image buffers; only prompt data is projected.
  const { signal, runtimeAuthorization, runtimeRoom, ...data } = input;
  visit(data, id => { originals.add(id); return id; });
  const encode = new Map(), decode = new Map();
  let sequence = 0;
  const compacted = visit(data, id => {
    if (!encode.has(id)) {
      let alias;
      do { alias = `ref_local_${++sequence}`; } while (originals.has(alias));
      encode.set(id, alias); decode.set(alias, id);
    }
    return encode.get(id);
  });
  return { input: compacted, referenceCount: encode.size,
    restore: output => visit(output, id => decode.get(id) || id) };
}
