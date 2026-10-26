import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Companion } from '../src/core.mjs';
import { MediaLibrary } from '../src/media.mjs';
import { inspectImage } from '../src/media_image.mjs';
import { prepareConversationInput } from '../src/conversation_input.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const temp=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');

test('overlong turn rejected before generation does not leave prepared vision files',async t=>{
  await fs.mkdir(temp,{recursive:true});const root=await fs.mkdtemp(path.join(temp,'media_integration_'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const media=await MediaLibrary.open({root,fetchImage:async()=>inspectImage(PNG)});
  const replies=[];
  const companion=await new Companion({
    dataDir:path.join(root,'data'),pairingHash:'',
    prepareInput:event=>prepareConversationInput(media,event),
    releaseInput:input=>media.releaseVisionFiles(input.visionFiles||[]),
    generate:async()=>assert.fail('long rejected input must not call the model')
  }).init();
  await companion.handle({id:'long-image',group_openid:'test-group',author:{member_openid:'test-member'},content:'长'.repeat(8001),
    attachments:[{content_type:'image/png',url:'https://gchat.qpic.cn/fixture.png',size:PNG.length}]},async reply=>{replies.push(reply);return{id:'notice'};});
  assert.equal(replies.length,1);assert.match(replies[0],/长/);
  assert.deepEqual(await fs.readdir(path.join(root,'temp','media')),[],'early returns must not leak material prepared for model input');
});
