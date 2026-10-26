import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recordUsage} from '../src/model_client.mjs';

async function fixture(t){
 const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'usage_recovery_'));
 await fs.mkdir(path.join(root,'data'));
 t.after(async()=>{assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
 return root;
}
test('a zero-filled usage file is preserved byte-for-byte before new records resume with an explicit gap',async t=>{
 const root=await fixture(t),file=path.join(root,'data/model_usage.json'),invalid=Buffer.alloc(2048);
 await fs.writeFile(file,invalid);
 const records=Array.from({length:5},(_,i)=>({at:new Date().toISOString(),mode:'reply',elapsed_ms:i+1,prompt_chars:12}));
 await Promise.all(records.map(record=>recordUsage(root,record)));
 const state=JSON.parse(await fs.readFile(file,'utf8'));
 assert.deepEqual(state.recent,records);assert.equal(state.history_gap.reason,'invalid_usage_record');
 assert.deepEqual(await fs.readFile(path.join(root,state.history_gap.evidence)),invalid);
 assert.ok(state.history_gap.evidence.includes(createHash('sha256').update(invalid).digest('hex')));
 const files=await fs.readdir(path.join(root,'data'));assert.ok(files.every(name=>!name.endsWith('.tmp')));
});
test('existing valid usage and a prior history gap survive serialized later records without loading a model',async t=>{
 const root=await fixture(t),file=path.join(root,'data/model_usage.json');
 const old={at:new Date().toISOString(),mode:'reply',elapsed_ms:5};
 await fs.writeFile(file,JSON.stringify({recent:[old],history_gap:{reason:'old_gap'}}));
 await recordUsage(root,{...old,elapsed_ms:6});
 const state=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(state.recent.length,2);assert.equal(state.history_gap.reason,'old_gap');
 assert.equal(await fs.stat(path.join(root,'data/evidence')).then(()=>true,()=>false),false);
});
