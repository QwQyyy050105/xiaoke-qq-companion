import test from 'node:test';
import assert from 'node:assert/strict';
import {QQClient} from '../src/qq.mjs';
const event={id:'synthetic-message',group_openid:'synthetic-group',author:{member_openid:'synthetic-member'}};
const response=(status,body)=>({status,ok:status===200,json:async()=>body});
function wav(){const b=Buffer.alloc(16044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(16000,40);return b;}
test('a clear command during token refresh prevents the delayed text request',async()=>{
  let current=true;const calls=[];
  const client=new QQClient('test','test',{fetcher:async url=>{calls.push(url);throw Error('unexpected transport');}});
  client.accessToken=async()=>{await Promise.resolve();current=false;return 'synthetic-token';};
  await assert.rejects(client.reply(event,'晚到文本',1,{isCurrent:()=>current}),error=>error.messageNotSent===true);
  assert.equal(calls.length,0);
});
test('a clear command after audio upload and during message-token await prevents voice send',async()=>{
  let current=true,tokens=0;const calls=[];
  const client=new QQClient('test','test',{fetcher:async url=>{calls.push(url);return response(200,{file_info:'synthetic-file'});}});
  client.accessToken=async()=>{await Promise.resolve();if(++tokens===2)current=false;return 'synthetic-token';};
  await assert.rejects(client.replyVoice(event,{buffer:wav()},1,{isCurrent:()=>current}),error=>error.messageNotSent===true);
  assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/files'));
});
test('the cancellation guard survives a 401 token retry',async()=>{
  let current=true,tokens=0;const calls=[];
  const client=new QQClient('test','test',{fetcher:async url=>{calls.push(url);return response(401,{code:401});}});
  client.accessToken=async()=>{if(++tokens===2)current=false;return 'synthetic-token';};
  await assert.rejects(client.reply(event,'只应尝试一次',1,{isCurrent:()=>current}),error=>error.messageNotSent===true);
  assert.equal(calls.length,1);
});
