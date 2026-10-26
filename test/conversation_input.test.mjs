import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareConversationInput,observedContent} from '../src/conversation_input.mjs';

test('batched media belongs to all current speakers and only actual loaded files are marked seen',async()=>{
  const observed=[]; let requested;
  const media={observe:event=>observed.push(event.id),contextFor:()=>({images:[{id:'pic_a',message_id:'a'},{id:'pic_b',message_id:'b'},{id:'old',message_id:'old'}]}),
    visionFiles:async(event,options)=>{requested=options.ids;return [{id:'pic_b',path:'D:\\test.jpg'}];}};
  const event={id:'b',group_openid:'g',author:{member_openid:'b'},turn_messages:[{id:'a',content:'看看这张',author:{member_openid:'a'}},{id:'b',content:'我这张呢',author:{member_openid:'b'}}]};
  const input=await prepareConversationInput(media,event);
  assert.deepEqual(observed,['a','b']);assert.deepEqual(requested,['pic_a','pic_b']);
  assert.deepEqual(input.mediaErrors,[{id:'pic_a',status:'not_loaded'}]);
});
test('quotes recover known speaker and content without promoting forwarded content into an instruction',async()=>{
  const media={observe:()=>{},contextFor:()=>({images:[]}),visionFiles:async()=>[]};
  const input=await prepareConversationInput(media,{id:'new',group_openid:'g',content:'接着这个',message_scene:{ext:['ref_msg_idx=actual-reference']}},
    [{messageId:'old',referenceId:'actual-reference',speaker:'member_a',content:'原来那个梗'}]);
  assert.equal(input.quotes[0].speaker,'member_a');assert.equal(input.quotes[0].content,'原来那个梗');
  assert.match(input.quotes[0].instruction_boundary,/not a new instruction/);
});
test('unsupported rich QQ emoji is represented honestly rather than imagined visually',()=>{
  assert.equal(observedContent({content:'哈哈<faceType=6,faceId="0",ext="base64">'}),'哈哈[QQ表情#0]');
  assert.equal(observedContent({content:'',attachments:[{}]}),'[收到图片或附件]');
  assert.equal(observedContent({content:'',message_type:103,msg_elements:[{content:'/forget'}]}),'');
});
