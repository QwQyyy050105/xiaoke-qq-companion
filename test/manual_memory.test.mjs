import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { MemoryCapture } from '../src/memory_capture.mjs';
import { hash } from '../src/core.mjs';

const scope=`member_${hash('manual-member')}`, speaker=`member_${hash('manual-member').slice(0,16)}`, room=hash('manual-room');
const otherScope=`member_${hash('other-manual-member')}`,otherSpeaker=`member_${hash('other-manual-member').slice(0,16)}`;
const emptyResult=()=>({personal:[],personal_updates:[],room:[]});
const update=(target,message,operation='update')=>({operation,kind:target.kind,targetId:target.id,targetSource:target.source,
  text:message.content,source:message.content,speaker:message.speaker,messageId:message.messageId});
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
  const root=resolve(process.cwd(),'temp'),dir=await mkdtemp(join(root,'manual_memory_'));let now=1000,extract=async()=>emptyResult();const opened=[];
  const open=async()=>{const capture=await MemoryCapture.open({dataDir:dir,now:()=>now,extract:input=>extract(input)});opened.push(capture);return capture;};
  const capture=await open();
  t.after(async()=>{await Promise.all(opened.map(value=>value.close()));assert.ok(resolve(dir).startsWith(root+sep));await rm(dir,{recursive:true,force:true});await assert.rejects(access(dir),{code:'ENOENT'});});
  const input=(id,content,extra={})=>{now+=1000;return {scope,speaker,messageId:id,content,at:new Date(now).toISOString(),...extra};};
  return {capture,open,dir,input,extract:fn=>{extract=fn;},remember:(id,body,extra={})=>capture.rememberManual(input(id,`/remember ${body}`,extra)),
    observe:(id,content,extra={})=>capture.observe({...input(id,content,extra),room:extra.scope==='private_owner'?'private_owner':room}),
    import:(notes,extra={})=>capture.importLegacy({scope,notes,ownerSpeaker:speaker,sourceFingerprint:hash(JSON.stringify(notes)),...extra})};
}

test('manual command stores exact provenance and canonical recall survives restart',async t=>{
  const f=await fixture(t),result=await f.remember('manual','我喜欢泰拉瑞亚。');assert.equal(result.status,'saved');
  const row=f.capture.recall(scope)[0];assert.match(row.id,/^note_[a-f0-9]{24}$/);assert.equal(row.kind,'note');assert.equal(row.origin,'manual_command');
  assert.equal(row.speaker,speaker);assert.equal(row.messageId,'manual');assert.equal(row.at,new Date(2000).toISOString());assert.equal(row.originalCommand,undefined);
  assert.equal(f.capture.state.notes[scope][0].originalCommand,'/remember 我喜欢泰拉瑞亚。');
  assert.deepEqual((await f.open()).recall(scope),f.capture.recall(scope));
});

test('outer whitespace is accepted without rewriting the actual command evidence',async t=>{
  const f=await fixture(t),content='  /remember   比赛备忘。  \n';const saved=await f.capture.rememberManual(f.input('space',content));
  assert.equal(saved.text,'比赛备忘。');assert.equal(f.capture.state.notes[scope][0].originalCommand,content);
  const edit=`  /memory-edit ${saved.id} 新备忘。  \n`;
  assert.equal((await f.capture.amendNote({...f.input('edit-space',edit),operation:'update',targetId:saved.id,targetText:'比赛备忘。',replacementText:'新备忘。'})).status,'updated');
  assert.equal(f.capture.state.notes[scope][0].originalCommand,edit);
});

test('same text in a new manual message refreshes evidence while replaying its ID is idempotent',async t=>{
  const f=await fixture(t),first=await f.remember('first','我喜欢泰拉瑞亚。');
  await f.remember('newer','我喜欢泰拉瑞亚。');const current=f.capture.recall(scope)[0];assert.notEqual(current.id,first.id);
  assert.equal(current.messageId,'newer');assert.equal(current.observedOrder,2);assert.equal(f.capture.state.notes[scope].length,1);
  assert.equal((await f.remember('newer','我喜欢泰拉瑞亚。')).status,'duplicate');assert.equal(f.capture.recall(scope)[0].observedOrder,2);
  assert.deepEqual(await f.remember('newer','被替换的另一段内容。'),{status:'invalid',id:'',text:''});
  assert.equal(f.capture.recall(scope)[0].text,'我喜欢泰拉瑞亚。');
});

test('manual own fact is semantically corrected without leaving a second old manual note',async t=>{
  const f=await fixture(t);await f.remember('old','我喜欢打羽毛球。');await f.remember('generic','比赛备忘：周五检查附件。');
  await f.observe('change','我不喜欢打羽毛球了，最近改玩网球。');
  f.extract(async input=>({personal:[],room:[],personal_updates:[update(input.existingPersonalTargets.find(row=>row.origin==='manual_command'),input.messages[0])]}));
  assert.equal(await f.capture.drain({force:true}),true);
  const rows=f.capture.recall(scope);assert.ok(!rows.some(row=>row.text==='我喜欢打羽毛球。'));assert.ok(rows.some(row=>row.text==='比赛备忘：周五检查附件。'));
  const fact=rows.find(row=>row.text==='我不喜欢打羽毛球了，最近改玩网球。');assert.equal(fact.origin,'observed_statement');
  assert.equal(f.capture.state.facts[scope][0].replaces[0].origin,'manual_command');assert.equal(f.capture.state.facts[scope][0].replaces[0].originalCommand,'/remember 我喜欢打羽毛球。');
  assert.deepEqual((await f.open()).recall(scope),rows);
});

test('direct same-key fact correction retires eligible manual note atomically',async t=>{
  const f=await fixture(t);await f.remember('old','我喜欢咖啡。');await f.observe('change','我现在不喜欢咖啡了。');
  assert.deepEqual(f.capture.recall(scope).map(row=>row.text),['我现在不喜欢咖啡了。']);assert.equal(f.capture.state.notes[scope].length,0);
});

test('legacy strings remain useful labeled notes with no invented authored source or timestamp',async t=>{
  const f=await fixture(t),notes=['我喜欢泰拉瑞亚。','比赛备忘：周五检查附件。'];
  assert.deepEqual(await f.import(notes),{status:'imported',imported:2,canonical:true});assert.equal((await f.import(notes)).status,'already_imported');
  const rows=(await f.open()).recall(scope);assert.equal(rows.length,2);
  for(const row of rows){assert.equal(row.origin,'legacy_unverified');assert.equal(row.kind,'note');assert.equal(row.at,null);assert.equal(row.savedAt,null);
    assert.equal(row.speaker,null);assert.equal(row.messageId,null);assert.equal(row.ownerSpeaker,speaker);assert.ok(row.importedAt);assert.equal(row.observedOrder,undefined);}
});

test('current owner can correct an eligible legacy note while generic legacy notes stay untouched',async t=>{
  const f=await fixture(t);await f.import(['我喜欢泰拉瑞亚。','比赛备忘：周五检查附件。']);
  await f.observe('change','我已经退坑泰拉瑞亚了。');
  f.extract(async input=>{assert.equal(input.existingPersonalTargets.length,1);const target=input.existingPersonalTargets[0];
    assert.equal(target.origin,'legacy_unverified');assert.equal(target.speaker,null);return {personal:[],room:[],personal_updates:[update(target,input.messages[0])]};});
  await f.capture.drain({force:true});const rows=f.capture.recall(scope);assert.deepEqual(new Set(rows.map(row=>row.text)),new Set(['我已经退坑泰拉瑞亚了。','比赛备忘：周五检查附件。']));
  assert.equal(rows.find(row=>row.text==='我已经退坑泰拉瑞亚了。').messageId,'change');
  assert.equal(rows.find(row=>row.text.startsWith('比赛')).origin,'legacy_unverified');
});

test('retired legacy text cannot reappear through a changed import fingerprint',async t=>{
  const f=await fixture(t),old='我喜欢泰拉瑞亚。';await f.import([old]);await f.observe('change','我已经退坑泰拉瑞亚了。');
  f.extract(async input=>({personal:[],room:[],personal_updates:[update(input.existingPersonalTargets[0],input.messages[0])]}));await f.capture.drain({force:true});
  await f.import([old,'另一条旧笔记']);const rows=f.capture.recall(scope);assert.ok(!rows.some(row=>row.text===old));assert.ok(rows.some(row=>row.text==='另一条旧笔记'));
  const retired=f.capture.state.noteRetirements[scope];assert.equal(retired.length,1);assert.match(retired[0],/^note_[a-f0-9]{24}$/);
  assert.ok(!JSON.stringify(retired).includes(old));
});

test('legacy duplicate cannot conceal stronger actual manual provenance',async t=>{
  const f=await fixture(t);await f.remember('actual','比赛备忘。');await f.import(['比赛备忘。']);
  const rows=f.capture.recall(scope);assert.equal(rows.length,1);assert.equal(rows[0].origin,'manual_command');assert.equal(rows[0].messageId,'actual');
  const management=f.capture.recall(scope,{deduplicate:false,limit:256,maxChars:256000});assert.equal(management.length,2);assert.equal(new Set(management.map(row=>row.id)).size,2);
  const legacy=management.find(row=>row.origin==='legacy_unverified');
  assert.equal((await f.capture.amendNote({...f.input('remove-one',`/memory-delete ${legacy.id}`),operation:'delete',targetId:legacy.id,targetText:legacy.text})).status,'deleted');
  assert.equal(f.capture.recall(scope)[0].messageId,'actual');assert.equal(f.capture.recall(scope,{deduplicate:false}).length,1);
});

test('editing one exact note ID to another existing text does not silently delete the other note',async t=>{
  const f=await fixture(t),one=await f.remember('one','第一条备忘。'),two=await f.remember('two','第二条备忘。');
  const request=f.input('edit',`/memory-edit ${one.id} 第二条备忘。`);
  await f.capture.amendNote({...request,targetId:one.id,targetText:one.text,operation:'update',replacementText:two.text});
  const rows=f.capture.recall(scope,{deduplicate:false});assert.equal(rows.length,2);assert.ok(rows.some(row=>row.id===two.id));assert.ok(rows.some(row=>row.id===one.id));
});

test('an explicit ID command may store hypothetical wording as a generic note without treating it as a current fact',async t=>{
  const f=await fixture(t),saved=await f.remember('old','待办备忘。'),replacement='如果下雨，就带伞。';
  const input=f.input('edit',`/memory-edit ${saved.id} ${replacement}`);
  assert.equal((await f.capture.amendNote({...input,targetId:saved.id,targetText:saved.text,operation:'update',replacementText:replacement})).status,'updated');
  assert.equal(f.capture.recall(scope)[0].text,replacement);assert.equal(f.capture.recall(scope)[0].kind,'note');assert.equal(f.capture.state.facts[scope]?.length||0,0);
});

test('exact natural note frames treat hypothetical and reported wording inside quotes as data',async t=>{
  const f=await fixture(t),original='如果下雨，就带伞。',replacement='比如下雨带伞，他说这很实用。';const saved=await f.remember('old',original);
  const editContent=`请把保存的「${original}」改成「${replacement}」！`;
  assert.equal((await f.capture.amendNote({...f.input('natural-edit',editContent),operation:'update',targetId:saved.id,targetText:original,replacementText:replacement})).status,'updated');
  assert.equal(f.capture.recall(scope)[0].text,replacement);assert.equal(f.capture.state.notes[scope][0].originalCommand,editContent);
  const removeContent=`忘掉保存的“${replacement}”`;
  assert.equal((await f.capture.amendNote({...f.input('natural-delete',removeContent),operation:'delete',targetId:saved.id,targetText:replacement})).status,'deleted');
  assert.deepEqual((await f.open()).recall(scope),[]);
});

test('a hypothetical note can be deleted directly by its exact natural command',async t=>{
  const f=await fixture(t),text='如果下雨，就带伞。',saved=await f.remember('old',text);
  assert.equal((await f.capture.amendNote({...f.input('remove',`忘掉保存的「${text}」`),operation:'delete',targetId:saved.id,targetText:text})).status,'deleted');
  assert.deepEqual(f.capture.recall(scope),[]);
});

test('reporting, quoting or hypothesizing the entire natural command does not execute it',async t=>{
  const f=await fixture(t),text='如果下雨，就带伞。',saved=await f.remember('old',text),request=`忘掉保存的「${text}」`;
  for(const [i,content] of [`他说${request}`,`如果要${request}`,`“${request}”`,`不要${request}`,`${request}吗？`].entries()) {
    assert.equal((await f.capture.amendNote({...f.input(`not-request-${i}`,content),operation:'delete',targetId:saved.id,targetText:text})).status,'invalid');
  }
  assert.deepEqual(f.capture.recall(scope).map(row=>row.text),[text]);
});

test('unrelated extra preference cannot silently retire a legacy note with unproven origin',async t=>{
  const f=await fixture(t);await f.import(['我喜欢泰拉瑞亚。']);await f.observe('additional','我喜欢打网球。');
  assert.equal(f.capture.recall(scope).length,2);assert.ok(f.capture.recall(scope).some(row=>row.origin==='legacy_unverified'));
});

test('pending messages older than the import boundary cannot rewrite unknown-age legacy notes',async t=>{
  const f=await fixture(t);await f.observe('old-pending','我已经退坑泰拉瑞亚了。');await f.import(['我喜欢泰拉瑞亚。']);
  f.extract(async input=>({personal:[],room:[],personal_updates:[update(input.existingPersonalTargets[0],input.messages[0])]}));
  await f.capture.drain({force:true});assert.equal(f.capture.recall(scope)[0].origin,'legacy_unverified');
  assert.equal(f.capture.status().rejectionReasons.personal_update_source_older_than_target,1);
});

test('a newer same-text manual reassertion rejects an older queued semantic correction',async t=>{
  const f=await fixture(t);await f.remember('first','我喜欢泰拉瑞亚。');await f.observe('pending','我已经退坑泰拉瑞亚了。');
  await f.remember('newer','我喜欢泰拉瑞亚。');f.extract(async input=>({personal:[],room:[],personal_updates:[update(input.existingPersonalTargets[0],input.messages[0])]}));
  await f.capture.drain({force:true});assert.equal(f.capture.recall(scope)[0].messageId,'newer');assert.equal(f.capture.status().rejectionReasons.personal_update_source_older_than_target,1);
});

for(const natural of [false,true])test(`generic note exact-target edit/delete works (${natural?'quoted request':'ID command'})`,async t=>{
  const f=await fixture(t),old='比赛备忘：周五检查附件。',replacement='比赛备忘：周六检查附件。';const result=await f.remember('old',old);
  const edit=f.input('edit',natural?`把保存的「${old}」改成「${replacement}」`:`/memory-edit ${result.id} ${replacement}`);
  assert.equal((await f.capture.amendNote({...edit,targetId:result.id,targetText:old,replacementText:replacement,operation:'update'})).status,'updated');
  assert.equal(f.capture.recall(scope)[0].text,replacement);assert.equal(f.capture.state.notes[scope][0].originalCommand,edit.content);
  const remove=f.input('delete',natural?`忘掉保存的「${replacement}」`:`/memory-delete ${result.id}`);
  assert.equal((await f.capture.amendNote({...remove,targetId:result.id,targetText:replacement,operation:'delete'})).status,'deleted');
  assert.deepEqual((await f.open()).recall(scope),[]);const raw=await readFile(join(f.dir,'memory_capture.json'),'utf8');assert.ok(!raw.includes(old));assert.ok(!raw.includes(replacement));
});

test('explicit note command also manages a fact whose original manual note was already corrected',async t=>{
  const f=await fixture(t);await f.remember('old','我喜欢泰拉瑞亚。');await f.observe('change','我已经退坑泰拉瑞亚了。');
  f.extract(async input=>({personal:[],room:[],personal_updates:[update(input.existingPersonalTargets[0],input.messages[0])]}));await f.capture.drain({force:true});
  const fact=f.capture.recall(scope)[0];const edit=f.input('edit',`/memory-edit ${fact.id} 游戏笔记已重新整理。`);
  assert.equal((await f.capture.amendNote({...edit,operation:'update',targetId:fact.id,targetText:fact.text,replacementText:'游戏笔记已重新整理。'})).status,'updated');
  assert.equal(f.capture.state.facts[scope].length,0);assert.equal(f.capture.recall(scope)[0].origin,'manual_edit');
});

test('wrong owner, absent exact target, fabricated replacement and stale target text cannot amend notes',async t=>{
  const f=await fixture(t),saved=await f.remember('old','比赛备忘。');
  await assert.rejects(f.capture.amendNote({...f.input('wrong',`/memory-delete ${saved.id}`),speaker:otherSpeaker,targetId:saved.id,targetText:'比赛备忘。',operation:'delete'}),/source_invalid/);
  for(const [content,targetText,replacementText,status] of [
    ['把保存的「其他内容」改成「新内容」','比赛备忘。','新内容','invalid'],
    [`/memory-edit ${saved.id} 真正的新内容`,'比赛备忘。','伪造的新内容','invalid'],
    [`/memory-delete ${saved.id}`,'旧文本不匹配',undefined,'stale'],
    ['他说把保存的「比赛备忘。」改成「新内容」','比赛备忘。','新内容','invalid']]) {
    const input=f.input(`try-${content}`,content);assert.equal((await f.capture.amendNote({...input,targetId:saved.id,targetText,replacementText,operation:replacementText?'update':'delete'})).status,status);
  }
  assert.deepEqual(f.capture.recall(scope).map(row=>row.text),['比赛备忘。']);
});

test('manual notes remain separate from automatic fact retention and scope boundaries',async t=>{
  const f=await fixture(t);await f.remember('manual','比赛备忘。');await f.remember('other','其他成员的笔记。',{scope:otherScope,speaker:otherSpeaker});
  await f.remember('private','私聊笔记。',{scope:'private_owner',speaker:'owner'});
  for(let i=0;i<70;i++)await f.observe(`fact-${i}`,`我喜欢作品第${i}部。`);
  assert.equal(f.capture.state.facts[scope].length,64);assert.ok(f.capture.recall(scope,{limit:256,maxChars:256000}).some(row=>row.text==='比赛备忘。'));
  assert.deepEqual(f.capture.recall(otherScope).map(row=>row.text),['其他成员的笔记。']);assert.deepEqual(f.capture.recall('private_owner').map(row=>row.text),['私聊笔记。']);
});

test('manual notes have their own thirty-item limit and legacy imports preserve the full bounded snapshot',async t=>{
  const f=await fixture(t);await f.import(Array.from({length:40},(_,i)=>`旧笔记${i}`));for(let i=0;i<32;i++)await f.remember(`manual-${i}`,`新笔记${i}`);
  const rows=f.capture.recall(scope,{limit:256,maxChars:256000});assert.equal(rows.filter(row=>row.origin==='manual_command').length,30);
  assert.equal(rows.filter(row=>row.origin==='legacy_unverified').length,40);assert.equal(f.capture.status().personalNotes.total,70);
});

for(const original of ['fact','legacy'])test(`background query keeps an older relevant ${original} target despite more than sixty-four eligible notes`,async t=>{
  const f=await fixture(t),old='我喜欢泰拉瑞亚。';
  if(original==='fact')await f.observe('old',old);
  await f.import([...(original==='legacy'?[old]:[]),...Array.from({length:90},(_,i)=>`我喜欢作品第${i}部。`)]);
  await f.observe('change','我已经退坑泰拉瑞亚了。');
  f.extract(async input=>{assert.equal(input.existingPersonalTargets.length,64);const target=input.existingPersonalTargets.find(row=>row.text===old);assert.ok(target);
    assert.equal(target.origin,original==='fact'?'observed_statement':'legacy_unverified');
    return {personal:[],room:[],personal_updates:[update(target,input.messages[0])]};});
  await f.capture.drain({force:true});const rows=f.capture.recall(scope,{limit:256,maxChars:256000,deduplicate:false});
  assert.ok(!rows.some(row=>row.text===old));assert.ok(rows.some(row=>row.text==='我已经退坑泰拉瑞亚了。'));assert.equal(rows.filter(row=>row.origin==='legacy_unverified').length,90);
});

test('failed manual save and import publish neither notes nor receipt and can retry',async t=>{
  const f=await fixture(t),save=f.capture.save;f.capture.save=async()=>{throw new Error('test_save_failure');};
  await assert.rejects(f.remember('manual','比赛备忘。'),/test_save_failure/);assert.deepEqual(f.capture.recall(scope),[]);
  await assert.rejects(f.import(['旧笔记']),/test_save_failure/);assert.equal(f.capture.state.legacyImports[scope],undefined);
  f.capture.save=save;assert.equal((await f.remember('manual','比赛备忘。')).status,'saved');assert.equal((await f.import(['旧笔记'])).imported,1);
});

test('forget erases canonical notes and leaves only content-free import closure across restart',async t=>{
  const f=await fixture(t),legacy=['旧笔记内容'];await f.import(legacy);await f.remember('manual','新笔记内容');await f.capture.forget(scope,room);
  const restored=await f.open();assert.deepEqual(restored.recall(scope),[]);assert.deepEqual(restored.state.legacyImports[scope],{fingerprints:[],closed:true});
  assert.equal((await restored.importLegacy({scope,notes:legacy,ownerSpeaker:speaker,sourceFingerprint:hash(JSON.stringify(legacy))})).status,'blocked_after_forget');
  const raw=await readFile(join(f.dir,'memory_capture.json'),'utf8');assert.ok(!raw.includes('旧笔记内容'));assert.ok(!raw.includes('新笔记内容'));
  assert.equal((await f.remember('fresh','遗忘之后的新笔记')).status,'saved');
});

test('manual/import jobs queued behind forget cannot restore a pre-forget snapshot',async t=>{
  const f=await fixture(t);await f.remember('first','比赛备忘。');const forgetting=f.capture.forget(scope,room);
  const saving=f.remember('queued','排队旧笔记'),importing=f.import(['排队旧导入']);
  await forgetting;await assert.rejects(saving,/epoch_changed/);assert.equal((await importing).status,'blocked_after_forget');assert.deepEqual(f.capture.recall(scope),[]);
});

test('forget while semantic extraction of an imported note is pending cannot revive it',async t=>{
  const f=await fixture(t),entered=defer(),release=defer();await f.import(['我喜欢泰拉瑞亚。']);await f.observe('change','我已经退坑泰拉瑞亚了。');
  f.extract(async input=>{entered.resolve();await release.promise;return {personal:[],room:[],personal_updates:[update(input.existingPersonalTargets[0],input.messages[0])]};});
  const draining=f.capture.drain({force:true});await entered.promise;await f.capture.forget(scope,room);release.resolve();await draining;
  assert.deepEqual((await f.open()).recall(scope),[]);
});
