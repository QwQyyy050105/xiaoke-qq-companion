import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { VocabularyLearning, extractVocabularyCandidates } from '../src/vocabulary_learning.mjs';
import { groupMemberSpeaker } from '../src/social_wait.mjs';
import { mergeRoomMemory } from '../src/room_memory.mjs';

const now = Date.parse('2026-10-22T04:00:00Z');
const event = (id, content, member = 'alice', room = 'room-a') => ({ id, content, author: { member_openid: member }, group_openid: room, chat_type: 'group' });
async function fixture(t) {
  const root = resolve(process.cwd(), 'temp'); await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(join(root, 'vocabulary_learning_'));
  const learning = await new VocabularyLearning({ dataDir, now: () => now }).init();
  t.after(async () => { await learning.queue.catch(() => {}); assert.ok(resolve(dataDir).startsWith(root + sep)); await rm(dataDir, { recursive: true, force: true }); await assert.rejects(access(dataDir), { code: 'ENOENT' }); });
  return { learning, dataDir };
}

test('automatic extraction selects small unfamiliar candidates and explicit definitions, not ordinary or sensitive conversation', () => {
  assert.deepEqual(extractVocabularyCandidates('yyds，今天这局 xswl').map(item => item.term), ['yyds', 'xswl']);
  assert.equal(extractVocabularyCandidates('猫饼是什么意思？')[0].term, '猫饼');
  const definition = extractVocabularyCandidates('本群“猫饼”是指趴成一团的猫。')[0];
  assert.deepEqual(definition, { term: '猫饼', source: '本群“猫饼”是指趴成一团的猫。', meaning: '趴成一团的猫', declared: true });
  for (const text of ['大家今天吃什么？', 'AI QQ GPT API CPU', '我喜欢“猫饼”', '我的密码是abc。“猫饼”',
    '本群猫饼是指阿明的昵称。', '他说：猫饼是指趴着的猫。', '> 本群猫饼是指趴着的猫。', '/remember yyds',
    '我得了肺炎，yyds', '我叫王小明，xswl']) assert.deepEqual(extractVocabularyCandidates(text), [], text);
  assert.equal(extractVocabularyCandidates('“猫饼是指趴着的猫。”').some(item => item.declared), false);
});

test('default production clock supports initialization, observation, research and persisted timestamps without injection', async t => {
  const { dataDir } = await fixture(t);
  const learning = await new VocabularyLearning({ dataDir }).init();
  const before = Date.now();
  assert.equal((await learning.observe(event('real-clock', '猫饼是什么意思？'))).changed, true);
  const candidate = learning.context('room-a')[0];
  const observedAt = Date.parse(candidate.createdAt);
  assert.ok(observedAt >= before && observedAt <= Date.now());
  assert.equal(learning.prepareResearch('room-a').context.candidates[0].term, '猫饼');
  const restored = await new VocabularyLearning({ dataDir }).init();
  assert.deepEqual(restored.context('room-a'), learning.context('room-a'));
  assert.equal((await restored.observe(event('real-definition', '本群猫饼是指趴成一团的猫。'))).changed, true);
  assert.equal(restored.context('room-a')[0].status, 'confirmed');
});

test('observations persist with each member provenance, deduplicate and never enter private or another group', async t => {
  const { learning, dataDir } = await fixture(t);
  const a = event('a', '“猫饼”来了'), b = event('b', 'yyds', 'bob');
  await learning.observe({ ...b, turn_messages: [a, b], source_ids: ['a', 'b'] });
  await learning.observe(a);
  assert.equal(learning.context('room-a').length, 2);
  assert.equal(learning.context('room-a').find(item => item.term === '猫饼').observations.length, 1);
  assert.equal(learning.context('room-a').find(item => item.term === 'yyds').observations[0].speaker, groupMemberSpeaker('room-a', 'bob'));
  await learning.observe({ id: 'private', content: '“私密词”', author: { user_openid: 'owner' } });
  assert.deepEqual(learning.context('room-b'), []);
  const restored = await new VocabularyLearning({ dataDir, now: () => now }).init();
  assert.deepEqual(restored.context('room-a'), learning.context('room-a'));
  const saved = await readFile(join(dataDir, 'vocabulary_state.json'), 'utf8');
  assert.doesNotMatch(saved, /room-a|alice|bob|私密词|user_openid|member_openid/);
  const snapshot = restored.snapshot(); snapshot[0].candidates[0].term = 'mutated';
  assert.notEqual(restored.context('room-a')[0].term, 'mutated');
});

test('internet findings remain separate unconfirmed evidence; forged confirmation and cross-room tickets are ignored', async t => {
  const { learning } = await fixture(t);
  const input = event('term', '猫饼是什么意思？');
  await learning.observe(input);
  const prepared = learning.prepareResearch('room-a');
  assert.equal(prepared.context.candidates.length, 1);
  assert.doesNotMatch(JSON.stringify(prepared.context), /member_|room-a|messageId/);
  const id = prepared.context.candidates[0].id;
  const action = { operation: 'research', candidate_id: id, meaning: '网上指某种猫的姿态', sources: [{ url: 'https://example.org/cat', title: '网络词解释', excerpt: '猫的姿态', verified: true }] };
  await learning.observe(event('other', '猫饼是什么意思？', 'alice', 'room-b'));
  assert.deepEqual(await learning.applyModelActions(event('foreign', '' ,'alice', 'room-b'), [action], { researchToken: prepared.token }), { applied: 0 });
  assert.deepEqual(await learning.applyModelActions(input, [{ operation: 'confirm', candidate_id: id, meaning: '编造' }], { researchToken: prepared.token }), { applied: 0 });
  const next = learning.prepareResearch('room-a');
  assert.deepEqual(await learning.applyModelActions(input, [action], { researchToken: next.token }), { applied: 1 });
  const entry = learning.context('room-a')[0];
  assert.equal(entry.status, 'pending'); assert.equal(entry.meaning, '');
  assert.equal(entry.web_evidence[0].sources[0].verified, false, 'the model cannot verify its own URL');
  assert.equal(entry.member_confirmations.length, 0);
});

test('a member explanation confirms group usage, exposes an exact room-memory candidate, and conflicting members stay uncertain', async t => {
  const { learning } = await fixture(t);
  await learning.observe(event('question', '猫饼是什么意思？'));
  const definition = event('definition', '本群猫饼是指趴成一团的猫。', 'bob');
  const result = await learning.observe(definition);
  const entry = learning.context('room-a')[0];
  assert.equal(entry.status, 'confirmed'); assert.equal(entry.confirmedBy, 'member');
  assert.equal(entry.meaning, '趴成一团的猫');
  const message = { messageId: definition.id, speaker: groupMemberSpeaker('room-a', 'bob'), content: definition.content };
  assert.equal(mergeRoomMemory([], result.roomCandidates, [message], now)[0].source, definition.content);
  await learning.observe(event('conflict', '本群猫饼是指猫形饼干。', 'alice'));
  const conflict = learning.context('room-a')[0];
  assert.equal(conflict.status, 'pending'); assert.equal(conflict.meaning, '');
  assert.equal(conflict.member_confirmations.length, 2);
  await learning.observe(event('plain-definition', '猫饼就是猫形饼干。', 'bob'));
  assert.equal(learning.context('room-a')[0].status, 'confirmed');
  assert.equal(learning.context('room-a')[0].meaning, '猫形饼干');
});

test('model candidates require a real current author/source and cannot guess absent words or learn private text', async t => {
  const { learning } = await fixture(t);
  const current = event('plain', '咱们今天一起叠猫饼吧。');
  await learning.observe(current);
  const action = { operation: 'propose', term: '叠猫饼', source: current.content, messageId: current.id, speaker: groupMemberSpeaker('room-a', 'alice') };
  assert.deepEqual(await learning.applyModelActions(current, [{ ...action, term: '编造词' }, { ...action, speaker: groupMemberSpeaker('room-a', 'bob') }, action]), { applied: 1 });
  assert.equal(learning.context('room-a')[0].status, 'pending');
  const secret = event('secret', '我的病史是“龙眠症”');
  assert.deepEqual(await learning.applyModelActions(secret, [{ ...action, term: '龙眠症', source: secret.content, messageId: secret.id }]), { applied: 0 });
});

test('forget and local review invalidate old research while local-only confirmation retains its distinct origin', async t => {
  const { learning } = await fixture(t);
  const input = event('term', '猫饼是什么意思？'); await learning.observe(input);
  const prepared = learning.prepareResearch('room-a'), id = prepared.context.candidates[0].id;
  const scope = learning.snapshot()[0].scope;
  assert.equal(await learning.review(scope, id, { operation: 'confirm', meaning: '群里的猫形饼干' }), true);
  assert.equal(learning.context('room-a')[0].confirmedBy, 'owner_local');
  assert.deepEqual(await learning.applyModelActions(input, [{ operation: 'reject', candidate_id: id, note: '普通词' }], { researchToken: prepared.token }), { applied: 0 });
  assert.equal(await learning.review(scope, id, { operation: 'delete' }), true);
  await learning.observe(event('new', '猫饼是什么意思？'));
  const stale = learning.prepareResearch('room-a');
  await Promise.all([learning.forget('room-a'), learning.applyModelActions(input, [{ operation: 'reject', candidate_id: id, note: '普通词' }], { researchToken: stale.token })]);
  assert.deepEqual(learning.context('room-a'), []);
  await learning.observe(input);
  assert.deepEqual(learning.context('room-a'), [], 'redelivery after forget is not a new learning event');
  const staleProposal = { operation: 'propose', term: '猫饼', source: input.content, messageId: input.id, speaker: groupMemberSpeaker('room-a', 'alice') };
  assert.deepEqual(await learning.applyModelActions(input, [staleProposal]), { applied: 0 });
  assert.deepEqual(learning.context('room-a'), [], 'late normal-model proposals cannot resurrect forgotten candidates');
});

test('research can reject a common word or retain trusted source provenance, without promoting a guess to confirmation', async t => {
  const { learning } = await fixture(t);
  const input = event('words', '“猫饼”和“龙团”来了'); await learning.observe(input);
  const prepared = learning.prepareResearch('room-a');
  const [cat, dragon] = prepared.context.candidates;
  const result = await learning.applyModelActions(input, [
    { operation: 'research', candidate_id: cat.id, meaning: '网上的一种说法', sources: [{ url: 'https://example.org/observed', title: '实际检索来源', excerpt: '公开词义资料' }] },
    { operation: 'reject', candidate_id: dragon.id, note: '只是临时组合词，尚无稳定用法' }
  ], { researchToken: prepared.token, verifiedSources: ['https://example.org/observed'] });
  assert.equal(result.applied, 2);
  const entries = learning.context('room-a');
  assert.equal(entries.find(item => item.id === cat.id).web_evidence[0].sources[0].verified, true);
  assert.equal(entries.find(item => item.id === cat.id).status, 'pending');
  assert.equal(entries.find(item => item.id === dragon.id).status, 'rejected');
  assert.equal(learning.prepareResearch('room-a'), null);
});

test('bad on-disk JSON does not silently become an empty library', async t => {
  const { learning, dataDir } = await fixture(t);
  await learning.observe(event('term', 'yyds'));
  await writeFile(join(dataDir, 'vocabulary_state.json'), '{broken');
  await assert.rejects(new VocabularyLearning({ dataDir, now: () => now }).init(), SyntaxError);
  assert.equal(await readFile(join(dataDir, 'vocabulary_state.json'), 'utf8'), '{broken');
});

test('candidate, evidence and research payload sizes are bounded while confirmed definitions remain available', async t => {
  const { learning } = await fixture(t);
  await learning.observe(event('definition', '本群猫饼是指趴成一团的猫。'));
  for (let i = 0; i < 105; i++) await learning.observe(event(`word-${i}`, `“龙词${i}”来了`));
  assert.equal(learning.snapshot()[0].candidates.length, 100);
  assert.equal(learning.context('room-a', { query: '猫饼', limit: 1 })[0].status, 'confirmed');
  for (let i = 0; i < 10; i++) await learning.observe(event(`repeat-${i}`, '“龙词104”来了'));
  assert.equal(learning.context('room-a', { query: '龙词104', limit: 1 })[0].observations.length, 6);
  const prepared = learning.prepareResearch('room-a', { limit: 999 });
  assert.equal(prepared.context.candidates.length, 3);
  assert.ok(prepared.context.candidates.every(item => item.observed_examples.length <= 2 && item.observed_examples.every(text => [...text].length <= 80)));
});
