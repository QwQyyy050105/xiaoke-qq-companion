import {isAbsolute as isPortableAbsolute} from 'node:path';
import { openSync, closeSync, fstatSync, readSync, realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHARED_ROOT = process.env.XIAOKE_SHARED_VOICE_ROOT || path.resolve(import.meta.dirname,'..','runtime','shared_voice');
const REVIEWED_PROVIDER_SHA256 = 'd2ae8a251258d952a0b0ecf55b6ba1e84614751081ba7c73c008bd13f85e798d';
const PROJECT_ROOT = path.resolve(import.meta.dirname,'..');
const REFERENCE_SHA256 = '4f22f69e60e4c872075828eb893a93869a3478997e5ef3d8b2635436239c8cf6';
const APPROVED_PROFILE_SHA256 = '0dfa9c4a845e47991b511ff65b3976751ebfdd4d4c38dd006c2ecbed7aac6f42';
const LIMIT = 128 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value);

function denied(reason, phase = 'unavailable', extra = {}) {
  return { characterId: 'xiaoke', available: false, ready: false, paused: true, phase,
    generationImplemented: false, inferenceAllowed: false, mode: 'on_demand', fallback: 'text',
    reason, ...extra };
}

function failure(reason) { throw Object.assign(new Error(reason), { safeReason: reason }); }

function readBounded(root, name) {
  let handle;
  try {
    const file = path.join(root, name);
    if (!samePath(realpathSync(file), file)) failure('shared_path_mismatch');
    handle = openSync(file, 'r');
    const before = fstatSync(handle);
    if (!before.isFile() || before.size > LIMIT) failure('shared_file_invalid');
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(handle, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fstatSync(handle);
    if (used !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      failure('shared_state_changed');
    }
    return bytes.subarray(0, used);
  } catch (error) {
    if (error?.safeReason) throw error;
    failure('shared_file_unavailable');
  } finally { if (handle !== undefined) closeSync(handle); }
}

function json(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
    if (!object(value)) failure('shared_state_invalid');
    return value;
  } catch { failure('shared_state_invalid'); }
}

// Options exist only for isolated offline tests. Runtime callers use the fixed
// default reader, never a root/module/role supplied by chat or an HTTP request.
export function createSharedVoiceStatusReader({ root = SHARED_ROOT, providerSha256 = REVIEWED_PROVIDER_SHA256,
  loadProvider = url => import(url), timeoutMs = 1000,
  approvedProfileSha256 = APPROVED_PROFILE_SHA256, readApprovedProfile = () => readBounded(PROJECT_ROOT, 'voice_profile.json') } = {}) {
  if (typeof root !== 'string' || !isPortableAbsolute(root) || !path.isAbsolute(root) || root.includes('\0') ||
      !/^[a-f0-9]{64}$/.test(providerSha256) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    throw new TypeError('shared_voice_reader_options_invalid');
  }
  function inspect() {
    try {
      if (!samePath(realpathSync(root), root)) failure('shared_path_mismatch');
      const moduleBytes = readBounded(root, 'provider.mjs');
      if (sha256(moduleBytes) !== providerSha256) failure('shared_provider_unreviewed');
      const controlBytes = readBounded(root, 'control.json');
      const profileBytes = readBounded(root, 'profiles.json');
      const control = json(controlBytes);
      const profiles = json(profileBytes);
      if (control.schemaVersion !== 1 || control.phase !== 'readiness_only' || control.generationImplemented !== false ||
          typeof control.inferencePaused !== 'boolean' || control.reason !== 'fatal_whea_unresolved' ||
          control.mode !== 'on_demand' || control.fallback !== 'text') failure('shared_control_invalid');
      const entry = profiles.profiles?.xiaoke;
      if (profiles.schemaVersion !== 1 || !object(entry) || entry.id !== 'xiaoke' || entry.adapter !== 'xiaoke_reference_voice' ||
          typeof entry.projectRoot !== 'string' || !samePath(entry.projectRoot, PROJECT_ROOT) ||
          entry.sources?.profile !== 'voice_profile.json' || entry.referenceSha256 !== REFERENCE_SHA256 ||
          entry.transport?.kind !== 'qq_bot_api' || entry.transport?.nativeVoiceSupported !== true) failure('shared_profile_invalid');
      if (existsSync(path.join(root, 'xiaoke_activation.json'))) {
        const activationBytes = readBounded(root, 'xiaoke_activation.json');
        const a = json(activationBytes);
        if (a.enabled === true) {
          if (a.schemaVersion !== 1 || a.characterId !== 'xiaoke' || a.mode !== 'on_demand' ||
              a.authorization !== 'human_requested_xiaoke_deployment_and_load_measurement' || a.resourceMonitoring !== true ||
              a.approvedVoiceProfileSha256 !== approvedProfileSha256 || a.referenceSha256 !== REFERENCE_SHA256) failure('shared_activation_invalid');
          if (sha256(readApprovedProfile()) !== approvedProfileSha256) failure('approved_profile_changed');
          return { status: { characterId:'xiaoke', available:true, ready:true, paused:false, phase:'ready',
            generationImplemented:true, inferenceAllowed:true, mode:'on_demand', fallback:'text', reason:'xiaoke_activated' },
            fingerprint:sha256(Buffer.concat([moduleBytes,controlBytes,profileBytes,activationBytes])) };
        }
      }
      return { status: denied(control.inferencePaused ? control.reason : 'hard_pause_locked', 'readiness_only'),
        fingerprint: sha256(Buffer.concat([moduleBytes, controlBytes, profileBytes])) };
    } catch (error) {
      return { status: denied(error?.safeReason || 'shared_status_unavailable'), fingerprint: null };
    }
  }

  function read() { return inspect().status; }

  // Diagnostic refresh alone may call the audited provider. No refresh result
  // can grant permission: this integration supports only readiness_only v1.
  async function refresh() {
    const before = inspect();
    if (!before.fingerprint) return before.status;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('shared_status_timeout'), { safeReason: 'shared_status_timeout' })), timeoutMs);
    });
    try {
      const state = await Promise.race([deadline, (async () => {
        const module = await loadProvider(pathToFileURL(path.join(root, 'provider.mjs')).href);
        const provider = module?.createProvider?.({ root });
        if (typeof provider?.status !== 'function') failure('shared_provider_invalid');
        return provider.status('xiaoke');
      })()]);
      const after = inspect();
      if (!after.fingerprint) return after.status;
      if (after.fingerprint !== before.fingerprint) return denied('shared_state_changed');
      if (!object(state) || state.characterId !== 'xiaoke' || state.available !== false || state.ready !== false ||
          state.paused !== true || state.phase !== 'readiness_only' || state.generationImplemented !== false ||
          state.mode !== 'on_demand' || state.fallback !== 'text' || !safeCode(state.reason)) return denied('shared_provider_contract_changed');
      const blockers = Array.isArray(state.blockers) ? state.blockers.filter(safeCode).slice(0, 16) : [];
      const selectionStatus = ['unknown', 'approved', 'not_selected', 'pending', 'rejected'].includes(state.selectionStatus)
        ? state.selectionStatus : 'unknown';
      if (before.status.inferenceAllowed) {
        if (selectionStatus !== 'approved' || state.transportSupported !== true ||
            blockers.some(x => !['fatal_whea_unresolved','generation_not_implemented'].includes(x))) return denied('source_admission_closed');
        return { ...after.status, selectionStatus, transportSupported:true, profileHash:state.profileHash, blockers:[] };
      }
      return denied(state.reason, 'readiness_only', { blockers, selectionStatus,
        transportSupported: state.transportSupported === true,
        profileHash: typeof state.profileHash === 'string' && /^[a-f0-9]{64}$/.test(state.profileHash) ? state.profileHash : null });
    } catch (error) { return denied(error?.safeReason || 'shared_status_unavailable'); }
    finally { clearTimeout(timer); }
  }

  return Object.freeze({ read, refresh });
}

const defaultReader = createSharedVoiceStatusReader();
export const readSharedVoiceStatus = () => defaultReader.read();
export const refreshSharedVoiceStatus = () => defaultReader.refresh();
