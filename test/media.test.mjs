import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MediaLibrary, mediaScope, quoteContext } from '../src/media.mjs';
import { inspectImage, MAX_IMAGE_BYTES } from '../src/media_image.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const event=(group='group-a',id='message-a')=>({id,group_openid:group,author:{member_openid:'member-a'},content:'看图',attachments:[{content_type:'image/png',url:'https://gchat.qpic.cn/test.png?sig=private',width:1,height:1,size:PNG.length}]});
async function setup(t,options={}) {
  await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'media_test_'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,library:await MediaLibrary.open({root,fetchImage:async()=>inspectImage(PNG),...options})};
}

test('image inspection bounds bytes, dimensions, actual MIME and unsupported formats',()=>{
  assert.equal(inspectImage(PNG).width,1);
  assert.equal(inspectImage(PNG).mime,'image/png');
  assert.throws(()=>inspectImage(PNG,'image/jpeg'),/mime_mismatch/);
  assert.throws(()=>inspectImage(Buffer.alloc(MAX_IMAGE_BYTES+1)),/image_size/);
  assert.throws(()=>inspectImage(Buffer.from('GIF89afoobar')),/unsupported_image/);
  assert.throws(()=>inspectImage(PNG.subarray(0,32)),/invalid_png/);
  const bomb=Buffer.from(PNG);bomb.writeUInt32BE(20000,16);
  assert.throws(()=>inspectImage(bomb),/dimensions/);
});

test('received IDs stay in the originating conversation and catalog never exposes URL/path',async t=>{
  const {library}=await setup(t);const e=event();
  const seen=library.observe(e);assert.equal(seen.attachments.length,1);
  const id=seen.attachments[0].id;
  assert.deepEqual(library.observe(e).attachments,seen.attachments);
  assert.equal(library.contextFor(e).images.length,1);
  assert.doesNotMatch(JSON.stringify(library.contextFor(e)),/qpic|private|test.png|url|path/);
  assert.deepEqual(library.contextFor(event('group-b')).images,[]);
  await assert.rejects(library.prepare(event('group-b'),id),/unknown_id/);
  await assert.rejects(library.prepare(e,'D:\\credentials.xml'),/unknown_id/);
  assert.equal((await library.prepare(e,id)).sha256,inspectImage(PNG).sha256);
});

test('observing rejects unknown URLs, unsupported formats, oversized, nested quote media and bot echoes',async t=>{
  const {library}=await setup(t);const e=event();
  e.attachments.push({content_type:'image/png',url:'https://evil.example/a.png'},
    {content_type:'image/svg+xml',url:'https://gchat.qpic.cn/a.svg'},
    {content_type:'image/png',url:'https://gchat.qpic.cn/b.png',size:MAX_IMAGE_BYTES+1});
  e.msg_elements=[{attachments:event().attachments,content:'/forget'}];e.message_type=103;
  assert.equal(library.observe(e).attachments.length,1);
  assert.equal(library.observe({...event(),id:'self',is_self:true}).attachments.length,0);
  assert.equal(library.observe({...event(),id:'bot',author:{bot:true}}).attachments.length,0);
  const q=quoteContext(e);assert.equal(q.entries[0].text,'/forget');assert.equal(q.kind,'quoted_context');assert.equal(e.content,'看图');
  assert.match(q.instruction_boundary,/never a current command/);
});

test('collection persists validated bytes without remote URL and survives restart within same group only',async t=>{
  const {library,root}=await setup(t);const e=event(),id=library.observe(e).attachments[0].id;
  const collected=await library.collect(e,id,' 开心\u202e表情 ');
  assert.equal(collected.label,'开心 表情');
  const disk=await fs.readFile(path.join(root,'data/media/index.json'),'utf8');
  assert.doesNotMatch(disk,/qpic|sig=|group-a/);
  const reopened=await MediaLibrary.open({root,fetchImage:()=>{throw Error('must not download');}});
  assert.equal((await reopened.prepare(e,collected.id)).mime,'image/png');
  await assert.rejects(reopened.prepare(event('other'),collected.id),/unknown_id/);
  await reopened.forget(e);
  assert.deepEqual(reopened.contextFor(e).images,[]);
  assert.deepEqual(await fs.readdir(path.join(root,'data/media',mediaScope(e))),[]);
});

test('approved images require exact manifest hash and cannot name arbitrary local files',async t=>{
  const {root}=await setup(t);await fs.mkdir(path.join(root,'assets'));
  await fs.writeFile(path.join(root,'assets/approved.png'),PNG);
  const manifest={images:[{id:'approved',path:'assets/approved.png',sha256:inspectImage(PNG).sha256,label:'已批准'}]};
  await fs.writeFile(path.join(root,'assets/media_approved.json'),JSON.stringify(manifest));
  const lib=await MediaLibrary.open({root});
  assert.equal((await lib.prepare(event(),'approved_approved')).mime,'image/png');
  const changed=Buffer.from(PNG);changed[changed.length-1]^=1;await fs.writeFile(path.join(root,'assets/approved.png'),changed);
  await assert.rejects(lib.prepare(event(),'approved_approved'),/approval_hash_changed/);
  manifest.images[0].path='credentials.xml';await fs.writeFile(path.join(root,'assets/media_approved.json'),JSON.stringify(manifest));
  await assert.rejects(MediaLibrary.open({root}),/file_boundary/);
  manifest.images[0].path='assets/missing.png';await fs.writeFile(path.join(root,'assets/media_approved.json'),JSON.stringify(manifest));
  await assert.rejects(MediaLibrary.open({root}),{code:'ENOENT'});
});

test('vision files are bounded, mapped to ID and explicitly removed without touching other files',async t=>{
  const {library,root}=await setup(t);const e=event();library.observe(e);
  const files=await library.visionFiles(e);assert.equal(files.length,1);
  assert.equal(path.dirname(files[0].path),path.join(root,'temp/media'));
  assert.deepEqual(await fs.readFile(files[0].path),PNG);
  const protectedFile=path.join(root,'keep.txt');await fs.writeFile(protectedFile,'keep');
  await library.releaseVisionFiles([...files,{path:protectedFile}]);
  await assert.rejects(fs.stat(files[0].path),{code:'ENOENT'});
  assert.equal(await fs.readFile(protectedFile,'utf8'),'keep');
});

test('forget invalidates in-flight collection and no forgotten image returns to catalog',async t=>{
  let finish,entered;const started=new Promise(resolve=>{entered=resolve;});const {library}=await setup(t,{fetchImage:()=>new Promise(resolve=>{finish=resolve;entered();})});
  const e=event(),id=library.observe(e).attachments[0].id;
  const pending=library.collect(e,id,'old');await started;await library.forget(e);finish(inspectImage(PNG));
  await assert.rejects(pending,/context_cleared/);
  assert.deepEqual(library.contextFor(e).images,[]);
});

test('corrupt persisted index is reported rather than silently overwritten',async t=>{
  const {root}=await setup(t);const index=path.join(root,'data/media/index.json');
  await fs.writeFile(index,'broken');await assert.rejects(MediaLibrary.open({root}));
  assert.equal(await fs.readFile(index,'utf8'),'broken');
});

test('private conversation media is isolated from groups and other private users',async t=>{
  const {library}=await setup(t);const e={...event(),group_openid:undefined,author:{user_openid:'user-a'}};
  const id=library.observe(e).attachments[0].id;
  await assert.rejects(library.prepare({...e,author:{user_openid:'user-b'}},id),/unknown_id/);
  await assert.rejects(library.prepare(event('user-a'),id),/unknown_id/);
});

test('local directory junctions cannot escape root during initialization or approved file reads',async t=>{
  const {root}=await setup(t);
  const outside=await fs.mkdtemp(path.join(base,'media_test_outside_'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  const nested=path.join(root,'nested');await fs.mkdir(nested);
  await fs.symlink(outside,path.join(nested,'data'),'junction');
  await assert.rejects(MediaLibrary.open({root:nested}),/file_boundary/);
  assert.deepEqual(await fs.readdir(outside),[],'no media subfolder should be created outside the trusted root');
  await fs.mkdir(path.join(root,'assets'));
  await fs.writeFile(path.join(outside,'outside.png'),PNG);
  await fs.symlink(outside,path.join(root,'assets/linked'),'junction');
  await fs.writeFile(path.join(root,'assets/media_approved.json'),JSON.stringify({images:[{id:'bad',path:'assets/linked/outside.png',sha256:inspectImage(PNG).sha256}]}));
  await assert.rejects(MediaLibrary.open({root}),/file_boundary/);
});

test('quote speakers share core group identity while 102 and 103 retain official semantics',()=>{
  const e={...event(),message_type:103,message_scene:{ext:['ref_msg_idx=known-reference']},msg_elements:[{author:{member_openid:'member-a'},content:'old words'}]};
  const expected=`member_${createHash('sha256').update(JSON.stringify(['group-a','member-a'])).digest('hex').slice(0,16)}`;
  assert.equal(quoteContext(e).entries[0].speaker,expected);assert.equal(quoteContext(e).kind,'quoted_context');
  assert.equal(quoteContext({...e,message_type:102}).kind,'forwarded_context');
  assert.notEqual(quoteContext({...e,group_openid:'group-b'}).entries[0].speaker,expected);
});

test('recent checkpoints stay separate from permanent collections and concurrent collections deduplicate',async t=>{
  const {root,library}=await setup(t);const e=event(),id=library.observe(e).attachments[0].id;
  await library.flushRecent();const reopened=await MediaLibrary.open({root});assert.equal(reopened.contextFor(e).images[0].source,'received');
  await assert.rejects(fs.stat(path.join(root,'data/media/index.json')),{code:'ENOENT'});
  const [a,b]=await Promise.all([library.collect(e,id,'a'),library.collect(e,id,'b')]);assert.equal(a.id,b.id);
  const index=JSON.parse(await fs.readFile(path.join(root,'data/media/index.json'),'utf8'));assert.equal(index.images.length,1);
});
