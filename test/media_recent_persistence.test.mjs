import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MediaLibrary, mediaScope } from '../src/media.mjs';
import { inspectImage } from '../src/media_image.mjs';
import { prepareConversationInput } from '../src/conversation_input.mjs';
import { durableWriteFile } from '../src/durable_write.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const attachment=name=>({content_type:'image/png',url:`https://gchat.qpic.cn/${name}.png?synthetic=1`,size:PNG.length});
const event=(id='original',group='group-a')=>({id,group_openid:group,author:{member_openid:'alice'},content:'',message_scene:{ext:[`msg_idx=ref-${id}`]},attachments:[attachment(id)]});
const quote=(id='reply',reference='ref-original',group='group-a')=>({id,group_openid:group,author:{member_openid:'bob'},content:'看看这张',message_type:103,message_scene:{ext:[`ref_msg_idx=${reference}`]}});
async function setup(t,options={}){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'recent_media_test_'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(base+path.sep));await fs.rm(root,{recursive:true,force:true});});
  let now=Date.now(),fetches=0;
  const args={root,now:()=>now,fetchImage:async()=>{fetches++;return inspectImage(PNG);},...options};
  const media=await MediaLibrary.open(args);
  return {root,media,args,advance:ms=>{now+=ms;},fetches:()=>fetches};
}

test('recent actual pixels and exact reference mapping survive restart without becoming permanent stickers',async t=>{
  const f=await setup(t),original=event();
  const first=await prepareConversationInput(f.media,original);assert.equal(first.visionFiles.length,1);await f.media.releaseVisionFiles(first.visionFiles);
  await assert.rejects(fs.stat(path.join(f.root,'data/media/index.json')),{code:'ENOENT'});
  const fresh=await MediaLibrary.open({...f.args,fetchImage:()=>{throw Error('must not redownload');}});
  const input=await prepareConversationInput(fresh,quote(),[{messageId:'original',referenceId:'ref-original',content:'[收到图片或附件]'}]);
  assert.equal(input.visionFiles.length,1);assert.deepEqual(await fs.readFile(input.visionFiles[0].path),PNG);
  assert.equal(input.mediaCatalog.find(x=>x.id===input.visionFiles[0].id).source,'received');assert.deepEqual(input.mediaErrors,[]);
  assert.equal(input.referenceDiagnostics[0].status,'reference_images_loaded');
  assert.doesNotMatch(JSON.stringify(input),/qpic\.cn|synthetic=1/);
  await fresh.releaseVisionFiles(input.visionFiles);
  const crossed=await prepareConversationInput(fresh,quote('cross','ref-original','group-b'));
  assert.equal(crossed.visionFiles.length,0);assert.deepEqual(crossed.mediaErrors,[]);assert.equal(crossed.referenceDiagnostics[0].status,'reference_unknown');
});

test('observed metadata checkpoint can recover an unfetched image from its exact original attachment only',async t=>{
  const f=await setup(t);f.media.observe(event());await f.media.flushRecent();assert.equal(f.fetches(),0);
  const fresh=await MediaLibrary.open(f.args);
  const input=await prepareConversationInput(fresh,quote());assert.equal(input.visionFiles.length,1);assert.equal(f.fetches(),1);
  await fresh.releaseVisionFiles(input.visionFiles);
});

test('text references remain text after restart and unknown references never count as missing pictures',async t=>{
  const f=await setup(t);f.media.observe({...event('plain'),attachments:[],content:'今晚月色很好。'});await f.media.flushRecent();
  const fresh=await MediaLibrary.open(f.args);
  const input=await prepareConversationInput(fresh,quote('text-quote','ref-plain'));
  assert.equal(input.quotes.length,1);assert.equal(input.visionFiles.length,0);assert.deepEqual(input.mediaErrors,[]);
  assert.equal(input.referenceDiagnostics[0].status,'text_only');
  const unknown=await prepareConversationInput(fresh,quote('unknown','not-observed'));
  assert.deepEqual(unknown.mediaErrors,[]);assert.equal(unknown.referenceDiagnostics[0].status,'reference_unknown');assert.equal(f.fetches(),0);
});

test('expired recent images are removed and explained without erasing permanent collection or another scope',async t=>{
  const f=await setup(t),original=event(),id=f.media.observe(original).attachments[0].id;
  const saved=await f.media.collect(original,id,'合成表情',{type:'sticker'});
  const index=JSON.parse(await fs.readFile(path.join(f.root,'data/media/recent_received.json'),'utf8'));
  const pixel=path.join(f.root,'data/media',index.images[0].pixel.path);
  f.advance(3600001);
  const fresh=await MediaLibrary.open(f.args),input=await prepareConversationInput(fresh,quote());
  assert.equal(input.visionFiles.length,0);assert.equal(input.mediaErrors[0].status,'reference_image_expired');
  await assert.rejects(fs.stat(pixel),{code:'ENOENT'});
  assert.deepEqual((await fresh.prepare(original,saved.id)).buffer,PNG);
});

test('forget clears recent mappings and pixels across restart and keeps another room intact',async t=>{
  const f=await setup(t);
  for(const e of [event(),event('other','group-b')]){const input=await prepareConversationInput(f.media,e);await f.media.releaseVisionFiles(input.visionFiles);}
  await f.media.forget(event());
  const fresh=await MediaLibrary.open(f.args),forgotten=await prepareConversationInput(fresh,quote());
  assert.equal(forgotten.visionFiles.length,0);assert.deepEqual(forgotten.mediaErrors,[]);assert.equal(forgotten.referenceDiagnostics[0].status,'reference_unknown');
  assert.deepEqual(await fs.readdir(path.join(f.root,'data/media/recent',mediaScope(event()))),[]);
  const other=await prepareConversationInput(fresh,quote('other-quote','ref-other','group-b'));assert.equal(other.visionFiles.length,1);await fresh.releaseVisionFiles(other.visionFiles);
});

test('forget during a download prevents late pixels or metadata from returning after restart',async t=>{
  let resolveFetch,entered;const started=new Promise(resolve=>{entered=resolve;});
  const f=await setup(t,{fetchImage:()=>new Promise(resolve=>{resolveFetch=resolve;entered();})});
  const original=event(),id=f.media.observe(original).attachments[0].id;
  const pending=f.media.prepare(original,id);await started;await f.media.forget(original);resolveFetch(inspectImage(PNG));
  await assert.rejects(pending,/context_cleared/);
  const fresh=await MediaLibrary.open({...f.args,fetchImage:()=>{throw Error('no network');}}),input=await prepareConversationInput(fresh,quote());
  assert.equal(input.visionFiles.length,0);assert.deepEqual(input.mediaErrors,[]);assert.equal(input.referenceDiagnostics[0].status,'reference_unknown');
});

test('forget while the pixel checkpoint is committing prevents a late successful prepare or cache refill',async t=>{
  let root,entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await setup(t,{writeRecentIndex:async snapshot=>{
    if(snapshot.images.some(item=>item.pixel)){entered();await gate;}
    await durableWriteFile(path.join(root,'data/media/recent_received.json'),JSON.stringify(snapshot));
  }});root=f.root;
  const original=event(),id=f.media.observe(original).attachments[0].id;
  const pending=f.media.prepare(original,id),rejected=assert.rejects(pending,/context_cleared/);
  await started;const forgetting=f.media.forget(original);release();await rejected;await forgetting;
  assert.equal(f.media.cache.size,0);
  const fresh=await MediaLibrary.open({...f.args,writeRecentIndex:undefined}),input=await prepareConversationInput(fresh,quote());
  assert.equal(input.visionFiles.length,0);assert.equal(input.referenceDiagnostics[0].status,'reference_unknown');
  assert.deepEqual(await fs.readdir(path.join(f.root,'data/media/recent',mediaScope(original))),[]);
});

test('a failed pixel checkpoint does not publish a usable disk reference and recovery removes the orphan',async t=>{
  let root;const f=await setup(t,{writeRecentIndex:async snapshot=>{
    if(snapshot.images.some(item=>item.pixel))throw Error('synthetic_disk_full');
    await durableWriteFile(path.join(root,'data/media/recent_received.json'),JSON.stringify(snapshot));
  }});root=f.root;
  const original=event(),id=f.media.observe(original).attachments[0].id;
  await assert.rejects(f.media.prepare(original,id),/synthetic_disk_full/);
  assert.equal(f.media.cache.size,0);
  const disk=JSON.parse(await fs.readFile(path.join(root,'data/media/recent_received.json'),'utf8'));assert.equal(disk.images[0].pixel,undefined);
  const fresh=await MediaLibrary.open({...f.args,writeRecentIndex:undefined});
  assert.deepEqual(await fs.readdir(path.join(f.root,'data/media/recent',mediaScope(original))),[]);
  const input=await prepareConversationInput(fresh,quote());assert.equal(input.visionFiles.length,1);assert.equal(f.fetches(),2);await fresh.releaseVisionFiles(input.visionFiles);
});

test('private recent media stays isolated by author and cannot collide with the same raw group identifier',async t=>{
  const f=await setup(t),privateEvent={...event(),group_openid:undefined,author:{user_openid:'alice'}};
  const first=await prepareConversationInput(f.media,privateEvent);await f.media.releaseVisionFiles(first.visionFiles);
  const fresh=await MediaLibrary.open({...f.args,fetchImage:()=>{throw Error('must not redownload');}});
  const own=await prepareConversationInput(fresh,{...quote(),group_openid:undefined,author:{user_openid:'alice'}});
  assert.equal(own.visionFiles.length,1);await fresh.releaseVisionFiles(own.visionFiles);
  for(const e of [{...quote('other-user'),group_openid:undefined,author:{user_openid:'bob'}},quote('group-collision','ref-original','alice')]){
    const other=await prepareConversationInput(fresh,e);assert.equal(other.visionFiles.length,0);assert.equal(other.referenceDiagnostics[0].status,'reference_unknown');assert.deepEqual(other.mediaErrors,[]);
  }
});

test('changed cached bytes are rejected instead of being shown or silently redownloaded',async t=>{
  const f=await setup(t),input=await prepareConversationInput(f.media,event());await f.media.releaseVisionFiles(input.visionFiles);
  const index=JSON.parse(await fs.readFile(path.join(f.root,'data/media/recent_received.json'),'utf8'));
  const altered=Buffer.from(PNG);altered[altered.length-1]^=1;await fs.writeFile(path.join(f.root,'data/media',index.images[0].pixel.path),altered);
  const fresh=await MediaLibrary.open({...f.args,fetchImage:()=>{throw Error('no network');}}),result=await prepareConversationInput(fresh,quote());
  assert.equal(result.visionFiles.length,0);assert.equal(result.mediaErrors[0].reason,'recent_bytes_changed');
});

test('recent capacity retains a bounded catalog while identifying an evicted known image precisely',async t=>{
  const f=await setup(t);
  for(let i=0;i<61;i++)f.media.observe(event('image-'+i));await f.media.flushRecent();
  const disk=JSON.parse(await fs.readFile(path.join(f.root,'data/media/recent_received.json'),'utf8'));assert.equal(disk.images.length,60);
  const input=await prepareConversationInput(f.media,quote('old-quote','ref-image-0'));assert.equal(input.visionFiles.length,0);assert.equal(input.mediaErrors[0].status,'reference_image_unavailable');assert.equal(f.fetches(),0);
});

test('images omitted by the three-image budget are diagnostics rather than failed downloads',async t=>{
  const f=await setup(t),input=await prepareConversationInput(f.media,{...event(),attachments:[0,1,2,3].map(i=>attachment('batch-'+i))});
  assert.equal(input.visionFiles.length,3);assert.deepEqual(input.mediaErrors,[]);assert.equal(input.referenceDiagnostics.filter(item=>item.status==='vision_budget_skipped').length,1);
  await f.media.releaseVisionFiles(input.visionFiles);
});

test('corrupt or out-of-bound recent metadata fails closed without overwriting the original index',async t=>{
  const f=await setup(t),input=await prepareConversationInput(f.media,event());await f.media.releaseVisionFiles(input.visionFiles);
  const file=path.join(f.root,'data/media/recent_received.json'),index=JSON.parse(await fs.readFile(file,'utf8'));
  index.images[0].pixel.path='../outside.png';const text=JSON.stringify(index);await fs.writeFile(file,text);
  await assert.rejects(MediaLibrary.open(f.args),/invalid_recent_index/);assert.equal(await fs.readFile(file,'utf8'),text);
});
