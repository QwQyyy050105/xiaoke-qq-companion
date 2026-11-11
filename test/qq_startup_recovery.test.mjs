import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {WebSocketServer} from 'ws';
import {defaults} from '../src/public_config.mjs';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));

test('the start command recovers from an offline boot, delivers a reply, and exits on rejected credentials', {timeout:25000}, async t => {
  const temp = join(project, 'temp');
  await mkdir(temp, {recursive:true});
  const root = await mkdtemp(join(temp, 'gateway_start_'));
  t.after(() => rm(root, {recursive:true, force:true}));
  for (const name of ['src', 'assets', 'character_card.json', 'persona.txt']) {
    await cp(join(project, name), join(root, name), {recursive:true});
  }
  const config = defaults();
  config.scope.privateUsers = ['fixture-owner'];
  config.consolePort = 0;
  config.pairingHash = createHash('sha256').update('fixture-phrase').digest('hex');
  await writeFile(join(root, 'config.local.json'), JSON.stringify(config));

  let tokenAttempts = 0;
  const replies = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/app/getAppAccessToken') {
      tokenAttempts++;
      if (tokenAttempts === 1) { res.writeHead(503); res.end('temporarily unavailable'); return; }
      res.end(JSON.stringify(tokenAttempts === 2 ? {access_token:'fixture-token', expires_in:7200} : {code:100016}));
    } else if (req.url === '/gateway/bot') {
      res.end(JSON.stringify({url:'wss://gateway.invalid/'}));
    } else if (req.url === '/v2/users/fixture-owner/messages') {
      let text = '';
      for await (const chunk of req) text += chunk;
      replies.push(JSON.parse(text));
      res.end(JSON.stringify({id:'reply-receipt'}));
      // Reject the next credential request so the real service exits on its own.
      for (const socket of gateway.clients) socket.close(4004);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const gateway = new WebSocketServer({server});
  gateway.on('connection', socket => {
    socket.send(JSON.stringify({op:10, d:{heartbeat_interval:30000}}));
    socket.on('message', raw => {
      if (JSON.parse(raw).op !== 2) return;
      socket.send(JSON.stringify({op:0, s:1, t:'READY', d:{session_id:'sample-session'}}));
      socket.send(JSON.stringify({op:0, s:2, t:'C2C_MESSAGE_CREATE', d:{
        id:'sample-message', author:{user_openid:'fixture-owner'}, content:'/pair fixture-phrase'
      }}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of gateway.clients) socket.terminate();
    gateway.close();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });

  // Redirect only the two expected destinations to our loopback QQ simulator.
  const preload = join(root, 'loopback.mjs');
  await writeFile(preload, `
    import http from 'node:http';
    import https from 'node:https';
    const port = ${server.address().port};
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input);
      if (url.origin !== 'https://api.bot.qq.com') throw Error('unexpected_http_destination');
      return fetch('http://127.0.0.1:' + port + url.pathname + url.search, init);
    };
    https.request = options => {
      if (options.host !== 'gateway.invalid' && options.hostname !== 'gateway.invalid') throw Error('unexpected_gateway');
      return http.request({...options, protocol:'http:', host:'127.0.0.1', hostname:'127.0.0.1', port, createConnection:undefined});
    };
  `);
  const childEnv = {QQ_APP_ID:'fixture-app', QQ_APP_SECRET:'fixture-secret', TEMP:temp, TMP:temp};
  if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
  await assert.rejects(execute(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'src', 'cli.mjs'), 'start'], {
    cwd:root, env:childEnv, timeout:20000, windowsHide:true
  }), {code:1});
  assert.equal(tokenAttempts, 3);
  assert.deepEqual(replies.map(reply => reply.msg_id), ['sample-message']);
  assert.match(replies[0].content, /连上啦/);
  assert.equal(JSON.parse(await readFile(join(root,'data','runtime_status.json'), 'utf8')).connected, false);
  await assert.rejects(access(join(root, 'temp', 'bridge.lock')), {code:'ENOENT'});
});
