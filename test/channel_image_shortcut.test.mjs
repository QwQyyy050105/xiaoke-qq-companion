import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelService} from '../src/channel_service.mjs';
import {ChannelMedia,channelMediaInput} from '../src/channel_media.mjs';
import {inspectImage} from '../src/media_image.mjs';
import {validateShortcutRequest} from '../src/channel_shortcuts.mjs';

const action='feed.quick-publish';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZREAAAAASUVORK5CYII=','base64');
const otherPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const event=(content,id='synthetic')=>({id,content,author:{user_openid:'owner'}});
const waiting=()=>({success:true,data:{status:'waiting',id:'s-image-test',step:'1/3',pending:{type:'pick',options:[{_index:0,guild_id:'123',name:'合成频道'}]}}});
const boards=()=>({success:true,data:{status:'waiting',id:'s-image-test',step:'2/3',pending:{type:'pick',options:[{_index:0,guild_id:'123',channel_id:'456',name:'合成版块'}]}}});
const done=()=>({success:true,data:{status:'done',result:{success:true}}});
const pick=id=>event('/channel-resume '+id+' pick 0');
const confirm=id=>event('/channel-confirm '+id);
const pending=(f,id)=>Object.entries(f.service.state.proposals).find(([,p])=>p.resume?.sourceId===id&&p.status==='pending')?.[0];
const source=(f,id)=>f.service.state.proposals[id];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,{parameters={content:'合成正文','image-ids':['first','second']},responses=[waiting(),boards(),done()]}={}){
  const base=path.resolve('temp'),root=await fs.mkdtemp(path.join(base,'channel_image_shortcut_'));
  await fs.mkdir(path.join(root,'src'));await fs.copyFile('src/channel_commands.json',path.join(root,'src/channel_commands.json'));
  const f={root,calls:[],replies:[],parameters,bytes:new Map([['first',Buffer.from(png)],['second',Buffer.from(otherPng)]]),clock:10_000,owner:'owner',services:[]};
  f.media=new ChannelMedia({root,getCatalog:()=>[...f.bytes.keys()].map((id,i)=>({id,label:['第一张合成图','第二张合成图'][i],source:'collected'})),prepare:async(e,id)=>inspectImage(f.bytes.get(id))});
  f.send=text=>{f.replies.push(text);return {sent_text:text.trim(),delivered_messages:[{content:text.trim(),messageId:'synthetic'}]};};
  f.run=async(args,options)=>{f.calls.push({args,options});const next=responses.shift();if(next instanceof Error)throw next;return typeof next==='function'?next(args,options):structuredClone(next);};
  f.generate=async input=>{f.planInput=input;return {action,parameters_json:JSON.stringify(parameters)};};
  f.restart=async()=>{if(f.service)await f.service.stop();f.service=await new ChannelService({root,getOwner:()=>f.owner,media:f.media,generate:f.generate,run:f.run,now:()=>f.clock}).init();f.services.push(f.service);return f.service;};
  await f.restart();
  t.after(async()=>{for(const s of f.services)await s.stop();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(base));await fs.rm(root,{recursive:true,force:true});});
  f.begin=async()=>{await f.service.process(event('在腾讯频道发布这两张图和合成正文'),f.send);return Object.keys(f.service.state.proposals)[0];};
  f.review=async id=>{await f.service.process(pick(id),f.send);await f.service.process(pick(id),f.send);return pending(f,id);};
  f.files=id=>source(f,id).mediaLease.files.map(file=>path.join(root,source(f,id).mediaLease.directory,file));
  f.released=async id=>{assert.equal(source(f,id).mediaLeaseState,'released');assert.equal(await fs.stat(path.join(root,source(f,id).mediaLease.directory)).catch(e=>e.code),'ENOENT');};
  return f;
}

test('quick image publish retains exact ordered files through channel and board choices, reviews all content, then releases',async t=>{
  const parameters={title:'合成长文','markdown-content':'正文 [(0,1)](@img)\n尾部','image-ids':['second','first'],link:['https://example.invalid/|参考']};
  const f=await fixture(t,{parameters}),id=await f.begin(),files=f.files(id);
  assert.equal(source(f,id).status,'waiting');assert.deepEqual(f.calls[0].args.filter(a=>a.startsWith('--image=')),files.map(p=>'--image='+p));
  assert.equal(f.calls[0].options.timeoutMs,120000);assert.deepEqual(await fs.readFile(files[0]),f.bytes.get('second'));
  assert.ok(f.planInput.channelCommands.find(c=>c.name===action).flags.some(flag=>flag.name==='image-ids'));
  await f.service.process(pick(id),f.send);assert.deepEqual(await fs.readFile(files[1]),f.bytes.get('first'));
  assert.ok(!f.calls[1].args.some(a=>a.startsWith('--image=')||a==='--yes'));
  await f.service.process(pick(id),f.send);const child=pending(f,id);assert.ok(child);
  const review=f.replies.at(-1);for(const fragment of ['合成频道','合成版块','合成长文','正文','尾部','https://example.invalid/','第二张合成图','第一张合成图'])assert.ok(review.includes(fragment));
  assert.ok(review.indexOf('第二张合成图')<review.indexOf('第一张合成图'));assert.ok(!review.includes(f.root));
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,3);assert.ok(f.calls[2].args.includes('--yes'));
  assert.ok(!f.calls[2].args.some(a=>a.startsWith('--image=')||a.startsWith('--content=')));assert.equal(source(f,id).status,'completed');await f.released(id);
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,3);
});

test('short and long image shortcuts use the same inherited type limits and reject unsupported image shortcuts',()=>{
  const ids=Array.from({length:50},(_,i)=>'id'+i);
  assert.equal(channelMediaInput(action,{title:'长文',content:'正文','image-ids':ids}).ids.length,50);
  assert.throws(()=>validateShortcutRequest(action,{content:'正文','image-ids':ids.slice(0,19)}),/too_many/);
  assert.throws(()=>validateShortcutRequest('feed.search-and-comment',{'guild-id':'123',query:'x',content:'x','image-ids':['first']}),/media_unsupported/);
  assert.throws(()=>validateShortcutRequest(action,{content:'x','feed-type':2,'image-ids':['first']}),/missing_title/);
  for(const key of ['resume-id','pick','yes','guild-id','channel-id','content-file','image','video'])assert.throws(()=>validateShortcutRequest(action,{content:'x','image-ids':['first'],[key]:'0'}),/initial_/);
});

test('restart retains only verified waiting files and delivered review without starting or publishing anything',async t=>{
  const f=await fixture(t),id=await f.begin(),child=await f.review(id),files=f.files(id);assert.equal(f.calls.length,2);
  await f.restart();assert.equal(f.calls.length,2);assert.equal(source(f,id).status,'waiting');assert.deepEqual(await fs.readFile(files[0]),f.bytes.get('first'));
  assert.equal(source(f,child).reviewProgress.nextPage,source(f,child).reviewProgress.pageCount);
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,3);await f.released(id);
});

for(const [label,change]of[
  ['original bytes',async(f)=>{f.bytes.set('first',Buffer.from(otherPng));}],
  ['catalog identity',async(f)=>{f.bytes.delete('first');}],
  ['staged bytes',async(f,id)=>{await fs.writeFile(f.files(id)[0],otherPng);}],
  ['missing staged file',async(f,id)=>{await fs.unlink(f.files(id)[0]);}],
  ['body',async(f,id)=>{source(f,id).parameters.content='不同正文';}],
  ['image order',async(f,id)=>{source(f,id).parameters['image-ids'].reverse();}],
  ['media manifest',async(f,id)=>{source(f,id).mediaBinding.assets[0].bytes++;}],
  ['target',async(f,id)=>{source(f,id).result.data.pending.options[0].channel_id='999';}]
])test(label+' change after review cannot consume confirmation or silently restage',async t=>{
  const f=await fixture(t),id=await f.begin(),child=await f.review(id);await change(f,id);
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);assert.equal(source(f,id).status,'canceled');await f.released(id);
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);
});

test('altered source blocks even the non-writing channel selection',async t=>{
  const f=await fixture(t),id=await f.begin();f.bytes.delete('first');await f.service.process(pick(id),f.send);
  assert.equal(f.calls.length,1);assert.equal(source(f,id).status,'canceled');await f.released(id);
});

for(const mode of ['source cancel','review cancel','forget','expiry'])test(mode+' releases only owned staged files and prevents continuation',async t=>{
  const f=await fixture(t),id=await f.begin(),child=mode==='review cancel'?await f.review(id):null;
  if(mode==='forget')await f.service.forget(event('forget'));
  else if(mode==='expiry'){f.clock+=30*60_000+1;await f.service.expireShortcutMedia();}
  else await f.service.process(event('/channel-cancel '+(child||id)),f.send);
  const calls=f.calls.length;assert.equal(source(f,id).status,'canceled');await f.released(id);
  await f.service.process(pick(id),f.send);assert.equal(f.calls.length,calls);
});

for(const stage of ['preparing_media','executing','missing file','unknown receipt','expired'])test('restart rejects '+stage+' without replay and records release',async t=>{
  const f=await fixture(t),id=await f.begin();
  if(['preparing_media','executing'].includes(stage))source(f,id).status=stage;
  else if(stage==='missing file')await fs.unlink(f.files(id)[0]);
  else if(stage==='unknown receipt')source(f,id).result.data.step='unknown';
  else f.clock+=30*60_000+1;
  await f.service.save();await f.restart();assert.equal(f.calls.length,1);assert.ok(['canceled','uncertain'].includes(source(f,id).status));await f.released(id);
});

for(const [label,result]of[
  ['timeout',new Error('synthetic timeout')],
  ['truncated',{...done(),truncated:true}],
  ['wrong session',{success:true,data:{status:'waiting',id:'s-other',step:'2/3',pending:{type:'pick',options:[]}}}],
  ['missing terminal proof',{success:true,data:{status:'done',result:{}}}]
])test('uncertain image write '+label+' releases staging and never replays',async t=>{
  const f=await fixture(t,{responses:[waiting(),boards(),result]}),id=await f.begin(),child=await f.review(id);
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,3);assert.equal(source(f,id).status,'uncertain');await f.released(id);
  await f.restart();await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,3);
});

test('unknown initial image receipt is retained honestly but cannot retain a resumable lease',async t=>{
  const result=waiting();result.data.step='2/3';result.data.pending.options[0].channel_id='456';
  const f=await fixture(t,{responses:[result]}),id=await f.begin();assert.equal(source(f,id).status,'uncertain');assert.deepEqual(source(f,id).result,result);await f.released(id);
});

test('cancellation during slow original verification bypasses queue and prevents the committing call',async t=>{
  const f=await fixture(t),id=await f.begin(),child=await f.review(id),started=deferred(),release=deferred(),original=f.media.prepare;
  f.media.prepare=async(...args)=>{started.resolve();await release.promise;return original(...args);};
  const task=f.service.process(confirm(child),f.send);await started.promise;
  assert.equal(f.service.start(event('/channel-cancel '+id,'cancel-while-fetching'),f.send),true);
  await Promise.allSettled([...f.service.jobs]);release.resolve();await task;
  assert.equal(f.calls.length,2);assert.equal(source(f,id).status,'canceled');await f.released(id);
});

test('forget while initial staging is preparing cannot restore a waiting session',async t=>{
  const f=await fixture(t),started=deferred(),release=deferred(),original=f.media.prepare;
  f.media.prepare=async(...args)=>{started.resolve();await release.promise;return original(...args);};
  const task=f.begin();await started.promise;await f.service.forget(event('forget'));release.resolve();const id=await task;
  assert.equal(f.calls.length,0);assert.equal(source(f,id).status,'canceled');assert.equal(source(f,id).mediaLease,undefined);
});

test('group or other owner cannot review or confirm the private image shortcut',async t=>{
  const f=await fixture(t),id=await f.begin(),child=await f.review(id);
  for(const e of [{...confirm(child),group_openid:'group'}, {...confirm(child),author:{user_openid:'other'}}])await f.service.process(e,f.send);
  assert.equal(f.calls.length,2);assert.equal(source(f,id).status,'waiting');await f.service.forget(event('forget'));await f.released(id);
});

test('a failed release records pending cleanup once and is not retried on restart or another cancellation',async t=>{
  const f=await fixture(t),id=await f.begin();let releases=0;
  const original=f.media.releaseLease.bind(f.media);f.media.releaseLease=async lease=>{releases++;return {cleanupPending:true,cleanup:{directory:lease.directory,files:lease.files}};};
  await f.service.process(event('/channel-cancel '+id),f.send);assert.equal(source(f,id).mediaLeaseState,'cleanup_pending');assert.ok(source(f,id).mediaCleanupPending);
  await f.restart();await f.service.process(event('/channel-cancel '+id),f.send);assert.equal(releases,1);assert.equal(f.calls.length,1);
  // Simulated refusal only: use the original routine to clean our test-owned fixture.
  await original(source(f,id).mediaLease);
});

test('full delivered image review remains required; changed receipt or binding cannot reuse its proof',async t=>{
  const f=await fixture(t,{parameters:{title:'长文',content:'正文'.repeat(1800),'image-ids':['first']}}),id=await f.begin(),child=await f.review(id);
  const p=source(f,child);assert.ok(p.reviewProgress.pageCount>1);await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);
  while(p.reviewProgress.nextPage<p.reviewProgress.pageCount)await f.service.process(event(`/channel-review ${child} ${p.reviewProgress.nextPage+1}`),f.send);
  source(f,id).mediaBinding.assets[0].label='替换后的描述';
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);await f.released(id);
});

for(const [label,change]of[
  ['target',p=>{p.result.data.pending.options[0].channel_id='999';}],
  ['body',p=>{p.parameters.content='changed';}],
  ['media order',p=>{p.mediaBinding.assets.reverse();}]
])test('late '+label+' mutation during the durable execution marker cannot reach CLI',async t=>{
  const f=await fixture(t),id=await f.begin(),child=await f.review(id),save=f.service.save.bind(f.service);let altered=false;
  f.service.save=async()=>{await save();if(!altered&&source(f,child).status==='executing'){altered=true;change(source(f,id));}};
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);assert.equal(source(f,id).status,'canceled');await f.released(id);
});

test('replacing a lease receipt cannot redirect cleanup or vendor resume to a different staged directory',async t=>{
  const f=await fixture(t),id=await f.begin(),child=await f.review(id),original=structuredClone(source(f,id).mediaLease);
  source(f,id).mediaLease.id='00000000-0000-0000-0000-000000000000';source(f,id).mediaLease.directory='temp/channel_shortcut_'+source(f,id).mediaLease.id;
  await f.service.process(confirm(child),f.send);assert.equal(f.calls.length,2);assert.equal(source(f,id).status,'canceled');assert.equal(source(f,id).mediaLeaseState,'cleanup_pending');
  assert.ok(await fs.stat(path.join(f.root,original.directory)));await f.media.releaseLease(original);
});

test('failed image execution-marker persistence prevents submission and releases its prepared files',async t=>{
  const f=await fixture(t),id=await f.begin(),child=await f.review(id),save=f.service.save.bind(f.service);let rejected=false;
  f.service.save=async()=>{if(!rejected&&source(f,child).status==='executing'){rejected=true;throw Error('synthetic persistence failure');}return save();};
  await assert.rejects(f.service.process(confirm(child),f.send),/persistence failure/);assert.equal(f.calls.length,2);assert.equal(source(f,id).status,'canceled');assert.equal(f.service.mediaPreparing.size,0);await f.released(id);
});
