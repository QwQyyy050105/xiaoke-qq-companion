import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openChatSettings, explicitlyRequestsMedia } from '../src/chat_settings.mjs';
import { VocabularyResearch } from '../src/vocabulary_research.mjs';
import { VocabularyLearning } from '../src/vocabulary_learning.mjs';
import { conversationPrompt, parseChatResponse, parseSocialResponse, codexArgs } from '../src/model_client.mjs';
import { requestedWebSearch } from '../src/message_format.mjs';
const root = resolve(import.meta.dirname, '..');
async function fixture(t) { const dir = await mkdtemp(join(root, 'temp', 'workflow_controls_')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('four console flags persist atomically and actually suppress web and unsolicited media', async t => {
  const dir = await fixture(t), settings = await openChatSettings({ root: dir });
  assert.equal(settings.get().allowWebSearch, false);
  await settings.update({allowWebSearch:true});assert.equal(settings.get().allowWebSearch,true);
  await Promise.all([settings.update({ allowWebSearch: false }), settings.update({ proactiveEnabled: false })]);
  assert.equal(settings.get().allowWebSearch, false); assert.equal(settings.get().proactiveEnabled, false);
  assert.deepEqual((await openChatSettings({ root: dir })).get(), settings.get());
  await assert.rejects(settings.update({ appSecret: 'cannot-store' }), /invalid_settings/);
  assert.equal(requestedWebSearch({ text: '请查最新', chatSettings: settings.get() }), false);
  assert.equal(requestedWebSearch({ mode: 'owner_work', text: 'search' }), false);
  assert.equal(explicitlyRequestsMedia({ content: '今天开心' }), false);
  assert.equal(explicitlyRequestsMedia({ content: '发个表情' }), true);
  assert.doesNotMatch(await readFile(join(dir, 'data', 'chat_settings.json'), 'utf8'), /appSecret/);
});

test('idle research passes public terms only and preserves unverified web evidence rather than confirming group meaning', async t => {
  const dir = await fixture(t); let now = 1000000;
  const learning = await new VocabularyLearning({ dataDir: join(dir, 'data'), now: () => now }).init();
  const event = { group_openid: 'private-group-identity', id: 'observed-id', author: { member_openid: 'person-id' }, content: '猫饼是什么意思？' };
  await learning.observe(event);
  let calls = 0, received;
  const research = new VocabularyResearch({ learning, now: () => now, generate: async input => {
    calls++; received = input; return { actions: [{ operation: 'research', candidate_id: input.candidates[0].id,
      meaning: '网络中一种猫的姿态', sources: [{ url: 'https://example.org/term', title: '词语资料', excerpt: '猫的姿态' }] }] };
  } });
  research.observe(event); assert.equal(await research.tick(), false); now += 30001;
  assert.equal(await research.tick(), true); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(received), /private-group|observed-id|person-id|是什么意思/);
  const entry = learning.context(event.group_openid)[0];
  assert.equal(entry.status, 'pending'); assert.equal(entry.meaning, '');
  assert.equal(entry.web_evidence[0].sources[0].verified, false);
  research.observe(event); now += 30001; assert.equal(await research.tick(), false);
});

test('forget cancels an in-flight research result and disabling web starts no job', async t => {
  const dir = await fixture(t); let now = 1000000, resolveModel;
  const learning = await new VocabularyLearning({ dataDir: join(dir, 'data'), now: () => now }).init();
  const event = { group_openid: 'room', id: 'input', author: { member_openid: 'a' }, content: 'yyds' };
  await learning.observe(event);
  let enabled = false, calls = 0;
  const research = new VocabularyResearch({ learning, now: () => now, enabled: () => enabled,
    generate: () => { calls++; return new Promise(resolve => { resolveModel = resolve; }); } });
  research.observe(event); now += 40000; assert.equal(await research.tick(), false);
  enabled = true; research.observe(event); now += 40000;
  const pending = research.tick(); await Promise.resolve(); assert.equal(calls, 1);
  research.forget('room'); await learning.forget('room'); resolveModel({ actions: [] });
  assert.equal(await pending, false); assert.deepEqual(learning.context('room'), []);
});

test('specialized model modes use fixed schemas without shell or private transcript contamination', () => {
  const input = { mode: 'vocabulary_research', candidates: [{ id: 'vocab_1', term: '猫饼', observed_examples: ['private-text'] }], history: [{ content: 'PRIVATE' }] };
  const prompt = conversationPrompt('PRIVATE_PERSONA', input);
  assert.match(prompt, /猫饼/); assert.doesNotMatch(prompt, /PRIVATE|private-text/);
  const owner = conversationPrompt('PRIVATE_PERSONA', { mode: 'owner_work', task: '写文稿', answer: '', files: [] });
  assert.match(owner, /主人显式审批/); assert.doesNotMatch(owner, /PRIVATE_PERSONA/);
  const args = codexArgs(root, { structured: true, ownerWork: true });
  assert.ok(args.some(v => v.endsWith('owner_work.schema.json'))); assert.ok(args.includes('shell_tool'));
  const social = parseSocialResponse(JSON.stringify({ reply: '', social: { action: 'say' }, media: { send_id: 'actual-sticker ', voice_id: '' } }));
  assert.equal(social.media.send_id, 'actual-sticker');
  const chat = parseChatResponse(JSON.stringify({ reply: '了解', memories: [], vocabulary_actions: [{ operation: 'propose', term: '猫饼' }] }));
  assert.equal(chat.vocabulary_actions[0].term, '猫饼');
});
