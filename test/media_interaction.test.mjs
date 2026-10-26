import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaLibrary } from '../src/media.mjs';
import { inspectImage } from '../src/media_image.mjs';
import { prepareImageFrames } from '../src/media_download.mjs';

const PROJECT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),TEMP=path.join(PROJECT,'temp');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const GIF=Buffer.from('R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAgAAAAAAAAAAAAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7','base64');
const WEBP=Buffer.from('UklGRhQBAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMgAAADABAJ0BKgIAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkgAAAAAAAAAAAABAAABAABkAAAAVlA4IDAAAAA0AQCdASoCAAIAAAAmJaAAA3AA/vNpl//5sD/yD/5B9/v//00j/+mkf/00j5TQAABBTk1GRgAAAAAAAAAAAAEAAAEAAGQAAABWUDggLgAAADQBAJ0BKgIAAgAAACYloAADcAD++1Xj//9Lg//6XB//0uD/0uD/+tXlV6yroAA=','base64');
const event=(group='room-a',mime='image/png')=>({id:'actual-message',group_openid:group,author:{member_openid:'member-a'},attachments:[{content_type:mime,url:'https://gchat.qpic.cn/actual_image'}]});
async function setup(t,buffer=PNG) {
  await fs.mkdir(TEMP,{recursive:true});const root=await fs.mkdtemp(path.join(TEMP,'media_interaction_test_'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(TEMP+path.sep));await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'assets'));
  await fs.writeFile(path.join(root,'assets','fixture.png'),PNG);
  await fs.writeFile(path.join(root,'assets','media_approved.json'),JSON.stringify({images:['first','second'].map(id=>({id,path:'assets/fixture.png',sha256:inspectImage(PNG).sha256,label:id,type:'sticker'}))}));
  let now=1000000;
  const options={root,now:()=>now,fetchImage:async()=>({buffer}),decodeImage:(image,options)=>prepareImageFrames(image,{...options,root:PROJECT})};
  return {root,options,library:await MediaLibrary.open(options),advance:ms=>{now+=ms;}};
}

test('sticker notes and usage are scoped, bounded, durable and exact delivery callbacks are idempotent',async t=>{
  const f=await setup(t),e=event();
  await f.library.note(e,'approved_first',{note:'很'.repeat(300),tags:['开心','开心','自信'],usage:'接住朋友的玩笑'});
  await f.library.markUsed(e,'approved_first',{messageId:'delivered-one'});
  await f.library.markUsed(e,'approved_first',{messageId:'delivered-one'});
  await f.library.markUsed(e,'approved_first',{messageId:'delivered-two'});
  let item=f.library.contextFor(e).images.find(item=>item.id==='approved_first');
  assert.equal([...item.local_note].length,200);assert.equal(item.use_count,2);assert.equal(item.recently_used,true);assert.deepEqual(item.tags,['开心','自信']);
  item.tags.push('corrupted');assert.equal(f.library.contextFor(e).images[0].tags.includes('corrupted'),false);
  const other=f.library.contextFor(event('room-b')).images[0];assert.equal(other.local_note,undefined);assert.equal(other.use_count,undefined);
  const reopened=await MediaLibrary.open(f.options);assert.equal(reopened.contextFor(e).images[0].use_count,2);
  const index=await fs.readFile(path.join(f.root,'data/media/index.json'),'utf8');assert.doesNotMatch(index,/room-a|delivered-one|delivered-two/);
  assert.doesNotMatch(await fs.readFile(path.join(f.root,'assets/media_approved.json'),'utf8'),/local_note|use_count|开心/);
});

test('casual reactions prefer fresh alternatives while explicit repeats remain allowed',async t=>{
  const f=await setup(t),e=event(),ids=['approved_first','approved_second'];
  await f.library.markUsed(e,ids[0],{messageId:'sent'});
  assert.deepEqual(f.library.rankForUse(e,ids),[ids[1],ids[0]]);
  assert.deepEqual(f.library.rankForUse(e,ids,{explicitId:ids[0]}),ids);
  f.advance(2*60*60*1000+1);assert.deepEqual(f.library.rankForUse(e,ids),ids);
  assert.deepEqual(f.library.rankForUse(event('room-b'),ids),ids);
});

test('forget clears local notes/stats and invalidates concurrent queued annotation without touching approved assets',async t=>{
  const f=await setup(t),e=event();await f.library.note(e,'approved_first',{note:'old'});
  let release;f.library.writeChain=new Promise(resolve=>{release=resolve;});
  const pending=f.library.markUsed(e,'approved_first',{messageId:'stale'});const forgotten=f.library.forget(e);release();
  await assert.rejects(pending,/context_cleared/);await forgotten;
  const item=f.library.contextFor(e).images[0];assert.equal(item.local_note,undefined);assert.equal(item.use_count,undefined);assert.equal(item.id,'approved_first');
});

test('failed annotation persistence rolls back and another room cannot annotate a collected image',async t=>{
  const f=await setup(t),e=event();const id=f.library.observe(e).attachments[0].id;const item=await f.library.collect(e,id);
  await assert.rejects(f.library.note(event('room-b'),item.id,{note:'wrong room'}),/unknown_id/);
  await fs.unlink(path.join(f.root,'data/media/index.json'));await fs.mkdir(path.join(f.root,'data/media/index.json'));
  await assert.rejects(f.library.markUsed(e,item.id,{messageId:'failed-persistence'}));
  assert.equal(f.library.contextFor(e).images.find(entry=>entry.id===item.id).use_count,undefined);
});

test('uncommitted sticker collection cannot be offered to another concurrent reply',async t=>{
  const f=await setup(t),e=event();let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const library=await MediaLibrary.open({...f.options,writeIndex:async()=>{entered();await gate;throw Error('disk_full');}});
  const received=library.observe(e).attachments[0].id;
  const collecting=library.collect(e,received,'尚未提交',{type:'sticker'});
  await started;
  assert.equal(library.contextFor(e).images.some(item=>item.source==='collected'),false);
  assert.equal((await MediaLibrary.open(f.options)).contextFor(e).images.some(item=>item.source==='collected'),false);
  release();await assert.rejects(collecting,/disk_full/);
  assert.equal(library.collected.size,0);
});

test('sticker meaning and delivery counts become visible only after the durable commit',async t=>{
  const f=await setup(t),e=event();let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const library=await MediaLibrary.open({...f.options,writeIndex:async snapshot=>{
    entered();await gate;await fs.writeFile(path.join(f.root,'data/media/index.json'),JSON.stringify(snapshot));
  }});
  const noting=library.note(e,'approved_first',{note:'一脸得意',usage:'接住解题的梗'});await started;
  assert.equal(library.contextFor(e).images[0].local_note,undefined);
  release();await noting;
  assert.equal(library.contextFor(e).images[0].local_note,'一脸得意');
  assert.equal((await MediaLibrary.open(f.options)).contextFor(e).images[0].local_note,'一脸得意');
});

test('GIF/WebP are opt-in inspected with real frame bounds; generated image import remains PNG/JPEG only',async t=>{
  for(const [buffer,mime]of [[GIF,'image/gif'],[WEBP,'image/webp']]) {
    assert.throws(()=>inspectImage(buffer),/unsupported_image/);
    const image=inspectImage(buffer,mime,{allowExtended:true});assert.equal(image.frameCount,3);assert.equal(image.animated,true);assert.equal(image.width,2);
    assert.throws(()=>inspectImage(buffer,'image/png',{allowExtended:true}),/mime_mismatch/);
    assert.throws(()=>inspectImage(buffer.subarray(0,-2),'',{allowExtended:true}),/invalid_gif|invalid_webp/);
  }
  const oversized=Buffer.from(GIF);oversized.writeUInt16LE(20000,6);assert.throws(()=>inspectImage(oversized,'',{allowExtended:true}),/dimensions/);
  const f=await setup(t);await fs.mkdir(path.join(f.root,'data/generated_images'));const file=path.join(f.root,'data/generated_images/image.gif');await fs.writeFile(file,GIF);
  await assert.rejects(f.library.importGenerated(event(),{path:file,sha256:inspectImage(GIF,'',{allowExtended:true}).sha256}),/unsupported_image/);
});

test('actual optional decoder samples GIF/WebP pixels, marks limitations and retains dimensions',{skip:!process.env.XIAOKE_PYTHON_PATH?'Optional Python/Pillow decoder not configured':false},async t=>{
  const f=await setup(t);
  await assert.rejects(fs.stat(path.join(f.root,'runtime','python_packages')),{code:'ENOENT'});
  await fs.writeFile(path.join(f.root,'PIL.py'),"raise RuntimeError('cwd must not shadow the selected venv')\n");
  const configuredPython=process.env.XIAOKE_PYTHON_PATH;delete process.env.XIAOKE_PYTHON_PATH;
  try{await assert.rejects(prepareImageFrames(inspectImage(GIF,'',{allowExtended:true}),{root:f.root}),/media_decoder_unavailable/);}
  finally{process.env.XIAOKE_PYTHON_PATH=configuredPython;}

  for(const buffer of [GIF,WEBP]) {
    const raw=inspectImage(buffer,'',{allowExtended:true});const frames=await prepareImageFrames(raw,{root:f.root,maxFrames:3});
    assert.equal(frames.length,3);assert.deepEqual(frames.map(frame=>frame.frame_index),[0,1,2]);
    assert.equal(new Set(frames.map(frame=>frame.sha256)).size,3);
    for(const frame of frames){assert.equal(frame.mime,'image/png');assert.equal(frame.width,2);assert.equal(frame.height,2);assert.match(frame.animation_note,/仅查看采样帧/);assert.equal(inspectImage(frame.buffer).sha256,frame.sha256);}
    assert.equal((await prepareImageFrames(raw,{root:f.root,maxFrames:2})).length,2);
  }
});

test('received animation retains original scoped collection, uses bounded real PNG vision and static send fallback',{skip:!process.env.XIAOKE_PYTHON_PATH?'Optional Python/Pillow decoder not configured':false},async t=>{
  const f=await setup(t,GIF),e=event('room-a','image/gif'),id=f.library.observe(e).attachments[0].id;
  const original=await f.library.prepare(e,id,{original:true});assert.equal(original.mime,'image/gif');assert.deepEqual(original.buffer,GIF);
  const sent=await f.library.prepare(e,id);assert.equal(sent.mime,'image/png');assert.equal(sent.frame_count,3);assert.equal(sent.frame_index,0);
  const files=await f.library.visionFiles(e,{ids:[id],maxImages:3});assert.equal(files.length,3);assert.equal(new Set(files.map(item=>item.id)).size,1);
  assert.match(files[0].animation_note,/不能据此声称看过完整动画/);
  await f.library.releaseVisionFiles(files);for(const file of files)await assert.rejects(fs.stat(file.path),{code:'ENOENT'});
  const collected=await f.library.collect(e,id,'三色动图');await assert.rejects(f.library.prepare(event('room-b'),collected.id),/unknown_id/);
  const reopened=await MediaLibrary.open(f.options);assert.deepEqual((await reopened.prepare(e,collected.id,{original:true})).buffer,GIF);
  assert.match(reopened.contextFor(e).images.find(item=>item.id===collected.id).format_note,/采样帧/);
  await reopened.forget(e);assert.equal(reopened.contextFor(e).images.some(item=>item.id===collected.id),false);
});

 test('automatic sticker collection keeps type, meaning and group scope across restart',async t=>{
  const f=await setup(t),e=event();const id=f.library.observe(e).attachments[0].id;
  const saved=await f.library.collect(e,id,'摇头猫',{type:'sticker',tags:['摇头'],title:'不同意'});
  await f.library.note(e,saved.id,{note:'猫猫摇头',usage:'轻松表示不同意',tags:['摇头']});
  const restored=await MediaLibrary.open(f.options);const item=restored.contextFor(e).images.find(x=>x.id===saved.id);
  assert.equal(item.type,'sticker');assert.equal(item.local_note,'猫猫摇头');assert.equal(item.usage_hint,'轻松表示不同意');
  assert.ok(!restored.contextFor(event('another')).images.some(x=>x.id===saved.id));
 });
