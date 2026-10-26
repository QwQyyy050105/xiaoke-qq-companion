import test from 'node:test';import assert from 'node:assert/strict';import {compactMemoryEvidence} from '../src/memory_projection.mjs';
test('memory projection preserves all evidence and speaker ownership without mutating storage',()=>{
 const original={room_memory:[{id:'one',text:'需要延续的约定'.repeat(20),source:'需要延续的约定'.repeat(20),speaker:'alice',status:'active',messageId:'message'},{text:'short',source:'different',speaker:'bob'}],saved_memory:['喜欢猫']};
 const snapshot=structuredClone(original),result=compactMemoryEvidence(original);
 assert.ok(JSON.stringify(result).length<JSON.stringify(original).length);
 const restored=result.room_memory.map(({source_equals_text,...item})=>source_equals_text?{...item,source:item.text}:item);
 assert.deepEqual(restored,original.room_memory);assert.deepEqual(original,snapshot);assert.deepEqual(result.saved_memory,original.saved_memory);
});
