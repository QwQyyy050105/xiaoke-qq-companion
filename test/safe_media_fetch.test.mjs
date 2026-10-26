import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fetchMediaImage,isPublicMediaAddress,validateMediaUrl } from '../src/safe_media_fetch.mjs';
import { MAX_IMAGE_BYTES } from '../src/media_image.mjs';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const lookup=async()=>[{address:'8.8.8.8',family:4}];
function transport(responses,calls=[]) {
  return (options,callback)=>{
    calls.push(options);const request=new EventEmitter();request.destroy=()=>{};
    request.end=()=>queueMicrotask(()=>{
      const item=responses.shift();if(item.error)return request.emit('error',Error(item.error));
      const response=Readable.from(item.chunks||[item.body||PNG]);response.statusCode=item.status||200;response.headers=item.headers||{'content-type':'image/png'};
      response.complete=false;response.on('end',()=>{response.complete=true;});callback(response);
    });return request;
  };
}
test('SSRF policy rejects private, mapped, reserved, local and unknown-host addresses',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','100.64.1.1','192.168.1.1','169.254.169.254','0.0.0.0','198.18.0.1','192.0.2.1','224.0.0.1','240.0.0.1','::1','::ffff:127.0.0.1','64:ff9b::c0a8:1','2002:0a00:0001::','2001:db8::1','fc00::1','fe80::1','not-ip'])assert.equal(isPublicMediaAddress(address),false,address);
  assert.equal(isPublicMediaAddress('8.8.8.8'),true);assert.equal(isPublicMediaAddress('2606:4700:4700::1111'),true);
  for(const url of ['file:///D:/a.png','http://gchat.qpic.cn/a','https://gchat.qpic.cn.evil.org/a','https://qpic.cn@evil.org/a','https://fixture:fake@example.com/a','https://gchat.qpic.cn:444/a','https://127.0.0.1/a'])assert.throws(()=>validateMediaUrl(url));
});
test('download validates all DNS answers and pins original TLS hostname to accepted IP',async()=>{
  const calls=[];const image=await fetchMediaImage('https://gchat.qpic.cn/x',{lookup,request:transport([{}],calls)});
  assert.equal(image.mime,'image/png');assert.equal(calls[0].hostname,'gchat.qpic.cn');assert.equal(calls[0].servername,'gchat.qpic.cn');assert.equal(calls[0].rejectUnauthorized,true);
  const pinned=await new Promise((resolve,reject)=>calls[0].lookup('ignored',{},(error,address,family)=>error?reject(error):resolve({address,family})));
  assert.deepEqual(pinned,{address:'8.8.8.8',family:4});
  await assert.rejects(fetchMediaImage('https://gchat.qpic.cn/x',{lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request:()=>assert.fail('must not request')}),/private_address/);
});
test('redirects revalidate host and DNS and do not forward authorization',async()=>{
  const calls=[];let dnsCalls=0;
  await fetchMediaImage('https://gchat.qpic.cn/a',{lookup:async()=>{dnsCalls++;return lookup();},request:transport([{status:302,headers:{location:'https://multimedia.nt.qq.com.cn/b'}},{}],calls)});
  assert.equal(dnsCalls,2);assert.equal(calls.length,2);assert.equal(calls[1].headers.Authorization,undefined);
  await assert.rejects(fetchMediaImage('https://gchat.qpic.cn/a',{lookup,request:transport([{status:302,headers:{location:'https://evil.org/x'}}])}),/url_not_allowed/);
  let count=0;await assert.rejects(fetchMediaImage('https://gchat.qpic.cn/a',{lookup:async()=>[{address:count++?'127.0.0.1':'8.8.8.8',family:4}],request:transport([{status:302,headers:{location:'/b'}}])}),/private_address/);
});
test('rejects mismatched MIME, non-image content, decompression and oversized streaming responses',async()=>{
  for(const response of [
    {headers:{'content-type':'text/html'}},
    {headers:{'content-type':'image/png'},body:Buffer.from('<html>bad</html>')},
    {headers:{'content-encoding':'gzip'}},
    {headers:{'content-length':String(MAX_IMAGE_BYTES+1)}},
    {chunks:[PNG,Buffer.alloc(MAX_IMAGE_BYTES)]}
  ])await assert.rejects(fetchMediaImage('https://gchat.qpic.cn/a',{lookup,request:transport([response])}),/media_/);
});
test('network failover tries only validated public addresses and preserves URL host',async()=>{
  const calls=[];
  const image=await fetchMediaImage('https://gchat.qpic.cn/a',{lookup:async()=>[{address:'2606:4700:4700::1111',family:6},{address:'8.8.8.8',family:4}],request:transport([{error:'offline'},{}],calls)});
  assert.equal(image.width,1);assert.equal(calls.length,2);
  const address=await new Promise(resolve=>calls[0].lookup('',{},(_,ip)=>resolve(ip)));assert.equal(address,'8.8.8.8');
});

test('timeout includes DNS and redirect loops have a hard hop limit',async()=>{
  await assert.rejects(fetchMediaImage('https://gchat.qpic.cn/a',{timeoutMs:1000,lookup:()=>new Promise(()=>{}),request:()=>assert.fail('must not request')}),/fetch_timeout/);
  const calls=[];
  await assert.rejects(fetchMediaImage('https://gchat.qpic.cn/a',{lookup,request:transport(Array.from({length:4},()=>({status:302,headers:{location:'/a'}})),calls)}),/too_many_redirects/);
  assert.equal(calls.length,4);
});
