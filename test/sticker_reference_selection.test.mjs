import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {StickerCreation} from '../src/sticker_creation.mjs';
import {MediaLibrary} from '../src/media.mjs';
import {inspectImage} from '../src/media_image.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const PASS={status:'pass',notes:'Offline fixture only; no actual visual approval claimed.'};
const event=id=>({id,group_openid:'synthetic-group',author:{member_openid:'synthetic-member'},content:'制作一张这题我会的表情包'});
const suggestion={create_prompt:'Synthetic test request',title:'这题我会'};
async function fixture(t){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'sticker_reference_'));
  await fs.mkdir(path.join(root,'assets'));await fs.mkdir(path.join(root,'data/generated_images/synthetic-output'),{recursive:true});
  await fs.writeFile(path.join(root,'assets/current_avatar.png'),PNG);
  // Its existence must not make a historically named file the current default.
  await fs.writeFile(path.join(root,'assets/xiao_ke_qq_avatar.jpg'),'obsolete invalid baseline fixture');
  const inspected=inspectImage(PNG);await fs.writeFile(path.join(root,'assets/media_approved.json'),JSON.stringify({images:[{id:'xiao_ke',path:'assets/current_avatar.png',sha256:inspected.sha256,type:'avatar'}]}));
  const output=path.join(root,'data/generated_images/synthetic-output/image.png');await fs.writeFile(output,PNG);
  const image={...inspected,path:output};delete image.buffer;
  const media=await MediaLibrary.open({root}),services=[];
  t.after(async()=>{for(const service of services)service.stop();assert.ok(path.resolve(root).startsWith(base+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const open=async options=>{const service=await new StickerCreation({root,media,createImage:async()=>image,visualReview:{preflight:async()=>PASS,postflight:async()=>PASS},...options}).init();services.push(service);return service;};
  return{root,media,image,open};
}

test('default baseline follows the current approved avatar and still invokes both visual stages',async t=>{
  const f=await fixture(t),stages=[],referencePaths=[];
  const service=await f.open({visualReview:{preflight:async refs=>{
    stages.push('preflight');assert.equal(refs.length,2);
    for(const ref of refs){referencePaths.push(ref.path);assert.deepEqual(await fs.readFile(ref.path),PNG);}
    assert.equal(refs[0].sha256,inspectImage(PNG).sha256);
    assert.ok(refs.every(ref=>ref.path!==path.join(f.root,'assets/xiao_ke_qq_avatar.jpg')));return PASS;
  },postflight:async()=>{stages.push('postflight');return PASS;}},createImage:async input=>{
    stages.push('generate');assert.equal(input.referenceFiles[0].path,referencePaths[1]);assert.equal(input.sizeReview.status,'pass');return f.image;
  }});
  const e=event('current-default');await service.execute(e,suggestion);await service.waitForIdle(e);
  assert.deepEqual(stages,['preflight','generate','postflight']);assert.equal(service.pendingFor(e).status,'ready');
});

test('even identical current reference inputs cannot bypass a failed actual visual review',async t=>{
  const f=await fixture(t);let reviews=0;
  const service=await f.open({visualReview:{preflight:async refs=>{reviews++;assert.equal(refs.length,2);return{status:'fail',notes:'Synthetic visual mismatch'};},postflight:async()=>assert.fail('No postflight')},createImage:async()=>assert.fail('No generation')});
  const e=event('failed-review');await service.execute(e,suggestion);await service.waitForIdle(e);
  assert.equal(reviews,1);assert.equal(service.pendingFor(e).errorCode,'image_visual_preflight');assert.equal(service.pendingFor(e).status,'failed');
});

test('an approved SHA change while preflight is waiting cancels before generation spends quota',async t=>{
  const f=await fixture(t);let enter,release,changed=false,prepareCalls=0;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const original=f.media.prepare.bind(f.media);
  f.media.prepare=async(...args)=>{const image=await original(...args);prepareCalls++;return changed?{...image,sha256:'a'.repeat(64)}:image;};
  const service=await f.open({visualReview:{preflight:async()=>{enter();await gate;return PASS;},postflight:async()=>assert.fail('No postflight')},createImage:async()=>assert.fail('Changed approval must not spend a generation')});
  const e=event('changed-during-preflight');await service.execute(e,suggestion);await entered;
  changed=true;release();await service.waitForIdle(e);
  assert.equal(prepareCalls,2);assert.equal(service.pendingFor(e).status,'failed');assert.equal(service.pendingFor(e).errorCode,'image_reference_changed');
  assert.equal(f.media.contextFor(e).images.filter(item=>item.type==='sticker').length,0);
});

test('removing approval from the actual manifest during preflight also stops before generation',async t=>{
  const f=await fixture(t);let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const service=await f.open({visualReview:{preflight:async()=>{enter();await gate;return PASS;},postflight:async()=>assert.fail('No postflight')},createImage:async()=>assert.fail('Removed approval must not spend a generation')});
  const e=event('removed-during-preflight');await service.execute(e,suggestion);await entered;
  await fs.writeFile(path.join(f.root,'assets/media_approved.json'),JSON.stringify({images:[]}));release();await service.waitForIdle(e);
  assert.equal(service.pendingFor(e).status,'failed');assert.equal(service.pendingFor(e).errorCode,'image_reference_changed');
});

test('a supplied valid baseline is hashed and passed to the reviewer rather than replaced by current avatar',async t=>{
  const f=await fixture(t),baseline=path.join(f.root,'assets/explicit_baseline.png');await fs.writeFile(baseline,PNG);let reviewed=false;
  const service=await f.open({baselineReference:baseline,visualReview:{preflight:async refs=>{
    reviewed=true;assert.equal(refs[0].path,await fs.realpath(baseline));assert.equal(refs[0].sha256,inspectImage(PNG).sha256);assert.notEqual(refs[0].path,refs[1].path);return PASS;
  },postflight:async()=>PASS}});
  const e=event('explicit-baseline');await service.execute(e,suggestion);await service.waitForIdle(e);
  assert.equal(reviewed,true);assert.equal(service.pendingFor(e).status,'ready');
});

for(const kind of ['missing','directory','invalid-image','relative','null'])test('explicit '+kind+' baseline fails without fallback or image generation',async t=>{
  const f=await fixture(t),references={missing:path.join(f.root,'assets/missing.png'),directory:path.join(f.root,'assets'),'invalid-image':path.join(f.root,'assets/xiao_ke_qq_avatar.jpg'),relative:'assets/current_avatar.png',null:null};
  const service=await f.open({baselineReference:references[kind],visualReview:{preflight:async()=>assert.fail('Invalid reference must not reach reviewer'),postflight:async()=>assert.fail('No postflight')},createImage:async()=>assert.fail('No generation')});
  const e=event('invalid-'+kind);await service.execute(e,suggestion);await service.waitForIdle(e);
  assert.equal(service.pendingFor(e).status,'failed');assert.equal(service.pendingFor(e).errorCode,'image_reference_unavailable');
  assert.equal(f.media.contextFor(e).images.filter(item=>item.type==='sticker').length,0);
});
