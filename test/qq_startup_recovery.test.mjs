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
  config.scope.groups = ['fixture-group'];
  config.media.asr = true;
  config.plugins = ['./plugins/fixture_asr.mjs'];
  await mkdir(join(root, 'plugins'));
  await writeFile(join(root, 'plugins', 'fixture_asr.mjs'), `
    export default {
      apiVersion:1, id:'fixture-asr', capabilities:['asr'], setup() {
        return {asr:async ({buffer, mime, signal}) => {
          if (signal.aborted || mime !== 'audio/wav' || buffer.length !== 46) throw Error('unexpected_audio');
          return {status:'ok', text:'请告诉我西瓜的颜色'};
        }};
      }
    };
  `);
  config.consolePort = 0;
  config.pairingHash = createHash('sha256').update('fixture-phrase').digest('hex');
  await writeFile(join(root, 'config.local.json'), JSON.stringify(config));

  let tokenAttempts = 0;
  const audioRequests = [];
  const replies = [];
  function voice(id, type, target, referenceText = '') {
    const isGroup = type === 'GROUP_AT_MESSAGE_CREATE';
    const data = {id, content:'', author:isGroup ? {member_openid:'member'} : {user_openid:target},
      ...(isGroup ? {group_openid:target} : {}),
      attachments:[{content_type:'voice', asr_refer_text:referenceText, voice_wav_url:'https://gchat.qpic.cn/' + id, url:'https://gchat.qpic.cn/original'}]};
    for (const socket of gateway.clients) socket.send(JSON.stringify({op:0, t:type, d:data}));
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/app/getAppAccessToken') {
      tokenAttempts++;
      if (tokenAttempts === 1) { res.writeHead(503); res.end('temporarily unavailable'); return; }
      res.end(JSON.stringify(tokenAttempts === 2 ? {access_token:'fixture-token', expires_in:7200} : {code:100016}));
    } else if (req.url === '/gateway/bot') {
      res.end(JSON.stringify({url:'wss://gateway.invalid/'}));
    } else if (req.url === '/v2/users/fixture-owner/messages' || req.url === '/v2/groups/fixture-group/messages') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const reply = JSON.parse(text);
      replies.push(reply);
      res.end(JSON.stringify({id:'reply-' + replies.length}));
      if (reply.msg_id === 'voice-pair') {
        for (const socket of gateway.clients) socket.send(JSON.stringify({op:0, s:3, t:'C2C_MESSAGE_CREATE', d:{
          id:'sample-message', author:{user_openid:'fixture-owner'}, content:'/pair fixture-phrase'
        }}));
      } else if (reply.msg_id === 'sample-message') {
        voice('denied-voice', 'C2C_MESSAGE_CREATE', 'other-user');
        voice('owner-voice', 'C2C_MESSAGE_CREATE', 'fixture-owner');
      } else if (reply.msg_id === 'owner-voice') {
        voice('voice-approval', 'C2C_MESSAGE_CREATE', 'fixture-owner', '/approve 12345');
      } else if (reply.msg_id === 'voice-approval') {
        voice('voice-browser', 'C2C_MESSAGE_CREATE', 'fixture-owner', '去抖音看看今天的新闻');
      } else if (reply.msg_id === 'voice-browser') {
        voice('group-voice', 'GROUP_AT_MESSAGE_CREATE', 'fixture-group');
      } else {
        // Reject the next credential request so the real service exits on its own.
        for (const socket of gateway.clients) socket.close(4004);
      }
    } else if (['/owner-voice','/group-voice'].includes(req.url)) {
      audioRequests.push(req.url);
      res.setHeader('content-type', 'audio/wav');
      res.end(Buffer.from('UklGRiYAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQIAAAAAAA==','base64'));
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
      voice('voice-pair', 'C2C_MESSAGE_CREATE', 'fixture-owner', '/pair fixture-phrase');
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
    import dns from 'node:dns/promises';
    dns.lookup = async host => {
      if (host !== 'gchat.qpic.cn') throw Error('unexpected_dns');
      return [{address:'8.8.8.8', family:4}];
    };
    const port = ${server.address().port};
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input);
      if (url.origin !== 'https://api.bot.qq.com') throw Error('unexpected_http_destination');
      return fetch('http://127.0.0.1:' + port + url.pathname + url.search, init);
    };
    https.request = (options, callback) => {
      if (!['gchat.qpic.cn', 'gateway.invalid'].includes(options.hostname || options.host)) throw Error('unexpected_destination');
      return http.request({...options, protocol:'http:', host:'127.0.0.1', hostname:'127.0.0.1', port, createConnection:undefined, lookup:undefined}, callback);
    };
  `);
  const childEnv = {QQ_APP_ID:'fixture-app', QQ_APP_SECRET:'fixture-secret', TEMP:temp, TMP:temp};
  if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
  await assert.rejects(execute(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'src', 'cli.mjs'), 'start'], {
    cwd:root, env:childEnv, timeout:20000, windowsHide:true
  }), {code:1});
  assert.equal(tokenAttempts, 3);
  assert.deepEqual(replies.map(reply => reply.msg_id), ['voice-pair', 'sample-message', 'owner-voice', 'voice-approval', 'voice-browser', 'group-voice']);
  assert.deepEqual(audioRequests, ['/owner-voice', '/group-voice']);
  assert.match(replies[0].content, /还没完成主人配对/);
  assert.match(replies[1].content, /连上啦/);
  assert.match(replies[2].content, /请告诉我西瓜的颜色/);
  assert.match(replies[3].content, /语音转写.*\/approve 12345/s);
  assert.match(replies[4].content, /语音转写.*去抖音看看/s);
  assert.match(replies[5].content, /请告诉我西瓜的颜色/);
  assert.equal(JSON.parse(await readFile(join(root,'data','runtime_status.json'), 'utf8')).connected, false);
  await assert.rejects(access(join(root, 'temp', 'bridge.lock')), {code:'ENOENT'});
});
