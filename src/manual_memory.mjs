import { createHash } from 'node:crypto';
import { inspectPersonalCandidates } from './personal_memory.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const manualOrigins = new Set(['manual_command', 'manual_edit']);
export const validMemoryScope = scope => scope === 'private_owner' || /^member_[a-f0-9]{64}$/.test(scope || '');
export const memoryOwner = scope => scope === 'private_owner' ? 'owner' : `member_${String(scope).slice(7,23)}`;
export function validateManualSource({ scope, speaker, messageId, content }) {
  if (!validMemoryScope(scope) || speaker !== memoryOwner(scope) || typeof messageId !== 'string' || !messageId || messageId.length > 512
    || typeof content !== 'string' || !content.trim() || content.length > 4000) throw new Error('manual_memory_source_invalid');
}

export function manualBody(content) {
  const match = typeof content === 'string' && content.trim().match(/^\/remember\s+([\s\S]+)$/);
  const text = match ? match[1].trim() : '';
  if (!text || text.length > 1000) throw new Error('manual_memory_note_invalid');
  return text;
}

export function eligibleNote(note) {
  if (!note || typeof note.text !== 'string') return null;
  const accepted = inspectPersonalCandidates([{ text: note.text, source: note.text }], note.text).accepted[0];
  return accepted?.source === note.text ? accepted : null;
}

export function noteView(note) {
  const personal = eligibleNote(note);
  return personal ? { ...note, ...personal, source: note.text, recordType: 'note', noteKind: note.kind } : null;
}

export function memoryEntries(state, scope) {
  return [...(state.facts[scope] || []), ...(state.notes?.[scope] || []).map(noteView).filter(Boolean)];
}

export function setMemoryEntries(state, scope, entries) {
  state.notes ??= {};
  const allNotes = state.notes[scope] || [], viewIds = new Set(allNotes.filter(eligibleNote).map(note => note.id));
  const retained = entries.filter(row => row.recordType === 'note').map(row => {
    const { key, recordType, noteKind, ...note } = row;
    return { ...note, kind: noteKind || 'note' };
  });
  retireLegacyNotes(state, scope, allNotes.filter(note => viewIds.has(note.id) && !retained.some(row => row.id === note.id)));
  state.notes[scope] = [...allNotes.filter(note => !viewIds.has(note.id)), ...retained];
  state.facts[scope] = entries.filter(row => row.recordType !== 'note').slice(-64);
}

export function retireLegacyNotes(state, scope, notes) {
  const ids = notes.filter(note => note.origin === 'legacy_unverified').map(note => note.id);
  if (!ids.length) return;
  state.noteRetirements ??= {};
  const retired = [...new Set([...(state.noteRetirements[scope] || []), ...ids])];
  if (retired.length > 32768) throw new Error('legacy_memory_retirements_full');
  state.noteRetirements[scope] = retired;
}

export function nextMemorySource(state, { speaker, messageId, content, at }, now) {
  state.counters.observed = (state.counters.observed || 0) + 1;
  return { speaker, messageId, content, at: Number.isFinite(Date.parse(at)) ? at : new Date(now).toISOString(),
    observedOrder: state.counters.observed, observedAt: new Date(now).toISOString() };
}

export function sourceReceipt(scope, messageId) { return hash(['manual', scope, messageId]); }
export function noteId(scope, text, origin, messageId = '') { return 'note_' + hash([scope, origin, text, messageId]).slice(0,24); }
export function manualNote(scope, text, message, now, { id, origin = 'manual_command', replaces = [] } = {}) {
  return { id: id || noteId(scope, text, origin, message.messageId), kind: 'note', text, source: text, origin,
    ownerSpeaker: message.speaker, speaker: message.speaker, messageId: message.messageId, at: message.at,
    observedOrder: message.observedOrder, observedAt: message.observedAt, savedAt: new Date(now).toISOString(),
    originalCommand: message.content, ...(replaces.length ? { replaces: replaces.slice(-4).map(noteTrace) } : {}) };
}

export function noteTrace(row) {
  return Object.fromEntries(['id','key','text','source','origin','ownerSpeaker','speaker','messageId','at','originalCommand']
    .filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}

export function boundNotes(notes) {
  const manual = notes.filter(note => manualOrigins.has(note.origin)).slice(-30);
  const legacy = notes.filter(note => note.origin === 'legacy_unverified');
  if (legacy.length > 128) throw new Error('legacy_memory_capacity_exceeded');
  return [...legacy, ...manual];
}

export function validateLegacyImport({ scope, notes, ownerSpeaker, sourceFingerprint }) {
  if (!validMemoryScope(scope) || ownerSpeaker !== memoryOwner(scope) || !/^[a-f0-9]{64}$/.test(sourceFingerprint || '')
    || !Array.isArray(notes) || notes.length > 128 || notes.some(text => typeof text !== 'string' || !text.trim() || text.length > 1000)) {
    throw new Error('legacy_memory_import_invalid');
  }
}

export function legacyNote(scope, text, ownerSpeaker, now, importedAfterOrder) {
  return { id: noteId(scope, text, 'legacy_unverified'), kind: 'note', text, source: text, origin: 'legacy_unverified',
    ownerSpeaker, speaker: null, messageId: null, at: null, savedAt: null,
    importedAt: new Date(now).toISOString(), importedAfterOrder };
}

export function validateNoteAmendment({ operation, targetId, targetText, replacementText, content }) {
  if (!['update','delete'].includes(operation) || typeof targetId !== 'string' || typeof targetText !== 'string'
    || typeof content !== 'string') return false;
  const text = content.trim(), command = text.match(/^\/memory-(delete|edit)\s+(\S+)(?:\s+([\s\S]+))?$/);
  const validReplacement = typeof replacementText === 'string' && replacementText.trim() === replacementText
    && replacementText.length > 0 && replacementText.length <= 1000;
  if (command) return command[2] === targetId && (operation === 'delete'
    ? command[1] === 'delete' && command[3] === undefined && (replacementText === undefined || replacementText === '')
    : command[1] === 'edit' && validReplacement && command[3] === replacementText);
  // Only the command frame expresses an operation. Quoted old/new note bodies
  // are arbitrary data, so words such as 如果 or 他说 inside them are harmless.
  const remove = text.match(/^(?:请)?(?:忘掉|删除|删掉)保存的[「“]([^」”]+)[」”][。！!]?$/);
  const edit = text.match(/^(?:请)?把保存的[「“]([^」”]+)[」”]改成[「“]([^」”]+)[」”][。！!]?$/);
  if (operation === 'delete') return Boolean(remove && remove[1] === targetText && (replacementText === undefined || replacementText === ''));
  return Boolean(edit && edit[1] === targetText && validReplacement && edit[2] === replacementText);
}

export function eraseNoteEvidence(state, scope, target) {
  retireLegacyNotes(state, scope, [target]);
  const erased = [target, ...(target.replaces || [])];
  const matches = row => erased.some(old => old.id === row.id || old.source && old.source === row.source);
  for (const key of ['facts','notes']) state[key][scope] = (state[key][scope] || []).filter(row => row.id !== target.id).map(row => {
    const copy = { ...row }, replaces = (row.replaces || []).filter(old => !matches(old));
    if (replaces.length) copy.replaces = replaces; else delete copy.replaces;
    return copy;
  });
}
