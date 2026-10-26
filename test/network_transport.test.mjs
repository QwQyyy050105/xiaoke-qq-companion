import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {createQQNetworkTransport} from '../src/network_transport.mjs';

test('QQ fetch and gateway both tunnel through the configured proxy without local DNS',{timeout:10000},async t=>{
  const target=http.createServer((req,res)=>res.end('proxy-ok'));
  const sockets=new Set();
  const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));};
  target.on('connection',track);target.listen(0,'127.0.0.1');await once(target,'listening');
  const wss=new WebSocketServer({server:target});wss.on('connection',ws=>ws.send('gateway-ok'));
  let connects=0;
  const proxy=http.createServer();proxy.on('connection',track);
  proxy.on('connect',(req,downstream,head)=>{
    connects++;assert.equal(req.url.split(':')[0],'no-local-dns.invalid');
    const upstream=net.connect(target.address().port,'127.0.0.1',()=>{
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);downstream.pipe(upstream);upstream.pipe(downstream);
    });track(upstream);upstream.on('error',()=>downstream.destroy());downstream.on('error',()=>upstream.destroy());
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const transport=createQQNetworkTransport('http://127.0.0.1:'+proxy.address().port);
  let ws;
  t.after(async()=>{ws?.terminate();for(const socket of sockets)socket.destroy();wss.close();target.close();proxy.close();await transport.close();});
  const response=await transport.fetcher('http://no-local-dns.invalid:'+target.address().port+'/health',{signal:AbortSignal.timeout(3000)});
  assert.equal(await response.text(),'proxy-ok');
  ws=new WebSocket('ws://no-local-dns.invalid:'+target.address().port,{agent:transport.webSocketAgent});
  const [message]=await once(ws,'message');assert.equal(message.toString(),'gateway-ok');assert.ok(connects>=2);
});

test('proxy validation fails visibly rather than silently sending direct',()=>{
  for(const proxy of ['socks5://127.0.0.1:7897','http://fixture:fake@example.com:7897','http://localhost:7897/?token=secret'])assert.throws(()=>createQQNetworkTransport(proxy));
  const direct=createQQNetworkTransport();assert.equal(direct.fetcher,globalThis.fetch);assert.equal(direct.webSocketAgent,undefined);
});
