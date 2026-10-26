import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService} from '../src/channel_service.mjs';
import {ChannelMedia} from '../src/channel_media.mjs';
import {inspectImage} from '../src/media_image.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZREAAAAASUVORK5CYII=','base64');
const event=(content,id='synthetic-event',owner='owner')=>({id,content,author:{user_openid:owner}});
const receipt=text=>({sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic-message'}]});
const confirm=id=>event('/channel-confirm '+id,'confirm-'+id);
const cancel=id=>event('/channel-cancel '+id,'cancel-'+id);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

async function entries(directory){try{return await fs.readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}}

async function fixture(t,{run,parameters}={}){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_media_integration_'));
  await fs.mkdir(path.join(root,'src'));
  await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  parameters??={'guild-id':'123','channel-id':'456',content:'合成图片正文','image-ids':['sample']};
  let owner='owner',prepareHook=async()=>{};
  const calls=[],replies=[],inputs=[],releases=[];
  const media=new ChannelMedia({root,getCatalog:()=>[{id:'sample',label:'合成图片',source:'collected'}],prepare:async(...args)=>{
    await prepareHook(...args);return inspectImage(Buffer.from(png));
  }});
  const generate=async input=>{inputs.push(input);return {action:'feed.publish-feed',parameters_json:JSON.stringify(parameters),reply:'准备草稿'};};
  const runner=async(args,options)=>{calls.push({args,options});return run?run(args,options):{success:true,data:{feed_id:'synthetic-post-receipt'}};};
  const service=await new ChannelService({root,getOwner:()=>owner,generate,run:runner,media}).init();
  const send=text=>{replies.push(text);return receipt(text);};
  t.after(async()=>{
    for(const release of releases)release();
    await service.stop();
    const actualRoot=await fs.realpath(root),actualBase=await fs.realpath(base);
    assert.equal(path.dirname(actualRoot),actualBase);
    assert.ok(path.basename(actualRoot).startsWith('channel_media_integration_'));
    await fs.rm(actualRoot,{recursive:true,force:true});
  });
  const f={root,service,media,parameters,calls,replies,inputs,send,runner,generate,
    changeOwner:()=>{owner='different-owner';},
    gatePrepare:()=>{const entered=deferred(),gate=deferred();releases.push(gate.resolve);prepareHook=async()=>{entered.resolve();await gate.promise;};return {ready:entered.promise,release:gate.resolve};},
    gateSave:status=>{
      const entered=deferred(),gate=deferred(),original=service.save.bind(service);let once=false;
      releases.push(gate.resolve);
      service.save=async()=>{if(!once&&Object.values(service.state.proposals).some(p=>p.status===status)){once=true;entered.resolve();await gate.promise;}return original();};
      return {ready:entered.promise,release:gate.resolve,restore:()=>{service.save=original;}};
    }};
  return f;
}

async function begin(f){
  await f.service.process(event('在腾讯频道123版块456发布这张图片'),f.send);
  const id=Object.keys(f.service.state.proposals)[0];assert.ok(id,'expected an owner-reviewed image proposal');
  const p=f.service.state.proposals[id];assert.ok(p.mediaBinding);
  while(p.reviewProgress.nextPage<p.reviewProgress.pageCount)await f.service.process(event(`/channel-review ${id} ${p.reviewProgress.nextPage+1}`),f.send);
  assert.equal(p.status,'pending');assert.equal(f.calls.length,0);return {id,p};
}

test('reviewed scoped image bytes reach runner once and staging is cleaned after success',async t=>{
  let stagedFile;
  const f=await fixture(t,{run:async(args,options)=>{
    const images=args.filter(arg=>arg.startsWith('--image='));assert.equal(images.length,1);
    assert.ok(!args.some(arg=>arg.includes('image-ids')));assert.ok(args.includes('--yes'));
    stagedFile=images[0].slice('--image='.length);
    assert.equal(path.dirname(path.dirname(stagedFile)),path.join(f.root,'temp'));
    assert.deepEqual(await fs.readFile(stagedFile),png);assert.equal(options.timeoutMs,120000);
    return {success:true,data:{feed_id:'synthetic-post-receipt'}};
  }});
  const {id,p}=await begin(f);
  assert.ok(f.inputs[0].channelCommands.find(c=>c.name==='feed.publish-feed').flags.some(flag=>flag.name==='image-ids'));
  assert.deepEqual(f.inputs[0].channelMediaCatalog,[{id:'sample',label:'合成图片',source:'collected'}]);
  assert.match(p.atomicReview.text,new RegExp(p.mediaBinding.assets[0].sha256));
  assert.ok(!p.atomicReview.text.includes(f.root));
  await f.service.process(confirm(id),f.send);
  assert.equal(f.calls.length,1);assert.equal(p.status,'completed');assert.equal(p.result.data.feed_id,'synthetic-post-receipt');
  await assert.rejects(fs.stat(stagedFile),{code:'ENOENT'});assert.deepEqual(await entries(path.join(f.root,'temp')),[]);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);
});

test('start cancellation bypasses the busy scope queue during media preparation',async t=>{
  const f=await fixture(t),{id,p}=await begin(f),gate=f.gatePrepare();
  assert.equal(f.service.start(confirm(id),f.send),true);await gate.ready;
  assert.equal(p.status,'preparing_media');assert.equal(f.service.start(cancel(id),f.send),true);
  assert.equal(p.status,'canceled');gate.release();await f.service.stop();
  assert.equal(f.calls.length,0);assert.deepEqual(await entries(path.join(f.root,'temp')),[]);
  assert.ok(f.replies.some(text=>text.includes('没有提交到频道')));
  assert.equal(f.replies.filter(text=>text.includes('没有提交到频道')).length,1);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
});

for(const status of ['preparing_media','executing'])test(`owner cancellation during ${status} persistence prevents the runner`,async t=>{
  const f=await fixture(t),{id,p}=await begin(f),gate=f.gateSave(status);
  assert.equal(f.service.start(confirm(id),f.send),true);await gate.ready;
  assert.equal(p.status,status);assert.equal(f.service.start(cancel(id),f.send),true);assert.equal(p.status,'canceled');
  gate.release();await f.service.stop();gate.restore();
  assert.equal(f.calls.length,0);assert.equal(p.status,'canceled');assert.deepEqual(await entries(path.join(f.root,'temp')),[]);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
});

for(const [name,change]of[
  ['owner',async f=>f.changeOwner()],
  ['forget epoch',async f=>f.service.forget(event('/forget'))],
  ['review text',async(f,p)=>{p.atomicReview.text+='未确认的变化';}],
  ['media binding',async(f,p)=>{p.mediaBinding.assets[0].sha256='0'.repeat(64);}],
  ['content parameters',async(f,p)=>{p.parameters.content='未审阅的新正文';}],
  ['target parameters',async(f,p)=>{p.parameters['channel-id']='999';}]
])test(`${name} change during image preparation invalidates the complete guard before publication`,async t=>{
  const f=await fixture(t),{id,p}=await begin(f),gate=f.gatePrepare();
  const work=f.service.process(confirm(id),f.send);await gate.ready;await change(f,p);gate.release();await work;
  assert.equal(f.calls.length,0);assert.equal(p.status,'canceled');assert.deepEqual(await entries(path.join(f.root,'temp')),[]);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,0);
});

test('foreign private sender and group cancel cannot withdraw the owner media proposal',async t=>{
  const f=await fixture(t),{id,p}=await begin(f),gate=f.gatePrepare();
  assert.equal(f.service.start(confirm(id),f.send),true);await gate.ready;
  f.service.start({...cancel(id),id:'foreign-cancel',author:{user_openid:'different-owner'}},f.send);
  f.service.start({...cancel(id),id:'group-cancel',group_openid:'synthetic-group'},f.send);
  assert.equal(p.status,'preparing_media');gate.release();await f.service.stop();
  assert.equal(f.calls.length,1);assert.equal(p.status,'completed');
});

for(const [name,result]of[
  ['null',null],['missing success',{}],['non-object','unknown'],['non-boolean success',{success:'true'}],
  ['truncated body',{success:true,truncated:true}],['projected incomplete receipt',{success:true,_projection:{truncated:true,paginationAllowed:false}}]
])test(`${name} result is persisted uncertain, cleaned and never replayed`,async t=>{
  const f=await fixture(t,{run:async()=>result}),{id,p}=await begin(f);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);assert.equal(p.status,'uncertain');
  assert.deepEqual(p.result,result);assert.deepEqual(await entries(path.join(f.root,'temp')),[]);
  assert.ok(!f.replies.some(text=>text==='频道操作已成功执行。'));
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',generate:f.generate,run:f.runner,media:f.media}).init();
  assert.equal(restored.state.proposals[id].status,'uncertain');
  await restored.process(confirm(id),f.send);await restored.stop();assert.equal(f.calls.length,1);
});

test('runner timeout is not downgraded to unsubmitted and cannot be replayed',async t=>{
  const f=await fixture(t,{run:async()=>{throw Error('synthetic_unknown_delivery');}}),{id,p}=await begin(f);
  await f.service.process(confirm(id),f.send);
  assert.equal(f.calls.length,1);assert.equal(p.status,'uncertain');assert.deepEqual(await entries(path.join(f.root,'temp')),[]);
  await f.service.process(confirm(id),f.send);assert.equal(f.calls.length,1);
});

test('cancellation after runner admission preserves the successful actual receipt',async t=>{
  const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
  const f=await fixture(t,{run:async()=>{entered.resolve();await gate.promise;return {success:true,data:{feed_id:'synthetic-post-receipt'}};}}),{id,p}=await begin(f);
  f.service.start(confirm(id),f.send);await entered.promise;
  f.service.start(cancel(id),f.send);assert.equal(p.status,'executing');gate.resolve();await f.service.stop();
  assert.equal(f.calls.length,1);assert.equal(p.status,'completed');assert.equal(p.result.data.feed_id,'synthetic-post-receipt');
  assert.ok(!f.replies.some(text=>text==='这次图片发布已取消，没有提交到频道。'));
});

test('media preparation state after restart is canceled without creating a publication job',async t=>{
  const f=await fixture(t),{id,p}=await begin(f);p.status='preparing_media';await f.service.save();
  const restored=await new ChannelService({root:f.root,getOwner:()=> 'owner',generate:f.generate,run:f.runner,media:f.media}).init();
  assert.equal(restored.state.proposals[id].status,'canceled');await restored.process(confirm(id),f.send);await restored.stop();
  assert.equal(f.calls.length,0);assert.deepEqual(await entries(path.join(f.root,'temp')),[]);
});
