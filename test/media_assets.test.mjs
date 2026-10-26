import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaLibrary, mediaScope } from '../src/media.mjs';
import { inspectImage } from '../src/media_image.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const event=(group='room-a')=>({id:'actual-message',group_openid:group,author:{member_openid:'member-a'},content:'做个表情'});
// Add a valid PNG text chunk to distinguish fixture bytes without changing its pixels.
function variant(value) {
  const payload=Buffer.from(`fixture\0${value}`),type=Buffer.from('tEXt'),chunk=Buffer.alloc(payload.length+12);
  chunk.writeUInt32BE(payload.length);type.copy(chunk,4);payload.copy(chunk,8);
  let crc=0xffffffff;for(const byte of Buffer.concat([type,payload])){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return Buffer.concat([PNG.subarray(0,-12),chunk,PNG.subarray(-12)]);
}
async function setup(t) {
  await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'media_assets_test_'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(base+path.sep));await fs.rm(root,{recursive:true,force:true});await assert.rejects(fs.stat(root),{code:'ENOENT'});});
  let now=1_000_000;
  const library=await MediaLibrary.open({root,now:()=>now});
  await fs.mkdir(path.join(root,'assets'));await fs.mkdir(path.join(root,'data/generated_images'),{recursive:true});
  const manifest=async images=>fs.writeFile(path.join(root,'assets/media_approved.json'),JSON.stringify({images}));
  const asset=async(id,bytes=PNG,extra={})=>{const relative=`assets/${id}.png`;await fs.writeFile(path.join(root,relative),bytes);return {id,path:relative,sha256:inspectImage(bytes).sha256,...extra};};
  const generated=async(name='output',bytes=PNG)=>{const file=path.join(root,'data/generated_images',name+'.png');await fs.writeFile(file,bytes);const image=inspectImage(bytes);return {path:file,sha256:image.sha256,mime:image.mime,width:image.width,height:image.height};};
  return {root,library,manifest,asset,generated,advance:ms=>{now+=ms;}};
}

test('approved manifests hot reload additions, replacements and removals with bounded catalog metadata',async t=>{
  const f=await setup(t);
  const avatar=await f.asset('xiao_ke',PNG,{title:' 小柯\u202e头像 ',label:'旧头像',type:'avatar',tags:['龙娘','龙娘',' 可爱 ',42],private_value:'do-not-expose'});
  await f.manifest([avatar]);assert.equal(await f.library.refreshApproved(),true);
  assert.equal(await f.library.refreshApproved(),false);
  let catalog=f.library.contextFor(event()).images;
  assert.deepEqual(catalog[0],{id:'approved_xiao_ke',label:'旧头像',title:'小柯 头像',tags:['龙娘','可爱'],type:'avatar',source:'approved',scope:'approved'});
  catalog[0].tags.push('mutated');assert.equal(f.library.contextFor(event()).images[0].tags.includes('mutated'),false);
  const replacement=await f.asset('xiao_ke',variant('new-avatar'),{title:'新头像',type:'avatar',label:'新形象'});
  const sticker=await f.asset('hello',PNG,{title:'你'.repeat(100),label:'早上好',type:'sticker',tags:Array.from({length:20},(_,i)=>`${i}:`+'长'.repeat(40))});
  await f.manifest([replacement,sticker]);await f.library.refreshApproved();
  assert.equal((await f.library.prepare(event(),'approved_xiao_ke')).sha256,replacement.sha256);
  catalog=f.library.contextFor(event('room-b')).images;
  assert.equal(catalog.length,2);assert.equal([...catalog[1].title].length,80);assert.equal(catalog[1].tags.length,12);assert.equal([...catalog[1].tags[0]].length,24);
  assert.doesNotMatch(JSON.stringify(catalog),/private_value|do-not-expose|sha256|\.png|path/);
  await f.manifest([sticker]);await f.library.refreshApproved();
  await assert.rejects(f.library.prepare(event(),'approved_xiao_ke'),/unknown_id/);
  await fs.unlink(path.join(f.root,'assets/media_approved.json'));await f.library.refreshApproved();
  assert.deepEqual(f.library.contextFor(event()).images,[]);
});

test('sync observation schedules debounced refresh and explicit refresh awaits a complete validated catalog',async t=>{
  const f=await setup(t),first=await f.asset('first');await f.manifest([first]);
  f.advance(1100);f.library.observe(event());assert.ok(f.library.approvedRefresh);
  await f.library.refreshApproved();assert.equal(f.library.contextFor(event()).images.length,1);
  f.library.observe(event());assert.equal(f.library.approvedRefresh,null,'unchanged short-window observations do not start another disk read');
  const second=await f.asset('second',variant('second'));
  await f.manifest([first,{...second,sha256:'0'.repeat(64)}]);
  await assert.rejects(f.library.refreshApproved(),/approval_hash_changed/);
  assert.deepEqual(f.library.contextFor(event()).images.map(item=>item.id),['approved_first'],'invalid manifests do not partially publish');
  await f.manifest([first,second]);await f.library.refreshApproved();
  assert.equal(f.library.contextFor(event()).images.length,2,'a corrected manifest recovers without restart');
});

test('generated images persist a verified scoped copy and metadata while preserving the original worker evidence',async t=>{
  const f=await setup(t),image=await f.generated();
  const item=await f.library.importGenerated(event(),{...image,credential:'never-copy',scope:'approved'},
    {title:' 开心\u202e龙娘 ',label:'欢呼'.repeat(60),tags:['开心','开心',{},'\u202e收到'],type:'sticker'});
  assert.equal(item.source,'collected');assert.equal(item.scope,'conversation');assert.equal(item.type,'sticker');assert.equal(item.title,'开心 龙娘');
  assert.equal([...item.label].length,80);assert.deepEqual(item.tags,['开心','收到']);
  item.tags.push('altered');assert.equal(f.library.contextFor(event()).images[0].tags.includes('altered'),false);
  assert.deepEqual(await fs.readFile(image.path),PNG,'worker output is retained');
  assert.deepEqual(f.library.contextFor(event('room-b')).images,[]);
  await assert.rejects(f.library.prepare(event('room-b'),item.id),/unknown_id/);
  const saved=await fs.readFile(path.join(f.root,'data/media/index.json'),'utf8');
  assert.doesNotMatch(saved,/generated_images|never-copy|credential|room-a/);
  const reopened=await MediaLibrary.open({root:f.root});
  assert.equal(reopened.contextFor(event()).images[0].title,'开心 龙娘');
  assert.equal((await reopened.prepare(event(),item.id)).sha256,image.sha256);
  await fs.writeFile(image.path,variant('source-changed-after-import'));
  assert.equal((await reopened.prepare(event(),item.id)).sha256,image.sha256,'collection owns an immutable copy');
  await reopened.forget(event());assert.deepEqual(reopened.contextFor(event()).images,[]);
  assert.ok(await fs.stat(image.path),'forget does not delete the worker evidence outside the collection');
});

test('generated import rejects outside paths, junction escapes, replacements and mismatched metadata',async t=>{
  const f=await setup(t),image=await f.generated();
  const outside=path.join(f.root,'assets/outside.png');await fs.writeFile(outside,PNG);
  await assert.rejects(f.library.importGenerated(event(),{...image,path:outside}),/file_boundary/);
  await assert.rejects(f.library.importGenerated(event(),{...image,path:'data/generated_images/output.png'}),/generated_result_invalid/);
  const linked=path.join(f.root,'data/generated_images/linked');await fs.symlink(path.join(f.root,'assets'),linked,'junction');
  await assert.rejects(f.library.importGenerated(event(),{...image,path:path.join(linked,'outside.png')}),/file_boundary/);
  await assert.rejects(f.library.importGenerated(event(),{...image,width:999}),/metadata_mismatch/);
  await assert.rejects(f.library.importGenerated(event(),{...image,mime:'image/jpeg'}),/metadata_mismatch/);
  await fs.writeFile(image.path,variant('replacement'));
  await assert.rejects(f.library.importGenerated(event(),image),/generated_hash_changed/);
  assert.deepEqual(f.library.contextFor(event()).images,[]);
});

test('forget invalidates queued generated imports and cannot resurrect their scoped entries',async t=>{
  const f=await setup(t),image=await f.generated();let release;
  f.library.writeChain=new Promise(resolve=>{release=resolve;});
  const importing=f.library.importGenerated(event(),image,{title:'should-not-return'});
  const forgotten=f.library.forget(event());release();
  await assert.rejects(importing,/context_cleared/);await forgotten;
  assert.deepEqual(f.library.contextFor(event()).images,[]);
  const stored=JSON.parse(await fs.readFile(path.join(f.root,'data/media/index.json'),'utf8'));
  assert.deepEqual(stored.images,[]);assert.deepEqual(await fs.readFile(image.path),PNG);
});

test('generated imports share collection capacity, deduplicate per room and isolate identical images across rooms',async t=>{
  const f=await setup(t),image=await f.generated();
  const [a,b]=await Promise.all([f.library.importGenerated(event(),image),f.library.importGenerated(event(),image)]);
  assert.equal(a.id,b.id);assert.equal(f.library.contextFor(event()).images.length,1);assert.equal(a.type,undefined,'generic generated pictures are not automatically classified as stickers');
  const other=await f.library.importGenerated(event('room-b'),image);assert.notEqual(other.id,a.id);
  for(let i=1;i<24;i++)await f.library.importGenerated(event(),await f.generated(`capacity-${i}`,variant(i)));
  assert.equal(f.library.contextFor(event()).images.length,24);
  await assert.rejects(f.library.importGenerated(event(),await f.generated('overflow',variant(24))),/collection_capacity/);
  assert.equal(f.library.contextFor(event('room-b')).images.length,1);
});

test('failed collection persistence rolls back imported copies without deleting the worker original',async t=>{
  const f=await setup(t),image=await f.generated();
  await fs.mkdir(path.join(f.root,'data/media/index.json'));
  await assert.rejects(f.library.importGenerated(event(),image));
  assert.deepEqual(f.library.contextFor(event()).images,[]);
  assert.deepEqual(await fs.readdir(path.join(f.root,'data/media',mediaScope(event()))),[]);
  assert.deepEqual(await fs.readFile(image.path),PNG);
});
