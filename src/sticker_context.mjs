import { stickerSelectionRequests, stickerMatchesRequest } from './sticker_actions.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const normalized = value => text(value).normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
const id = item => text(item?.messageId || item?.message_id || item?.id);
const safeText = (value, max) => typeof value === 'string' && value.trim().length > 0
  && [...value].length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

function targetMessages(input, roomMessages) {
  const current = Array.isArray(input?.turn_messages) ? input.turn_messages
    : Array.isArray(input?.turnMessages) ? input.turnMessages : input && typeof input === 'object' ? [input] : [];
  const sameRoom = item => !(input?.group_openid && item?.group_openid && input.group_openid !== item.group_openid);
  // Bare incoming image events may have no caption. Their actual observed ID is
  // still a valid response anchor; no ID is synthesized from media metadata.
  const hasCurrentAttachment = item => current.includes(item) && Array.isArray(item.attachments)
    && item.attachments.some(attachment => attachment && typeof attachment === 'object' && !Array.isArray(attachment));
  // conversationPrompt exposes up to 60 room entries. Do not reject an anchor
  // the same model turn could actually see merely because it is older than 40.
  return [...current, ...(Array.isArray(roomMessages) ? roomMessages.slice(-60) : [])]
    .filter(item => item && typeof item === 'object' && sameRoom(item) && id(item)
      && ((typeof (item.content ?? item.text) === 'string' && text(item.content ?? item.text)) || hasCurrentAttachment(item)));
}

/** Checks structured intent from the same model turn, never calls a second model
 * or invents semantic certainty. The language model judges relevance; this guard
 * rejects its own no-fit verdict, fabricated anchors and ignored explicit asks.
 * File ownership, integrity and QQ scope stay with MediaLibrary.prepare(). */
export function validateStickerSelection({ catalog = [], input, media, roomMessages = [] } = {}) {
  const sendId = text(media?.send_id);
  const reject = reason => ({ allowed: false, sendId: '', reason });
  if (!sendId) return { allowed: true, sendId: '', reason: 'no_image' };
  const item = (Array.isArray(catalog) ? catalog : []).find(candidate => candidate?.id === sendId);
  // Unknown IDs and non-sticker media still go through the original media
  // authorization path. This result makes no claim of verification for them.
  if (!item || item.type !== 'sticker') return { allowed: true, sendId, reason: 'not_sticker_unverified' };
  const selection = media?.selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return reject('selection_missing');
  if (selection.fit === 'none') return reject('selection_no_fit');
  if (!['contextual', 'requested'].includes(selection.fit)) return reject('selection_invalid_fit');
  if (!safeText(selection.intent, 160)) return reject('selection_intent_missing');
  if (!safeText(selection.catalog_evidence, 200)) return reject('selection_evidence_missing');
  const evidence = normalized(selection.catalog_evidence);
  const fields = [item.title, item.label, item.local_note ?? item.note, item.usage_hint ?? item.usage,
    ...(Array.isArray(item.tags) ? item.tags : [])].map(normalized).filter(Boolean);
  if (evidence.length < 2 || !fields.some(field => field.includes(evidence))) return reject('selection_evidence_mismatch');
  const messageId = text(selection.message_id);
  if (messageId.length > 512 || /[\x00-\x20]/.test(messageId)) return reject('selection_target_invalid');
  const messages = targetMessages(input, roomMessages);
  if (messageId && !messages.some(message => id(message) === messageId)) return reject('selection_target_unknown');
  const proactive = input?.mode === 'proactive';
  if (!messageId && !proactive) return reject('selection_target_missing');

  const requests = stickerSelectionRequests(catalog, input);
  const targetRequest = requests.find(request => request.messageId === messageId);
  if (targetRequest) {
    if (!stickerMatchesRequest(item, targetRequest)) return reject('selection_request_mismatch');
  } else if (requests.length) {
    // One image can address one precise request; it must not silently combine
    // incompatible simultaneous preferences into a fabricated overall mood.
    const matches = requests.map(request => stickerMatchesRequest(item, request));
    if (!matches.some(Boolean)) return reject('selection_request_mismatch');
    if (!matches.every(Boolean)) return reject('selection_request_target_required');
  }
  if (selection.fit === 'requested' && !requests.some(request => stickerMatchesRequest(item, request))) {
    return reject('selection_request_missing');
  }
  return { allowed: true, sendId, reason: 'selection_grounded', selection: {
    fit: selection.fit, message_id: messageId, catalog_evidence: text(selection.catalog_evidence), intent: text(selection.intent)
  } };
}
