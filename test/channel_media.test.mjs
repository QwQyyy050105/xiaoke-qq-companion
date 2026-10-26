import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelMedia,channelMediaInput} from '../src/channel_media.mjs';
import {inspectImage} from '../src/media_image.mjs';

const event={id:'synthetic',author:{user_openid:'owner'}};
const action='feed.publish-feed';
const parameters={'guild-id':'123','channel-id':'456',content:'合成图片发布请求','image-ids':['sample']};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZREAAAAASUVORK5CYII=','base64');
const image=()=>inspectImage(Buffer.from(png));
async function fixture(t,options={}){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_media_test_'));
  const media=new ChannelMedia({root,getCatalog:()=>[{id:'sample',label:'合成测试图片',source:'collected'}],prepare:async()=>image(),...options});
  t.after(async()=>{assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  return {root,media};
}
test('reviewed image bytes reach the fixed CLI argument and staging is removed after receipt',async t=>{
  const {root,media}=await fixture(t),binding=await media.bind(event,action,parameters);
  let called=0;
  const result=await media.withFiles(event,action,parameters,binding,async(args,options)=>{
    called++;assert.equal(args.length,1);assert.ok(args[0].startsWith('--image='));
    const file=args[0].slice(8);assert.ok(path.relative(root,file).startsWith('temp'+path.sep));
    assert.deepEqual(await fs.readFile(file),png);assert.equal(options.timeoutMs,120000);
    return {success:true,data:{receipt:'actual-runner-result'}};
  });
  assert.equal(called,1);assert.equal(result.result.data.receipt,'actual-runner-result');assert.equal(result.cleanupPending,false);
  assert.deepEqual(await fs.readdir(path.join(root,'temp')),[]);
  assert.ok(!JSON.stringify(binding).includes(root));
});
test('comment and reply use the one-image flag and reject deletion mixed with upload',async t=>{
  const {media}=await fixture(t);
  for(const action of ['feed.do-comment','feed.do-reply']){
    const p={'feed-id':'post','image-ids':['sample']},binding=await media.bind(event,action,p);
    await media.withFiles(event,action,p,binding,async args=>{assert.equal(args.length,1);assert.match(args[0],/^--image-path=/);return {success:true};});
    assert.throws(()=>channelMediaInput(action,{...p,[action==='feed.do-comment'?'comment-type':'reply-type']:0}),/requires_publication/);
  }
});
test('unknown, cross-scope and path-shaped asset identifiers cannot become local file reads',async t=>{
  const {media}=await fixture(t);
  await assert.rejects(media.bind({...event,group_openid:'group'},action,parameters),/owner_only/);
  await assert.rejects(media.bind(event,action,{...parameters,'image-ids':['other']}),/unknown_id/);
  for(const id of ['D:/private.png','../secret','https://site/img','one\u0000two'])assert.throws(()=>channelMediaInput(action,{...parameters,'image-ids':[id]}),/invalid_ids/);
  assert.throws(()=>channelMediaInput('manage.upload-guild-avatar',parameters),/action_unsupported/);
});
test('short and long publication limits follow actual mode; edit inherits the observed target type',()=>{
  const ids=Array.from({length:50},(_,i)=>'pic_'+i);
  assert.equal(channelMediaInput(action,{...parameters,title:'长文','image-ids':ids}).ids.length,50);
  assert.throws(()=>channelMediaInput(action,{...parameters,'image-ids':ids.slice(0,19)}),/too_many/);
  const edit={'feed-id':'post','guild-id':'123','channel-id':'456','image-ids':ids};
  const trace=[{action:'feed.get-feed-detail',result:{success:true,data:{feed:{feed_id:'post',guild_id:'123',channel_id:'456',feed_type:2}}}}];
  assert.equal(channelMediaInput('feed.alter-feed',edit,trace).ids.length,50);
  assert.throws(()=>channelMediaInput('feed.alter-feed',edit),/target_type_unverified/);
  assert.throws(()=>channelMediaInput('feed.alter-feed',{...edit,'channel-id':'other'},trace),/target_type_unverified/);
  assert.throws(()=>channelMediaInput('feed.alter-feed',{...edit,'feed-type':2},trace),/inherited_feed_type/);
});
test('changed content, target, owner or reviewed image bytes cancel before runner',async t=>{
  let changed=false;
  const {media}=await fixture(t,{prepare:async()=>{const p=image();if(changed)p.sha256='0'.repeat(64);return p;}});
  const binding=await media.bind(event,action,parameters);let calls=0;const run=async()=>{calls++;return {success:true};};
  for(const p of [{...parameters,content:'different'},{...parameters,'channel-id':'999'}])await assert.rejects(media.withFiles(event,action,p,binding,run),/binding_changed/);
  await assert.rejects(media.withFiles({author:{user_openid:'other'}},action,parameters,binding,run),/binding_changed/);
  changed=true;await assert.rejects(media.withFiles(event,action,parameters,binding,run),/source_changed/);assert.equal(calls,0);
});
test('forget while fetching an asset prevents staging and publication',async t=>{
  let valid=true,fetches=0;
  const {root,media}=await fixture(t,{prepare:async()=>{fetches++;if(fetches===2)valid=false;return image();}});
  const binding=await media.bind(event,action,parameters);let calls=0;
  await assert.rejects(media.withFiles(event,action,parameters,binding,async()=>{calls++;},()=>valid),/canceled/);
  assert.equal(calls,0);assert.deepEqual(await fs.readdir(root),[]);
});
test('unknown delivery failure is not replayed and still removes this invocation staging',async t=>{
  const {root,media}=await fixture(t),binding=await media.bind(event,action,parameters);let calls=0;
  await assert.rejects(media.withFiles(event,action,parameters,binding,async()=>{calls++;throw Error('channel_timeout');}),/channel_timeout/);
  assert.equal(calls,1);assert.deepEqual(await fs.readdir(path.join(root,'temp')),[]);
});
test('altered stored media manifest cannot borrow the same reviewed ID',async t=>{
  const {media}=await fixture(t),binding=await media.bind(event,action,parameters);binding.assets[0].bytes++;
  let calls=0;await assert.rejects(media.withFiles(event,action,parameters,binding,async()=>{calls++;}),/source_changed/);assert.equal(calls,0);
});
