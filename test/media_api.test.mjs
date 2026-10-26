import test from 'node:test';
import assert from 'node:assert/strict';
import { QQClient } from '../src/qq.mjs';
import { inspectImage } from '../src/media_image.mjs';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
function clientWith(calls,upload={file_info:'opaque-media-info',ttl:3600}) {
  return new QQClient('test','dummy',{fetcher:async(url,request)=>{
    calls.push({url,body:JSON.parse(request.body||'null')});return {ok:true,status:200,json:async()=>url.endsWith('getAppAccessToken')?{access_token:'test',expires_in:7200}:url.endsWith('/files')?upload:{id:'sent',ext_info:{ref_idx:'sent-ref'}}};
  }});
}
test('group image uploads validated base64 without proactive side effect then sends type7 passive reply',async()=>{
  const calls=[],client=clientWith(calls),event={id:'incoming',group_openid:'group/a',message_scene:{ext:['msg_idx=current-reference','ref_msg_idx=old-reference']}};
  const sent=await client.replyImage(event,inspectImage(PNG),2,{quote:true});assert.equal(sent.id,'sent');
  assert.equal(calls[1].url,'https://api.bot.qq.com/v2/groups/group%2Fa/files');
  assert.equal(calls[1].body.file_type,1);assert.equal(calls[1].body.srv_send_msg,false);assert.equal(calls[1].body.file_data,PNG.toString('base64'));assert.equal(calls[1].body.url,undefined);
  assert.deepEqual(calls[2].body,{msg_type:7,media:{file_info:'opaque-media-info'},msg_id:'incoming',msg_seq:2,message_reference:{message_id:'current-reference'}});
});
test('private images use users target; unknown references and file paths are never invented',async()=>{
  const calls=[],client=clientWith(calls);await client.replyImage({id:'incoming',author:{user_openid:'user'}},inspectImage(PNG),1,{quote:true});
  assert.equal(calls[1].url,'https://api.bot.qq.com/v2/users/user/files');assert.equal(calls[2].body.message_reference,undefined);
  await assert.rejects(client.replyImage({id:'incoming',group_openid:'group'},{path:'D:\\credentials.xml'},1),/image_size/);
  await assert.rejects(client.replyImage({id:'incoming',group_openid:'group'},inspectImage(PNG),0),/invalid_reply_target/);
  assert.equal(calls.length,3);
});
test('failed or malformed upload never triggers send and QQ business errors remain observable',async()=>{
  for(const result of [{code:850031},{file_info:''}]) {
    const calls=[],client=clientWith(calls,result);await assert.rejects(client.replyImage({id:'incoming',group_openid:'group'},inspectImage(PNG),1),/qq_api_error_850031|qq_invalid_media_upload/);
    assert.equal(calls.length,2);
  }
});
test('ordinary text keeps legacy payload unless quote requested and real current reference present',async()=>{
  const calls=[],client=clientWith(calls);const e={id:'incoming',group_openid:'group',message_scene:{ext:['msg_idx=real-reference']}};
  await client.reply(e,'hi',1);await client.reply(e,'hi again',2,{quote:true});await client.reply({...e,message_scene:undefined},'no ref',3,{quote:true});
  assert.equal(calls[1].body.message_reference,undefined);assert.deepEqual(calls[2].body.message_reference,{message_id:'real-reference'});assert.equal(calls[3].body.message_reference,undefined);
});
