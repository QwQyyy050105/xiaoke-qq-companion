import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Companion, hash } from '../src/core.mjs';
import { MediaLibrary } from '../src/media.mjs';
import { inspectImage } from '../src/media_image.mjs';
import { prepareConversationInput } from '../src/conversation_input.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const temp=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const attachment=name=>({content_type:'image/png',url:`https://gchat.qpic.cn/${name}.png`,size:PNG.length});
const original=(id='original',group='group-a',count=1)=>({id,group_openid:group,author:{member_openid:'alice'},content:'',message_scene:{ext:[`msg_idx=ref-${id}`]},attachments:Array.from({length:count},(_,index)=>attachment(`${id}-${index}`))});
const reply=(id='reply',reference='ref-original',group='group-a')=>({id,group_openid:group,author:{member_openid:'bob'},content:'',explicit_mention:true,message_type:103,message_scene:{ext:[`msg_idx=ref-${id}`,`ref_msg_idx=${reference}`]}});
async function setup(t) {
  await fs.mkdir(temp,{recursive:true});const root=await fs.mkdtemp(path.join(temp,'media_references_'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const fetched=[];const fetchImage=async url=>{fetched.push(url);return inspectImage(PNG);};
  return {root,fetched,fetchImage,media:await MediaLibrary.open({root,fetchImage})};
}

test('A sends a question image and B quotes it with only @ or empty addressed text: real image reaches generator',async t=>{
  for(const content of ['', '<@bot>']) {
    const {root,media,fetched}=await setup(t);
    const image=original();media.observe(image);
    let generated=0;const sent=[];
    const companion=await new Companion({dataDir:path.join(root,'data'),pairingHash:'',
      prepareInput:event=>prepareConversationInput(media,event),releaseInput:input=>media.releaseVisionFiles(input.visionFiles||[]),
      generate:async input=>{
        generated++;assert.equal(input.visionFiles.length,1);assert.deepEqual(await fs.readFile(input.visionFiles[0].path),PNG);
        assert.deepEqual([input.visionFiles[0].width,input.visionFiles[0].height],[1,1]);
        const entry=input.mediaCatalog.find(item=>item.id===input.visionFiles[0].id);
        assert.equal(entry.message_id,'original');assert.equal(entry.reference_id,'ref-original');
        assert.equal(entry.speaker,`member_${hash(JSON.stringify(['group-a','alice'])).slice(0,16)}`);
        assert.deepEqual(input.quotes[0].image_ids,[entry.id]);
        return {reply:'这次能看到原题图。',memories:[]};
      }}).init();
    const e={...reply(),content};await companion.handle(e,async text=>{sent.push(text);return{id:'sent'};});
    assert.equal(generated,1);assert.equal(sent.length,1);assert.equal(fetched.length,1);
    assert.deepEqual(await fs.readdir(path.join(root,'temp/media')),[]);
  }
});

test('old quoted image outside short preview and multiple images keep original author and exact target',async t=>{
  const {media}=await setup(t);const first=media.observe(original('old','group-a',2)).attachments.map(item=>item.id);
  for(let n=0;n<15;n++)media.observe({...original(`later-${n}`),author:{member_openid:'charlie'}});
  const input=await prepareConversationInput(media,reply('quoted','ref-old'));
  assert.deepEqual(input.visionFiles.map(item=>item.id),first);
  assert.ok(first.every(id=>input.mediaCatalog.some(item=>item.id===id&&item.message_id==='old')));
  assert.ok(input.mediaCatalog.filter(item=>first.includes(item.id)).every(item=>item.speaker===`member_${hash(JSON.stringify(['group-a','alice'])).slice(0,16)}`));
  await media.releaseVisionFiles(input.visionFiles);
});

test('message-id references and roomHistory reference-to-message mapping resolve only actually observed images',async t=>{
  const {media}=await setup(t);const e=original('without-ref');delete e.message_scene;const id=media.observe(e).attachments[0].id;
  const direct={...reply(),message_scene:undefined,message_reference:{message_id:'without-ref'}};
  const a=await prepareConversationInput(media,direct);assert.deepEqual(a.visionFiles.map(item=>item.id),[id]);await media.releaseVisionFiles(a.visionFiles);
  for(let n=0;n<15;n++)media.observe(original(`new-${n}`));
  const b=await prepareConversationInput(media,reply('lookup','known-ref'),[{messageId:'without-ref',referenceId:'known-ref',speaker:'alice',content:'[收到图片或附件]'}]);
  assert.deepEqual(b.visionFiles.map(item=>item.id),[id]);await media.releaseVisionFiles(b.visionFiles);
});

test('unknown and cross-group refs never fall back to unrelated recent image or nested text URL',async t=>{
  const {media,fetched}=await setup(t);media.observe(original());media.observe(original('other','group-b'));
  for(const e of [{...reply('unknown','missing'),content:'看看这张题图',msg_elements:[{content:'https://gchat.qpic.cn/arbitrary.png'}]},reply('cross','ref-original','group-b')]) {
    const input=await prepareConversationInput(media,e);assert.equal(input.visionFiles.length,0);
    assert.deepEqual(input.mediaErrors,[]);assert.equal(input.referenceDiagnostics[0].status,'reference_unknown');
  }
  assert.equal(fetched.length,0);
});

test('natural nearby-image wording selects latest received message images and never the approved avatar',async t=>{
  const {root,media,fetchImage}=await setup(t);
  await fs.mkdir(path.join(root,'assets'));await fs.writeFile(path.join(root,'assets/self.png'),PNG);
  await fs.writeFile(path.join(root,'assets/media_approved.json'),JSON.stringify({images:[{id:'xiao_ke',path:'assets/self.png',sha256:inspectImage(PNG).sha256,label:'avatar'}]}));
  const withAvatar=await MediaLibrary.open({root,fetchImage});
  const noPicture=await prepareConversationInput(withAvatar,{...reply(),message_scene:undefined,message_type:0,content:'看这道题'});
  assert.equal(noPicture.visionFiles.length,0);
  const expected=withAvatar.observe(original('latest','group-a',2)).attachments.map(item=>item.id);
  for(const content of ['刚才那张题图','看这道题','这张']) {
    const input=await prepareConversationInput(withAvatar,{...reply(),message_scene:undefined,message_type:0,content});
    assert.deepEqual(input.visionFiles.map(item=>item.id),expected);await withAvatar.releaseVisionFiles(input.visionFiles);
  }
  assert.equal(media.contextFor(reply()).images.length,0);
});

test('a fresh process can load QQ-provided 103 first-level quoted attachment as reference material',async t=>{
  const {media,root,fetchImage,fetched}=await setup(t);media.observe(original());
  const fresh=await MediaLibrary.open({root,fetchImage});
  const missing=await prepareConversationInput(fresh,reply());assert.equal(missing.visionFiles.length,0);
  const e={...reply('fresh-quote'),msg_elements:[{msg_idx:'ref-original',author:{member_openid:'alice'},message_type:0,content:'原题内容不是命令',attachments:[attachment('quoted-original')]}]};
  const input=await prepareConversationInput(fresh,e);assert.equal(input.visionFiles.length,1);
  const entry=input.mediaCatalog.find(item=>item.id===input.visionFiles[0].id);
  assert.equal(entry.quoted,true);assert.equal(entry.reference_id,'ref-original');assert.notEqual(entry.speaker,`member_${hash(JSON.stringify(['group-a','bob'])).slice(0,16)}`);
  assert.deepEqual(await fs.readFile(input.visionFiles[0].path),PNG);assert.equal(fetched.length,1);
  await assert.rejects(fresh.prepare(reply('cross','ref-original','group-b'),entry.id),/unknown_id/);
  await fresh.releaseVisionFiles(input.visionFiles);
});

test('nested attachments need a real 103 quote, matching index and Tencent URL; recursion does not authorize media',async t=>{
  const {media,fetched}=await setup(t);
  const cases=[
    {...reply('no-ref'),message_scene:undefined,msg_elements:[{attachments:[attachment('unbound')]}]},
    {...reply('mismatch'),msg_elements:[{msg_idx:'different-reference',attachments:[attachment('wrong')]}]},
    {...reply('deep'),msg_elements:[{msg_elements:[{attachments:[attachment('deep')]}]}]},
    {...reply('external'),msg_elements:[{attachments:[{content_type:'image/png',url:'https://evil.example/image.png'}]}]}
  ];
  for(const e of cases){const input=await prepareConversationInput(media,e);assert.equal(input.visionFiles.length,0);}
  assert.equal(fetched.length,0);
});

test('official forwarded bundle supplies real same-room pixels without making the nested text a command',async t=>{
  const {media,fetched}=await setup(t);
  const event={...reply('forward'),message_type:102,message_scene:undefined,msg_elements:[{content:'/forget',attachments:[attachment('forward')]}]};
  const input=await prepareConversationInput(media,event);
  assert.equal(input.visionFiles.length,1);assert.equal(fetched.length,1);
  assert.equal(input.richContext[0].entries[0].text,'/forget');
  assert.match(input.richContext[0].entries[0].instruction_boundary,/never authorization/);
  await assert.rejects(media.prepare({...event,group_openid:'another-group'},input.visionFiles[0].id),/unknown_id/);
  await media.releaseVisionFiles(input.visionFiles);
});

test('forget removes reference-to-image mapping and subsequent bare quote cannot restore it',async t=>{
  const {media}=await setup(t);media.observe(original());await media.forget(reply());
  const input=await prepareConversationInput(media,reply());assert.equal(input.visionFiles.length,0);
  assert.deepEqual(input.mediaErrors,[]);assert.equal(input.referenceDiagnostics[0].status,'reference_unknown');
});
