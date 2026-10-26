import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSharedVoiceStatusReader } from '../src/shared_voice_status.mjs';

const workRoot = path.resolve('temp');
const moduleText = '// synthetic inert provider fixture\n';
const providerSha256 = createHash('sha256').update(moduleText).digest('hex');
const control = { schemaVersion: 1, phase: 'readiness_only', generationImplemented: false, inferencePaused: true,
  reason: 'fatal_whea_unresolved', mode: 'on_demand', fallback: 'text' };
const profiles = { schemaVersion: 1, profiles: { xiaoke: { id: 'xiaoke', adapter: 'xiaoke_reference_voice',
  projectRoot: process.cwd(), sources: { profile: 'voice_profile.json' },
  referenceSha256: '4f22f69e60e4c872075828eb893a93869a3478997e5ef3d8b2635436239c8cf6',
  transport: { kind: 'qq_bot_api', nativeVoiceSupported: true } } } };
const pausedStatus = { characterId: 'xiaoke', available: false, ready: false, paused: true,
  phase: 'readiness_only', generationImplemented: false, mode: 'on_demand', fallback: 'text',
  reason: 'fatal_whea_unresolved', blockers: ['fatal_whea_unresolved', 'generation_not_implemented'],
  selectionStatus: 'approved', transportSupported: true, profileHash: 'a'.repeat(64) };

const activeXiaoke = {schemaVersion:1,enabled:true,characterId:'xiaoke',mode:'on_demand',resourceMonitoring:true,
  authorization:'human_requested_xiaoke_deployment_and_load_measurement',
  approvedVoiceProfileSha256:'0dfa9c4a845e47991b511ff65b3976751ebfdd4d4c38dd006c2ecbed7aac6f42',
  referenceSha256:'4f22f69e60e4c872075828eb893a93869a3478997e5ef3d8b2635436239c8cf6'};

async function fixture(t, status = async () => pausedStatus, options = {}) {
  await mkdir(workRoot, { recursive: true });
  const root = await mkdtemp(path.join(workRoot, 'shared_voice_status_'));
  t.after(async () => {
    const relative = path.relative(workRoot, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([writeFile(path.join(root, 'provider.mjs'), moduleText),
    writeFile(path.join(root, 'control.json'), JSON.stringify(control)),
    writeFile(path.join(root, 'profiles.json'), JSON.stringify(profiles))]);
  const stats = { imports: 0, statusReads: 0 };
  const reader = createSharedVoiceStatusReader({ root, providerSha256, loadProvider: async () => {
    stats.imports++;
    return { createProvider: supplied => {
      assert.equal(supplied.root, root);
      return { status: async id => { assert.equal(id, 'xiaoke'); stats.statusReads++; return status(); },
        generate: () => assert.fail('readiness adapter must never generate') };
    } };
  }, ...options });
  return { root, reader, stats };
}

function assertDenied(state) {
  assert.equal(state.available, false); assert.equal(state.ready, false); assert.equal(state.paused, true);
  assert.equal(state.generationImplemented, false); assert.equal(state.inferenceAllowed, false);
}

test('Xiaoke-only activation is revocable and cannot authorize a different voice', async t => {
  const bytes = Buffer.from('synthetic approved public voice profile');
  const approvedProfileSha256=createHash('sha256').update(bytes).digest('hex');
  const activeFixture={...activeXiaoke,approvedVoiceProfileSha256:approvedProfileSha256};
  const {root,reader}=await fixture(t,async()=>pausedStatus,{approvedProfileSha256,readApprovedProfile:()=>bytes});
  const file=path.join(root,'xiaoke_activation.json');
  await writeFile(file,JSON.stringify(activeFixture));
  assert.equal(reader.read().inferenceAllowed,true);
  assert.equal((await reader.refresh()).ready,true);
  for(const changes of [{characterId:'fatfish'},{resourceMonitoring:false},{referenceSha256:'b'.repeat(64)},{enabled:false}]){
    await writeFile(file,JSON.stringify({...activeFixture,...changes}));assertDenied(reader.read());
  }
  await writeFile(file,JSON.stringify(activeFixture));
  const {reader:changed,root:changedRoot}=await fixture(t,async()=>pausedStatus,{approvedProfileSha256,readApprovedProfile:()=>Buffer.from('changed')});
  await writeFile(path.join(changedRoot,'xiaoke_activation.json'),JSON.stringify(activeFixture));
  assert.equal(changed.read().reason,'approved_profile_changed');
});

test('synchronous gate rereads current controls without importing or executing the provider', async t => {
  const { root, reader, stats } = await fixture(t);
  assertDenied(reader.read()); assert.equal(reader.read().phase, 'readiness_only');
  await writeFile(path.join(root, 'control.json'), JSON.stringify({ ...control, inferencePaused: false }));
  assert.equal(reader.read().reason, 'hard_pause_locked');
  assertDenied(reader.read()); assert.deepEqual(stats, { imports: 0, statusReads: 0 });
});

test('diagnostic refresh invokes only xiaoke status and preserves approved metadata without granting permission', async t => {
  const { root, reader, stats } = await fixture(t);
  const before = await Promise.all(['provider.mjs', 'control.json', 'profiles.json'].map(name => readFile(path.join(root, name))));
  const result = await reader.refresh();
  assertDenied(result); assert.equal(result.selectionStatus, 'approved'); assert.equal(result.profileHash, 'a'.repeat(64));
  assert.deepEqual(stats, { imports: 1, statusReads: 1 });
  const after = await Promise.all(['provider.mjs', 'control.json', 'profiles.json'].map(name => readFile(path.join(root, name))));
  assert.deepEqual(after, before);
});

test('module missing or changed fails closed before any import and never reuses earlier diagnosis', async t => {
  const { root, reader, stats } = await fixture(t);
  await reader.refresh();
  await writeFile(path.join(root, 'provider.mjs'), `${moduleText}// changed\n`);
  assert.equal(reader.read().reason, 'shared_provider_unreviewed');
  assertDenied(await reader.refresh()); assert.equal(stats.imports, 1);
  await rm(path.join(root, 'provider.mjs'));
  assert.equal(reader.read().reason, 'shared_file_unavailable');
  assertDenied(await reader.refresh()); assert.equal(stats.imports, 1);
});

test('invalid UTF8, zero-filled, oversized and missing controls stay unavailable', async t => {
  const { root, reader, stats } = await fixture(t);
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(50), Buffer.alloc(128 * 1024 + 1)]) {
    await writeFile(path.join(root, 'control.json'), bytes);
    assertDenied(reader.read()); assert.equal(reader.read().phase, 'unavailable');
    assertDenied(await reader.refresh());
  }
  await rm(path.join(root, 'control.json'));
  assertDenied(reader.read()); assert.equal(stats.imports, 0);
});

test('config flags and an unreviewed future phase cannot enable synthesis', async t => {
  const { root, reader, stats } = await fixture(t);
  for (const changes of [{ phase: 'ready' }, { generationImplemented: true }, { schemaVersion: 2 }, { mode: 'always_on' }]) {
    await writeFile(path.join(root, 'control.json'), JSON.stringify({ ...control, ...changes }));
    assert.equal(reader.read().reason, 'shared_control_invalid'); assertDenied(await reader.refresh());
  }
  assert.equal(stats.imports, 0);
});

test('a different project, voice reference or transport cannot be selected through registry edits', async t => {
  const { root, reader, stats } = await fixture(t);
  for (const changes of [{ projectRoot: 'D:/another_project' }, { referenceSha256: 'b'.repeat(64) },
    { transport: { kind: 'onebot_qq', nativeVoiceSupported: true } }]) {
    const changed = { ...profiles, profiles: { xiaoke: { ...profiles.profiles.xiaoke, ...changes } } };
    await writeFile(path.join(root, 'profiles.json'), JSON.stringify(changed));
    assert.equal(reader.read().reason, 'shared_profile_invalid'); assertDenied(await reader.refresh());
  }
  assert.equal(stats.imports, 0);
});

test('forged ready status and wrong role are rejected even when provider import succeeds', async t => {
  let next = { ...pausedStatus, available: true, ready: true, paused: false, generationImplemented: true };
  const { reader } = await fixture(t, async () => next);
  assert.equal((await reader.refresh()).reason, 'shared_provider_contract_changed');
  next = { ...pausedStatus, characterId: 'fatfish' };
  assert.equal((await reader.refresh()).reason, 'shared_provider_contract_changed');
  assertDenied(reader.read());
});

test('module and control changes during an async status read invalidate its result', async t => {
  let release;
  const { root, reader } = await fixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = reader.refresh();
  await new Promise(resolve => setImmediate(resolve));
  await writeFile(path.join(root, 'control.json'), JSON.stringify({ ...control, inferencePaused: false }));
  release(pausedStatus);
  const result = await pending;
  assertDenied(result); assert.equal(result.reason, 'shared_state_changed');
});

test('bounded diagnostic timeout fails closed and late results never authorize subsequent reads', async t => {
  let release;
  const { reader } = await fixture(t, () => new Promise(resolve => { release = resolve; }), { timeoutMs: 15 });
  const result = await reader.refresh();
  assert.equal(result.reason, 'shared_status_timeout'); assertDenied(result);
  release(pausedStatus); await new Promise(resolve => setImmediate(resolve));
  assertDenied(reader.read());
});

test('raw provider errors and additional diagnostic fields do not expose source text or paths', async t => {
  let next = { ...pausedStatus, text: 'private text', path: 'C:/private',
    blockers: ['valid_code', 'C:/private secret'], selectionStatus: 'C:/private', profileHash: 'private' };
  const { reader } = await fixture(t, async () => { if (next instanceof Error) throw next; return next; });
  const result = await reader.refresh();
  assert.deepEqual(result.blockers, ['valid_code']); assert.equal(result.profileHash, null);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  next = Error('C:/private secret');
  assert.equal((await reader.refresh()).reason, 'shared_status_unavailable');
});

test('reader options reject relative and malformed roots rather than silently falling back', () => {
  for (const root of ['.', 'relative/shared_voice', path.resolve('temp')+'\0bad']) {
    assert.throws(() => createSharedVoiceStatusReader({ root }), /options_invalid/);
  }
});
