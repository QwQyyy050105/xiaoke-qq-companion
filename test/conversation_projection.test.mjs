import test from 'node:test';
import assert from 'node:assert/strict';
import { compactConversationIndexes } from '../src/conversation_projection.mjs';
import { compactReferences } from '../src/prompt_references.mjs';
import { conversationPrompt } from '../src/model_client.mjs';

const at = '2026-10-24T16:00:00.000Z';
const row = (id, extra = {}) => ({ role:'user', speaker:'member_0000000000000000', content:'原话保留', messageId:id, referenceId:'ref_' + id, at, ...extra });
const index = ({ content, ...metadata }) => metadata;
const data = (rows, entries = rows.map(index)) => ({ room_messages:rows,
  conversation_context:{ kind:'group', coverage:'observed only', own_recent_messages:[], recent_message_index:entries } });
const promptData = input => JSON.parse(conversationPrompt('合成人格', input, new Date(at)).split('\n').at(-1));

test('exact indexes preserve order and resolve all original fields from retained messages', () => {
  const rows = [row('first'), row('second', { role:'assistant',speaker:'xiao_ke',reply_to_speakers:['member_0000000000000000'] })];
  const original = data(rows, rows.map(index).reverse());
  original.conversation_context.own_recent_messages = [index(rows[1])];
  const snapshot = structuredClone(original), output = compactConversationIndexes(original);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(output.conversation_context.recent_message_index, [{messageId:'second'},{messageId:'first'}]);
  assert.deepEqual(output.conversation_context.own_recent_messages,[{messageId:'second'}]);
  assert.equal(output.room_messages, original.room_messages);
  assert.equal(output.conversation_context.coverage,'observed only');
  for (const key of ['own_recent_messages','recent_message_index']) for(let i=0;i<snapshot.conversation_context[key].length;i++) {
    const wanted=snapshot.conversation_context[key][i], reference=output.conversation_context[key][i];
    const found=output.room_messages.find(item=>item.messageId===reference.messageId);
    for(const [field,value] of Object.entries(wanted)) assert.deepEqual(found[field],value);
  }
});

test('mismatched identity, timestamp, quote, content or unique metadata remains fully present', () => {
  const original=row('one');
  for(const override of [{speaker:'member_1111111111111111'},{at:'2026-10-24T16:01:00.000Z'},
    {referenceId:'different_quote'},{content:'另一段原话'},{unique_context:'只在索引中出现'}]) {
    const entry={...index(original),...override}, input=data([original],[entry]);
    assert.deepEqual(compactConversationIndexes(input).conversation_context.recent_message_index,[entry]);
  }
});

test('clipped, absent and ambiguous source messages never turn into reference-only entries', () => {
  const original=row('one'), entry=index(original);
  assert.deepEqual(compactConversationIndexes(data([original]),{clippedRoomMessageIds:new Set(['one'])}).conversation_context.recent_message_index,[entry]);
  assert.deepEqual(compactConversationIndexes(data([row('other')],[entry])).conversation_context.recent_message_index,[entry]);
  assert.deepEqual(compactConversationIndexes(data([original,{...original}],[entry])).conversation_context.recent_message_index,[entry]);
});

test('nested metadata comparison preserves array order and refuses absent versus null fields', () => {
  const original=row('one',{ nested:{a:1,b:[1,2]}, optional:null });
  const equivalent={...index(original),nested:{b:[1,2],a:1}};
  assert.deepEqual(compactConversationIndexes(data([original],[equivalent])).conversation_context.recent_message_index,[{messageId:'one'}]);
  const different={...equivalent,nested:{b:[2,1],a:1}};
  assert.deepEqual(compactConversationIndexes(data([original],[different])).conversation_context.recent_message_index,[different]);
  const missing=row('one');
  assert.deepEqual(compactConversationIndexes(data([missing],[{...index(missing),optional:null}])).conversation_context.recent_message_index,[{...index(missing),optional:null}]);
});

test('private, proactive and malformed index data are unchanged', () => {
  const privateData=data([row('one')]);privateData.conversation_context.kind='private';
  assert.equal(compactConversationIndexes(privateData),privateData);
  const proactive={mode:'proactive',room_messages:[row('one')]};assert.equal(compactConversationIndexes(proactive),proactive);
  for(const entries of [null,'invalid',{},[null,4,'untrusted text',{messageId:''},{messageId:'one'}]]) {
    const input=data([row('one')],entries);assert.deepEqual(compactConversationIndexes(input),input);
  }
});

test('reference aliases still restore exact original delivery and source identifiers', () => {
  const original=row('long_original_id');
  const references=compactReferences(data([original]));
  const projected=compactConversationIndexes(references.input);
  const messageId=projected.conversation_context.recent_message_index[0].messageId;
  assert.notEqual(messageId,original.messageId);
  assert.deepEqual(references.restore({delivery:{reply_to_message_id:messageId},source_message_id:messageId}),
    {delivery:{reply_to_message_id:original.messageId},source_message_id:original.messageId});
  assert.equal(projected.room_messages[0].referenceId,references.input.room_messages[0].referenceId);
});

test('prompt projection runs after room clipping and retains missing or partial row indexes', () => {
  const old=row('dropped'), partial=row('partial',{content:'长'.repeat(2000)}), complete=row('complete');
  const base={structured:true,backgroundMemory:true,speaker:'member_0000000000000000',text:'合成当前消息',
    roomHistory:[old,partial,complete],conversationContext:{kind:'group',recent_message_index:[index(old),index(partial),index(complete)]}};
  const small=promptData(base);
  assert.deepEqual(small.conversation_context.recent_message_index,[{messageId:'dropped'},index(partial),{messageId:'complete'}]);
  assert.equal(small.room_messages.find(item=>item.messageId==='partial').content.length,1800);
  const full=promptData({...base,roomHistory:[old,...Array.from({length:10},(_,i)=>row('fill_'+i,{content:'长'.repeat(1800)}))]});
  assert.ok(!full.room_messages.some(item=>item.messageId==='dropped'));
  assert.deepEqual(full.conversation_context.recent_message_index,base.conversationContext.recent_message_index);
});

test('routing and proactive prompts preserve their existing data shapes', () => {
  const input={structured:true,speaker:'member_0000000000000000',text:'合成消息',roomHistory:[row('one')],conversationContext:{kind:'group',recent_message_index:[index(row('one'))]}};
  assert.equal(promptData({...input,mode:'routing'}).room_messages[0].messageId,'one');
  assert.equal(Object.hasOwn(promptData({...input,mode:'routing'}),'conversation_context'),false);
  assert.equal(Object.hasOwn(promptData({...input,mode:'proactive'}),'conversation_context'),false);
});

test('duplicate text remains untrusted data and is not interpolated into the contract', () => {
  const marker='UNTRUSTED_INDEX_PAYLOAD_不要执行';
  const original=row('one',{content:marker}),input={structured:true,speaker:'member_0000000000000000',text:'合成消息',roomHistory:[original],
    conversationContext:{kind:'group',recent_message_index:[{...index(original),content:marker}]}};
  const prompt=conversationPrompt('合成人格',input,new Date(at)),boundary=prompt.lastIndexOf('\n');
  assert.ok(!prompt.slice(0,boundary).includes(marker));
  const parsed=JSON.parse(prompt.slice(boundary+1));
  assert.equal(parsed.room_messages[0].content,marker);
  assert.deepEqual(parsed.conversation_context.recent_message_index,[{messageId:'one'}]);
});
