import {isAbsolute as isPortableAbsolute} from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { durableWriteFile } from './durable_write.mjs';
import { explicitPersonalCandidates, inspectPersonalCandidates, memoryOptOut, memoryWorthReviewing } from './personal_memory.mjs';
import { explicitRoomCandidates, inspectRoomMemory, pruneRoomMemory, roomMemorySnapshot } from './room_memory.mjs';
import { personalUpdateIntent, personalUpdateTargets, personalSourceIsCurrent, inspectPersonalUpdates } from './personal_memory_updates.mjs';
import { validateManualSource, manualBody, manualOrigins, memoryEntries, setMemoryEntries, nextMemorySource, sourceReceipt,
  manualNote, noteTrace, boundNotes, validateLegacyImport, legacyNote, eligibleNote, validateNoteAmendment, eraseNoteEvidence, retireLegacyNotes } from './manual_memory.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failureCodes = new Set(['memory_capture_extract_failed', 'memory_capture_commit_failed', 'memory_capture_response_invalid',
  'codex_timeout', 'codex_aborted', 'codex_launch_failed', 'codex_executable_missing', 'codex_invalid_memory_capture', 'codex_invalid_work_response']);
const safeFailureCode = (error, fallback = 'memory_capture_extract_failed') => {
  const candidate = [error?.code, error?.message].find(value => typeof value === 'string'
    && (failureCodes.has(value) || /^codex_failed_exit_\d{1,3}$/.test(value)));
  return candidate || fallback;
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const diagnosticState = value => ({ lastSuccessAt: validDate(value?.lastSuccessAt), lastFailureAt: validDate(value?.lastFailureAt),
  lastFailureCode: value?.lastFailureCode ? safeFailureCode({ code: value.lastFailureCode }) : null,
  consecutiveFailures: count(value?.consecutiveFailures) });
const roomReasons = new Set(['invalid_candidate', 'invalid_source_length', 'source_message_missing', 'invalid_source_identity',
  'excluded_content', 'not_complete_own_statement', 'amendment_target_unproven', 'removal_not_explicit', 'correction_not_supported',
  'resolution_not_supported', 'remember_operation_conflict', 'category_mismatch', 'source_not_in_batch', 'source_epoch_changed', 'room_epoch_changed', 'no_room_scope']);
const roomDiagnosticState = value => ({ startedAt: validDate(value?.startedAt),
  ...Object.fromEntries(['candidates', 'applied', 'rejected', 'unchanged', 'deferred'].map(key => [key, count(value?.[key])])),
  rejectionReasons: Object.fromEntries(Object.entries(value?.rejectionReasons || {}).filter(([key]) => roomReasons.has(key)).map(([key, value]) => [key, count(value)])) });
const empty = () => ({ version: 1, facts: {}, notes: {}, legacyImports: {}, noteRetirements: {}, rooms: {}, epochs: {}, roomEpochs: {}, pending: [], seen: [], counters: {}, rejectionReasons: {},
  diagnostics: diagnosticState(), roomDiagnostics: roomDiagnosticState() });
const bump = (state, key, count = 1) => { state.counters[key] = (state.counters[key] || 0) + count; };
const stamp = now => new Date(now).toISOString();
const validScope = value => value === 'private_owner' || /^member_[a-f0-9]{64}$/.test(value);
export const PRIVATE_OWNER_ROOM = 'private_owner';
const validRoom = value => value === '' || value === PRIVATE_OWNER_ROOM || /^[a-f0-9]{64}$/.test(value);
const roomOptions = room => ({ privateOwner: room === PRIVATE_OWNER_ROOM });
const terms = value => [...new Set((String(value || '').toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) || [])
  .flatMap(word => /^[a-z0-9]+$/.test(word) ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))))].slice(0, 160);

export class MemoryCapture {
  static async open(options) {
    const instance = new MemoryCapture(options);
    await mkdir(options.dataDir, { recursive: true });
    const canonical = await realpath(options.dataDir);
    if (process.platform === 'win32' && !isPortableAbsolute(canonical)) throw new Error('memory_capture_requires_d_storage');
    let state;
    try {
      const info = await lstat(instance.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('memory_capture_file_invalid');
      state = JSON.parse(await readFile(instance.path, 'utf8'));
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = empty(); }
    if (state.version !== 1 || !state.facts || !state.rooms || !Array.isArray(state.pending) || !Array.isArray(state.seen)
      || state.notes !== undefined && (!state.notes || typeof state.notes !== 'object' || Array.isArray(state.notes))
      || state.legacyImports !== undefined && (!state.legacyImports || typeof state.legacyImports !== 'object' || Array.isArray(state.legacyImports))
      || state.noteRetirements !== undefined && (!state.noteRetirements || typeof state.noteRetirements !== 'object' || Array.isArray(state.noteRetirements))) throw new Error('memory_capture_store_invalid');
    instance.state = { ...empty(), ...state, diagnostics: diagnosticState(state.diagnostics), roomDiagnostics: roomDiagnosticState(state.roomDiagnostics) };
    instance.schedule();
    return instance;
  }
  constructor({ dataDir, extract, isBusy = () => false, now = Date.now, idleMs = 30000, save, onError = () => {} }) {
    this.path = join(dataDir, 'memory_capture.json'); this.extract = extract; this.isBusy = isBusy; this.now = now;
    this.idleMs = idleMs; this.lastObservedAt = now(); this.onError = onError; this.state = empty(); this.writes = Promise.resolve();
    this.save = save || (async state => {
      await durableWriteFile(this.path, JSON.stringify(state, null, 2));
    });
  }
  transaction(change) {
    const job = this.writes.then(async () => {
      const draft = structuredClone(this.state);
      const result = change(draft);
      await this.save(draft);
      // Publish only a committed snapshot. Failed writes never become recallable.
      this.state = draft;
      return result;
    });
    this.writes = job.catch(() => {});
    return job;
  }
  storeFacts(state, scope, candidates, message) {
    const result = inspectPersonalCandidates(candidates, message.content, { limit: 4 });
    bump(state, 'proposed', Array.isArray(candidates) ? candidates.length : 0);
    for (const rejection of result.rejected) {
      bump(state, 'rejected'); state.rejectionReasons[rejection.reason] = (state.rejectionReasons[rejection.reason] || 0) + 1;
    }
    const facts = memoryEntries(state, scope);
    let added = 0;
    for (const candidate of result.accepted) {
      const sameKey = fact => {
        // Re-derive from the original evidence so a newly stated correction can
        // also retire entries written with older literal subject keys.
        const evidence = typeof fact.source === 'string' ? fact.source : '';
        const canonical = inspectPersonalCandidates([{ text: evidence, source: evidence }], evidence).accepted[0];
        return canonical ? canonical.key === candidate.key : fact.key === candidate.key;
      };
      const previous = facts.filter(fact => sameKey(fact) && (fact.origin !== 'legacy_unverified'
        || fact.source === candidate.source || personalUpdateIntent(message.content).review));
      if (previous.length === 1 && previous[0].source === candidate.source && previous[0].key === candidate.key) continue;
      // A delayed extraction must not undo a newer statement already captured
      // on the immediate path, even when both share a canonical key.
      if (previous.some(fact => !personalSourceIsCurrent(fact, message))) {
        bump(state, 'rejected'); state.rejectionReasons.stale_source = (state.rejectionReasons.stale_source || 0) + 1; continue;
      }
      // A fresh name or directly opposed preference replaces only this speaker's
      // same key. Other members and unrelated interests are never rewritten.
      const retired = new Set(previous);
      for (let index = facts.length - 1; index >= 0; index--) if (retired.has(facts[index])) facts.splice(index, 1);
      // A legacy or semantically updated row can still hold an ID derived from
      // an older key. Never reuse an active ID for a different surviving fact.
      let id = 'fact_' + hash([scope, candidate.key]).slice(0, 20), salt = 0;
      while (facts.some(fact => fact.id === id)) id = 'fact_' + hash([scope, candidate.key, message.messageId, ++salt]).slice(0, 20);
      facts.push({ id, ...candidate,
        origin: 'observed_statement', ...(previous.length ? { replaces: previous.map(noteTrace).slice(-4) } : {}),
        speaker: message.speaker, messageId: message.messageId, at: message.at, savedAt: stamp(this.now()),
        ...(Number.isSafeInteger(message.observedOrder) ? { observedOrder: message.observedOrder } : {}),
        ...(typeof message.observedAt === 'string' ? { observedAt: message.observedAt } : {}) });
      added++;
    }
    setMemoryEntries(state, scope, facts);
    bump(state, 'accepted', added);
    return added;
  }
  recordRoomDiagnostics(state, diagnostics) {
    const target = state.roomDiagnostics;
    target.startedAt ||= stamp(this.now());
    for (const key of ['candidates', 'applied', 'rejected', 'unchanged', 'deferred']) target[key] += count(diagnostics[key]);
    for (const [reason, value] of Object.entries(diagnostics.rejectionReasons || {})) if (roomReasons.has(reason)) {
      target.rejectionReasons[reason] = (target.rejectionReasons[reason] || 0) + count(value);
    }
  }
  inspectRoom(state, room, candidates, messages) {
    const result = inspectRoomMemory(state.rooms[room], candidates, messages, this.now(), roomOptions(room));
    this.recordRoomDiagnostics(state, result.diagnostics);
    return result.entries;
  }
  async observe({ scope, room = '', speaker, messageId, content, at }) {
    if (!validScope(scope) || !validRoom(room) || typeof messageId !== 'string' || !messageId || typeof content !== 'string'
      || (room === PRIVATE_OWNER_ROOM && (scope !== PRIVATE_OWNER_ROOM || speaker !== 'owner'))
      || (room && room !== PRIVATE_OWNER_ROOM && (scope === PRIVATE_OWNER_ROOM || !/^member_[a-f0-9]{16}$/.test(speaker || '')))) throw new Error('memory_capture_source_invalid');
    if (/^\s*\//.test(content) || content.length > 4000) return false;
    const id = hash([scope, messageId]);
    this.lastObservedAt = this.now();
    const result = await this.transaction(state => {
      if (state.seen.includes(id) || state.pending.some(job => job.id === id)) return false;
      bump(state, 'observed');
      const message = { speaker: speaker || 'owner', messageId, content, at: Number.isFinite(Date.parse(at)) ? at : stamp(this.now()),
        observedOrder: state.counters.observed, observedAt: stamp(this.now()) };
      const candidates = explicitPersonalCandidates(content);
      const accepted = this.storeFacts(state, scope, candidates, message);
      if (room) state.rooms[room] = this.inspectRoom(state, room, explicitRoomCandidates([message], { allowRequests: room === PRIVATE_OWNER_ROOM }), [message]);
      const amendment = personalUpdateIntent(content);
      if ((!accepted || amendment.review) && (!memoryOptOut(content) || amendment.deletion)
        && (memoryWorthReviewing(content) || amendment.review) && this.extract) {
        if (state.pending.length >= 512) throw new Error('memory_capture_backlog_full');
        state.pending.push({ id, scope, room, ...message, epoch: state.epochs[scope] || 0,
          roomEpoch: state.roomEpochs[room] || 0, attempts: 0, availableAt: this.now() });
      } else state.seen = [...state.seen, id].slice(-2000);
      return true;
    });
    this.schedule(); return result;
  }
  async rememberManual(input) {
    validateManualSource(input); const text = manualBody(input.content), expectedEpoch = this.state.epochs[input.scope] || 0;
    const receipt = sourceReceipt(input.scope, input.messageId);
    return this.transaction(state => {
      const prior = (state.notes[input.scope] || []).find(note => note.messageId === input.messageId && manualOrigins.has(note.origin));
      if (state.seen.includes(receipt)) return prior && prior.originalCommand !== input.content
        ? { status: 'invalid', id: '', text: '' } : { status: 'duplicate', id: prior?.id || '', text: prior?.text || '' };
      if ((state.epochs[input.scope] || 0) !== expectedEpoch) throw new Error('manual_memory_epoch_changed');
      const message = nextMemorySource(state, input, this.now()), personal = eligibleNote({ text });
      const entries = memoryEntries(state, input.scope);
      const retired = entries.filter(row => row.source === text || personal && row.key === personal.key
        && (row.origin !== 'legacy_unverified' || personalUpdateIntent(text).review));
      setMemoryEntries(state, input.scope, entries.filter(row => !retired.includes(row)));
      const sameText = (state.notes[input.scope] || []).filter(note => note.text === text && manualOrigins.has(note.origin));
      retireLegacyNotes(state, input.scope, sameText);
      const note = manualNote(input.scope, text, message, this.now(), { replaces: [...retired,...sameText] });
      state.notes[input.scope] = boundNotes([...(state.notes[input.scope] || []).filter(row => row.text !== text || !manualOrigins.has(row.origin)), note]);
      state.seen = [...state.seen, receipt].slice(-2000); bump(state, 'manualNotesSaved');
      return { status: 'saved', id: note.id, text };
    });
  }
  async importLegacy(input) {
    validateLegacyImport(input); const expectedEpoch = this.state.epochs[input.scope] || 0;
    return this.transaction(state => {
      const receipt = state.legacyImports[input.scope] ??= { fingerprints: [], closed: false };
      if (receipt.closed || (state.epochs[input.scope] || 0) !== expectedEpoch) return { status: 'blocked_after_forget', imported: 0, canonical: true };
      if (receipt.fingerprints.includes(input.sourceFingerprint)) return { status: 'already_imported', imported: 0, canonical: true };
      if (receipt.fingerprints.length >= 256) throw new Error('legacy_memory_receipts_full');
      const notes = state.notes[input.scope] ??= []; let imported = 0;
      for (const text of [...new Set(input.notes)]) {
        const importedNote = legacyNote(input.scope, text, input.ownerSpeaker, this.now(), count(state.counters.observed));
        if ((state.noteRetirements[input.scope] || []).includes(importedNote.id)) continue;
        if (notes.some(note => note.origin === 'legacy_unverified' && note.text === text)) continue;
        notes.push(importedNote); imported++;
      }
      state.notes[input.scope] = boundNotes(notes); receipt.fingerprints.push(input.sourceFingerprint);
      receipt.lastImportedAt = stamp(this.now()); bump(state, 'legacyNotesImported', imported);
      return { status: 'imported', imported, canonical: true };
    });
  }
  async amendNote(input) {
    validateManualSource(input);
    if (!validateNoteAmendment(input)) return { status: 'invalid', id: input.targetId || '' };
    const expectedEpoch = this.state.epochs[input.scope] || 0, receipt = sourceReceipt(input.scope, input.messageId);
    const captured = structuredClone([...(this.state.notes[input.scope] || []), ...(this.state.facts[input.scope] || [])].find(note => note.id === input.targetId));
    return this.transaction(state => {
      if (state.seen.includes(receipt)) return { status: 'duplicate', id: input.targetId };
      if ((state.epochs[input.scope] || 0) !== expectedEpoch) return { status: 'stale', id: input.targetId };
      const current = [...(state.notes[input.scope] || []), ...(state.facts[input.scope] || [])].find(note => note.id === input.targetId);
      if (!current) return { status: 'not_found', id: input.targetId };
      if (!captured || current.text !== input.targetText || JSON.stringify(current) !== JSON.stringify(captured)
        || (current.ownerSpeaker || current.speaker) !== input.speaker) return { status: 'stale', id: input.targetId };
      const message = nextMemorySource(state, input, this.now());
      if (!personalSourceIsCurrent(current, message)) return { status: 'stale', id: input.targetId };
      if (input.operation === 'delete') eraseNoteEvidence(state, input.scope, current);
      else {
        retireLegacyNotes(state, input.scope, [current]);
        state.facts[input.scope] = (state.facts[input.scope] || []).filter(note => note.id !== current.id);
        state.notes[input.scope] = boundNotes([...(state.notes[input.scope] || []).filter(note => note.id !== current.id),
          manualNote(input.scope, input.replacementText, message, this.now(), { id:current.id, origin:'manual_edit', replaces:[current] })]);
      }
      state.seen = [...state.seen, receipt].slice(-2000); bump(state, input.operation === 'delete' ? 'manualNotesDeleted' : 'manualNotesEdited');
      return { status: input.operation === 'delete' ? 'deleted' : 'updated', id:input.targetId };
    });
  }
  recall(scope, { query = '', limit = 12, maxChars = 2400, deduplicate = true } = {}) {
    const words = terms(query), now = this.now();
    const distinct = new Map();
    for (const row of [...(this.state.facts[scope] || []), ...(this.state.notes[scope] || [])]) {
      const old = distinct.get(row.text);
      if (!old || old.origin === 'legacy_unverified' && row.origin !== 'legacy_unverified'
        || old.origin !== 'legacy_unverified' && row.origin !== 'legacy_unverified' && count(row.observedOrder) > count(old.observedOrder)) distinct.set(row.text, row);
    }
    const entries = deduplicate ? [...distinct.values()] : [...(this.state.facts[scope] || []), ...(this.state.notes[scope] || [])];
    const ranked = entries.map(fact => ({ fact,
      score: (fact.kind === 'nickname' ? 100 : fact.kind === 'interaction' ? 20 : 0)
        + words.reduce((sum, word) => sum + (fact.text.toLowerCase().includes(word) ? 8 : 0), 0)
        + Math.max(0, 2 - (now - Date.parse(fact.savedAt || fact.importedAt)) / 86400000 / 30) }));
    ranked.sort((a, b) => b.score - a.score || String(b.fact.savedAt || b.fact.importedAt).localeCompare(String(a.fact.savedAt || a.fact.importedAt)));
    const selected = []; let chars = 0;
    for (const { fact } of ranked) {
      if (selected.length >= limit || chars + fact.text.length > maxChars) break;
      // Retired source evidence remains locally auditable, never an active fact
      // in model recall. Do not recursively copy old replacement chains.
      if (deduplicate && selected.some(row => row.text === fact.text)) continue;
      const { replaces, originalCommand, ...activeFact } = fact;
      selected.push(structuredClone(activeFact)); chars += fact.text.length;
    }
    return selected;
  }
  recallRoom(room, options = {}) { return roomMemorySnapshot(this.state.rooms[room], { now: this.now(), ...options, ...roomOptions(room) }); }
  async forget(scope, room = '') {
    if (scope === PRIVATE_OWNER_ROOM) room = PRIVATE_OWNER_ROOM;
    await this.transaction(state => {
      delete state.facts[scope]; delete state.notes[scope]; state.epochs[scope] = (state.epochs[scope] || 0) + 1;
      delete state.noteRetirements[scope];
      state.legacyImports[scope] = { fingerprints: [], closed: true };
      if (room) { delete state.rooms[room]; state.roomEpochs[room] = (state.roomEpochs[room] || 0) + 1; }
      state.pending = state.pending.filter(job => job.scope !== scope);
      bump(state, 'forgottenScopes');
    });
  }
  async resetRoom(room) {
    if (!room) return;
    await this.transaction(state => { delete state.rooms[room]; state.roomEpochs[room] = (state.roomEpochs[room] || 0) + 1; });
  }
  status() {
    const personalFacts = { total: 0, group: 0, private: 0 }, groupByKind = { topic: 0, agreement: 0, vocabulary: 0, request: 0 }, privateByKind = { ...groupByKind };
    const personalNotes = { total: 0, group: 0, private: 0, manual: 0, legacy: 0 };
    for (const [scope, rows] of Object.entries(this.state.facts)) { personalFacts.total += rows.length; personalFacts[scope === PRIVATE_OWNER_ROOM ? 'private' : 'group'] += rows.length; }
    for (const [scope, rows] of Object.entries(this.state.notes)) for (const note of rows) {
      personalNotes.total++; personalNotes[scope === PRIVATE_OWNER_ROOM ? 'private' : 'group']++;
      personalNotes[note.origin === 'legacy_unverified' ? 'legacy' : 'manual']++;
    }
    for (const [room, rows] of Object.entries(this.state.rooms)) {
      const kinds = room === PRIVATE_OWNER_ROOM ? privateByKind : groupByKind;
      for (const entry of pruneRoomMemory(rows, this.now(), roomOptions(room))) if (entry.status !== 'resolved') kinds[entry.kind]++;
    }
    return { ...structuredClone(this.state.counters), scope: 'background_capture_store', pending: this.state.pending.length, active: Boolean(this.active), facts: personalFacts.total,
      personalNotes, memoryCounts: { personalFacts, groupTopics: groupByKind.topic, groupConversation: Object.values(groupByKind).reduce((a, b) => a + b, 0),
        privateContinuity: Object.values(privateByKind).reduce((a, b) => a + b, 0), groupByKind, privateByKind },
      ...structuredClone(this.state.diagnostics), roomDiagnostics: structuredClone(this.state.roomDiagnostics),
      rejectionReasons: structuredClone(this.state.rejectionReasons),
      lastError: this.lastError || (this.state.diagnostics.consecutiveFailures ? this.state.diagnostics.lastFailureCode : null) };
  }
  async cancelPending(){
    clearTimeout(this.timer);this.timer=null;
    return this.transaction(state=>{
      const scopes=new Set(state.pending.map(job=>job.scope)),rooms=new Set(state.pending.map(job=>job.room).filter(Boolean));
      for(const scope of scopes)state.epochs[scope]=(state.epochs[scope]||0)+1;
      for(const room of rooms)state.roomEpochs[room]=(state.roomEpochs[room]||0)+1;
      const count=state.pending.length;state.seen=[...new Set([...state.seen,...state.pending.map(job=>job.id)])].slice(-2000);state.pending=[];
      return count;
    });
  }
  schedule(delay = 1000) {
    if (this.closed || this.timer || !this.extract || !this.state.pending.length) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain().catch(() => { this.lastError = 'memory_capture_commit_failed'; this.onError(this.lastError); }); }, delay);
    this.timer.unref?.();
  }
  async drain({ force = false } = {}) {
    if (this.closed || this.active || !this.extract || !this.state.pending.length) return false;
    if (this.isBusy() || (!force && this.now() - this.lastObservedAt < this.idleMs)) { this.schedule(); return false; }
    const first = this.state.pending.find(job => job.availableAt <= this.now());
    if (!first) { this.schedule(); return false; }
    // Consume contiguous oldest pending messages for one scope; never advance a
    // cursor over unselected messages and never mix private/group member scopes.
    const batch = [];
    for (const job of this.state.pending) {
      if (job.scope !== first.scope) continue;
      if (job.availableAt > this.now() || batch.length >= 8) break;
      batch.push(structuredClone(job));
    }
    this.active = true;
    let phase = 'extract';
    try {
      const targetSnapshot = batch.some(job => personalUpdateIntent(job.content).review)
        ? personalUpdateTargets(memoryEntries(this.state, first.scope), { query: batch.map(job => job.content).join('\n') }) : [];
      const result = await this.extract({ mode: 'memory_capture', structured: true, runtimeRoom:first.room,
        conversationKind: first.room === 'private_owner' ? 'private' : 'group',
        messages: batch.map(({ content, messageId, speaker, at }) => ({ content, messageId, speaker, at })),
        existingMemory: this.recall(first.scope, { limit: 16 }), existingPersonalTargets: targetSnapshot,
        existingRoomMemory: first.room ? this.recallRoom(first.room) : [] });
      if (this.closed) return false;
      if (!Array.isArray(result?.personal) || !Array.isArray(result?.room)
        || (result.personal_updates !== undefined && !Array.isArray(result.personal_updates))) throw new Error('memory_capture_response_invalid');
      phase = 'commit';
      await this.transaction(state => {
        let accepted = 0;
        // Preserve the existing first-16 candidate / four applications per
        // source semantics, while counting each proposal once rather than once
        // for every message in the batch.
        const roomCandidates = result.room.slice(0, 16);
        const updates = (result.personal_updates || []).slice(0, 16);
        const sourceIndex = candidate => batch.findIndex(job => candidate?.messageId === job.messageId && candidate?.speaker === job.speaker);
        const recordPersonalRejection = reason => {
          bump(state, 'rejected'); const key = 'personal_update_' + reason;
          state.rejectionReasons[key] = (state.rejectionReasons[key] || 0) + 1;
        };
        // Validate before comparing recency: a malformed later proposal must
        // not suppress an earlier genuine correction for the same target.
        const validUpdates = updates.filter(candidate => {
          const job = batch[sourceIndex(candidate)];
          if (!job || (state.epochs[job.scope] || 0) !== job.epoch) return false;
          const checked = inspectPersonalUpdates(memoryEntries(state, job.scope), [candidate], job, { targets: targetSnapshot, now: this.now() });
          for (const reason of checked.rejected) recordPersonalRejection(reason);
          return checked.applied > 0;
        });
        const latestUpdates = validUpdates.filter(candidate => !validUpdates.some(later => later.targetId === candidate.targetId
          && sourceIndex(later) > sourceIndex(candidate)));
        if (result.room.length > 16) this.recordRoomDiagnostics(state, { candidates: result.room.length - 16, deferred: result.room.length - 16 });
        const unmatched = roomCandidates.filter(candidate => !batch.some(job => candidate?.messageId === job.messageId && candidate?.speaker === job.speaker)).length;
        if (unmatched) this.recordRoomDiagnostics(state, { candidates: unmatched, rejected: unmatched, rejectionReasons: { source_not_in_batch: unmatched } });
        for (const job of batch) {
          const roomProposals = roomCandidates.filter(candidate => candidate?.messageId === job.messageId && candidate?.speaker === job.speaker);
          if ((state.epochs[job.scope] || 0) !== job.epoch) {
            if (roomProposals.length) this.recordRoomDiagnostics(state, { candidates: roomProposals.length, rejected: roomProposals.length, rejectionReasons: { source_epoch_changed: roomProposals.length } });
            continue;
          }
          const personal = result.personal.filter(item => item?.messageId === job.messageId && item.speaker === job.speaker);
          accepted += this.storeFacts(state, job.scope, personal, job);
          const beforeAmendment = memoryEntries(state, job.scope);
          const jobUpdates = latestUpdates.filter(candidate => candidate.messageId === job.messageId && candidate.speaker === job.speaker);
          const amended = inspectPersonalUpdates(beforeAmendment, jobUpdates.filter(candidate => candidate.messageId === job.messageId
            && candidate.speaker === job.speaker), job, { targets: targetSnapshot, now: this.now() });
          setMemoryEntries(state, job.scope, amended.facts);
          for (const candidate of jobUpdates.filter(item => item.operation === 'delete')) {
            const deleted = beforeAmendment.find(row => row.id === candidate.targetId);
            if (deleted && !amended.facts.some(row => row.id === deleted.id)) eraseNoteEvidence(state, job.scope, deleted);
          }
          accepted += amended.applied; bump(state, 'personalUpdates', amended.applied);
          for (const reason of amended.rejected) recordPersonalRejection(reason);
          if (job.room && (state.roomEpochs[job.room] || 0) === job.roomEpoch) {
            const prior = state.rooms[job.room] || [];
            const next = this.inspectRoom(state, job.room, roomProposals, [job]);
            bump(state, 'roomWrites', next.filter(entry => !prior.some(old => old.id === entry.id && old.updatedAt === entry.updatedAt)).length);
            state.rooms[job.room] = next;
          } else if (roomProposals.length) {
            const reason = job.room ? 'room_epoch_changed' : 'no_room_scope';
            this.recordRoomDiagnostics(state, { candidates: roomProposals.length, rejected: roomProposals.length, rejectionReasons: { [reason]: roomProposals.length } });
          }
        }
        const ids = new Set(batch.map(job => job.id));
        state.pending = state.pending.filter(job => !ids.has(job.id));
        state.seen = [...new Set([...state.seen, ...ids])].slice(-2000);
        bump(state, 'backgroundRuns'); if (!accepted && !result.room.length) bump(state, 'noChange');
        state.diagnostics.lastSuccessAt = stamp(this.now()); state.diagnostics.consecutiveFailures = 0;
      });
      this.lastError = null; return true;
    } catch (error) {
      if (this.closed) return false;
      this.lastError = phase === 'commit' ? 'memory_capture_commit_failed' : safeFailureCode(error); this.onError(this.lastError);
      await this.transaction(state => {
        const ids = new Set(batch.map(job => job.id));
        for (const job of state.pending) if (ids.has(job.id)) { job.attempts++; job.availableAt = this.now() + Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 5)); }
        bump(state, 'failures');
        state.diagnostics.lastFailureAt = stamp(this.now()); state.diagnostics.lastFailureCode = this.lastError;
        state.diagnostics.consecutiveFailures++;
      });
      return false;
    } finally { this.active = false; this.schedule(); }
  }
  async close() { this.closed = true; clearTimeout(this.timer); await this.writes; }
}
