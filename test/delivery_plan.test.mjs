import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryPlan } from '../src/delivery_plan.mjs';

test('image, progress and a long answer stay within the shared five-reply budget', () => {
  const result = deliveryPlan('龙'.repeat(8000), {image:true,used:1});
  assert.equal(result.texts.length,3);
  assert.ok(result.texts.every(text => Array.from(text).length <= 1800));
  assert.match(result.texts.at(-1), /可以让我接着说/);
  assert.equal(1+Number(result.image)+result.texts.length,5);
});

test('complete short bubbles remain separate when possible and merge when needed', () => {
  const messages=['阿白，你那句我接住了。','阿蓝的那个问题也听见啦。','这是最后一句。'];
  assert.deepEqual(deliveryPlan('',{messages,used:1,image:true}).texts,messages);
  assert.deepEqual(deliveryPlan('',{messages,used:3,image:true}).texts,[messages.join('\n\n')]);
});

test('budget exhaustion is rejected before sending and emoji are not cut in half', () => {
  assert.throws(()=>deliveryPlan('还想说',{used:5}),/qq_reply_limit/);
  assert.throws(()=>deliveryPlan('图配一句话',{used:4,image:true}),/qq_reply_limit/);
  const result=deliveryPlan('🐉'.repeat(1801),{used:3});
  assert.equal(Array.from(result.texts[0]).length,1800);
  assert.equal(result.texts[1],'🐉');
});
