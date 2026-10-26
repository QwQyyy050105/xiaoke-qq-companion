import test from 'node:test';
import assert from 'node:assert/strict';
import { promptMetrics } from '../src/prompt_metrics.mjs';
import { conversationPrompt } from '../src/model_client.mjs';

test('metrics describe the actual group prompt without claiming its private history is duplicated',()=>{
  const prompt=conversationPrompt('synthetic persona',{structured:true,speaker:'synthetic-member',
    text:'synthetic message',history:[{role:'user',content:'hidden personal history'}],
    roomHistory:[{role:'user',content:'shared room message'}],
    mediaCatalog:[{id:'private-image-id',note:'private descriptive text'}]});
  const metrics=promptMetrics(prompt);
  assert.equal(metrics.array_items.recent_messages,0);
  assert.equal(metrics.array_items.room_messages,1);
  assert.equal(metrics.array_items.group_turn,1);
  assert.equal(metrics.array_items.media_catalog,1);
  assert.equal(metrics.context_chars+metrics.instruction_chars,metrics.total_chars);
  assert.doesNotMatch(JSON.stringify(metrics),/private-image|descriptive|synthetic-member|hidden personal|shared room message/);
});

test('only fixed diagnostic field names survive arbitrary context keys and values',()=>{
  const prompt='instructions\n'+JSON.stringify({media_catalog:[{token:'sensitive-marker'}],
    'secret-key-marker':'secret-value-marker',conversation_context:{memberId:'identity-marker'}});
  const metrics=promptMetrics(prompt),encoded=JSON.stringify(metrics);
  assert.deepEqual(Object.keys(metrics.component_chars).sort(),['conversation_context','media_catalog']);
  assert.ok(Object.values(metrics.component_chars).every(Number.isSafeInteger));
  assert.doesNotMatch(encoded,/sensitive|secret|identity|token|memberId/);
});

test('non-JSON specialized instructions keep only their size without guessing context',()=>{
  for(const value of ['only instructions','instructions\nnot JSON','instructions\n["private"]']){
    const metrics=promptMetrics(value);
    assert.equal(metrics.context_json_parsed,false);
    assert.equal(metrics.total_chars,value.length);
    assert.equal(metrics.context_chars,null);
    assert.deepEqual(metrics.component_chars,{});
  }
});
