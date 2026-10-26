import WebSocket from 'ws';
import { inspectImage } from './media_image.mjs';
import { messageIndex } from './media.mjs';
import { inspectVoice } from './voice_library.mjs';
import { textWithMentions } from './recipient_resolver.mjs';

const BASE = 'https://api.bot.qq.com';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sentReceipt = result => { if(!validId(result?.id))throw new Error('qq_delivery_unconfirmed');return result; };
const userIds = user => [user?.id, user?.openid, user?.user_openid, user?.member_openid].filter(validId);
const groupMentions = (data, eventType, selfIds) => {
  let explicitMention = eventType === 'GROUP_AT_MESSAGE_CREATE';
  let otherMembers = false;
  const confirmedSelfIds = new Set(selfIds);
  const deniedSelfIds = new Set();
  for (const mention of Array.isArray(data?.mentions) ? data.mentions : []) {
    if (!mention || typeof mention !== 'object') continue;
    const ids = userIds(mention);
    // is_you is QQ's explicit self-mention marker; bot:true alone also describes other bots.
    const isSelf = mention.is_you === true || (mention.is_you !== false && ids.some(id => selfIds.has(id)));
    if (isSelf) { explicitMention = true; ids.forEach(id => confirmedSelfIds.add(id)); }
    else if (mention.scope !== 'all' && (mention.is_you === false || (mention.bot === false && ids.length))) otherMembers = true;
    if (mention.is_you === false) ids.forEach(id => deniedSelfIds.add(id));
  }
  for (const match of String(data?.content ?? '').matchAll(/<@!?([^>]+)>/g)) {
    if (selfIds.has(match[1]) && !deniedSelfIds.has(match[1])) explicitMention = true;
  }
  let addressedContent = String(data?.content ?? '');
  // Keep raw content intact. Strip only confirmed self mentions at the very beginning.
  while (true) {
    const prefix = addressedContent.match(/^\s*<@!?([^>]+)>/);
    if (!prefix || !confirmedSelfIds.has(prefix[1]) || deniedSelfIds.has(prefix[1])) break;
    addressedContent = addressedContent.slice(prefix[0].length).trimStart();
  }
  return { explicit_mention: explicitMention, mentions_other_members: otherMembers, addressed_content: addressedContent };
};
export class QQClient {
  constructor(appId, secret, { fetcher = fetch, log = console.log, webSocketAgent } = {}) {
    this.appId = appId; this.secret = secret; this.fetcher = fetcher; this.log = log; this.webSocketAgent = webSocketAgent;
    this.token = null; this.expiresAt = 0; this.stopped = false; this.seq = null; this.session = null;
    this.selfIds = new Set(); this.connected = false;
  }
  async accessToken() {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    const response = await this.fetcher(BASE + '/app/getAppAccessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }), signal: AbortSignal.timeout(15000)
    });
    const body = await response.json();
    if (!response.ok || !body.access_token || (body.code && body.code !== 0)) throw new Error(`qq_token_error_${body.code || response.status}`);
    this.token = body.access_token; this.expiresAt = Date.now() + Math.max(1, Number(body.expires_in) - 60) * 1000;
    return this.token;
  }
  async api(path, method = 'GET', payload, retry = true, isCurrent = null) {
    const token = await this.accessToken();
    if(isCurrent && !isCurrent())throw Object.assign(Error('qq_cancelled_before_send'),{messageNotSent:true});
    const response = await this.fetcher(BASE + path, {
      method, headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'X-Union-Appid': this.appId },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(15000)
    });
    const body = await response.json();
    if (response.status === 401 && retry) { this.token = null; return this.api(path, method, payload, false, isCurrent); }
    if (!response.ok || (body.code && body.code !== 0)) {
      const error = new Error(`qq_api_error_${body.code || response.status}`);
      error.status = response.status; error.code = body.code;
      throw error;
    }
    return body;
  }
  async reply(event, content, msgSeq, { quote = false, referenceId = '', mentions = [], isCurrent = null } = {}) {
    const openid = event.group_openid || event.author?.user_openid || event.author?.id;
    if (!openid || !event.id) throw new Error('qq_invalid_reply_target');
    const destination = event.group_openid ? 'groups' : 'users';
    const reference = event.group_openid ? (validId(referenceId) ? referenceId : quote ? messageIndex(event) : '') : '';
    return this.api(`/v2/${destination}/${encodeURIComponent(openid)}/messages`, 'POST', { content:textWithMentions(content,event.group_openid?mentions:[]), msg_type: 0, msg_id: event.id, msg_seq: msgSeq,
      ...(reference ? { message_reference: { message_id: reference } } : {}) },true,isCurrent).then(sentReceipt);
  }
  async replyImage(event, preparedImage, msgSeq, { quote = false, referenceId = '' } = {}) {
    const openid = event.group_openid || event.author?.user_openid || event.author?.id;
    if (!validId(openid) || !validId(event.id) || !Number.isInteger(msgSeq) || msgSeq < 1) throw new Error('qq_invalid_reply_target');
    // No filesystem path or caller-supplied URL is accepted at this API boundary.
    const image = inspectImage(preparedImage?.buffer, preparedImage?.mime, {allowExtended:true});
    const destination = event.group_openid ? 'groups' : 'users';
    const target = `/v2/${destination}/${encodeURIComponent(openid)}`;
    const uploaded = await this.api(`${target}/files`, 'POST', { file_type: 1, file_data: image.buffer.toString('base64'),
      file_name: image.fileName, srv_send_msg: false });
    if (typeof uploaded.file_info !== 'string' || !uploaded.file_info || uploaded.file_info.length > 65536) throw new Error('qq_invalid_media_upload');
    const reference = event.group_openid ? (validId(referenceId) ? referenceId : quote ? messageIndex(event) : '') : '';
    return this.api(`${target}/messages`, 'POST', { msg_type: 7, media: { file_info: uploaded.file_info }, msg_id: event.id, msg_seq: msgSeq,
      ...(reference ? { message_reference: { message_id: reference } } : {}) }).then(sentReceipt);
  }
  async replyVoice(event,preparedVoice,msgSeq,{referenceId='',isCurrent=()=>true}={}){
    const openid=event.group_openid||event.author?.user_openid||event.author?.id;
    if(!validId(openid)||!validId(event.id)||!Number.isInteger(msgSeq)||msgSeq<1)throw Error('qq_invalid_reply_target');
    const voice=inspectVoice(preparedVoice?.buffer),destination=event.group_openid?'groups':'users',target=`/v2/${destination}/${encodeURIComponent(openid)}`;
    if(!isCurrent())throw Object.assign(Error('qq_voice_cancelled_before_send'),{messageNotSent:true});
    let uploaded;
    try{
      uploaded=await this.api(`${target}/files`,'POST',{file_type:3,file_data:voice.buffer.toString('base64'),file_name:voice.fileName,srv_send_msg:false});
      if(typeof uploaded?.file_info!=='string'||!uploaded.file_info||uploaded.file_info.length>65536)throw Error('qq_invalid_media_upload');
    }catch(error){
      // Uploads explicitly do not send a QQ message. Even an uncertain upload
      // response is a known pre-message failure and can fall back to text.
      throw Object.assign(error instanceof Error?error:Error('qq_invalid_media_upload'),{messageNotSent:true});
    }
    if(!isCurrent())throw Object.assign(Error('qq_voice_cancelled_before_send'),{messageNotSent:true});
    return this.api(`${target}/messages`,'POST',{msg_type:7,media:{file_info:uploaded.file_info},msg_id:event.id,msg_seq:msgSeq,
      ...(event.group_openid&&validId(referenceId)?{message_reference:{message_id:referenceId}}:{})},true,isCurrent).then(sentReceipt);
  }
  async proactive(groupOpenid, content, { isCurrent = () => true } = {}) {
    if (!groupOpenid || !content?.trim()) throw new Error('qq_invalid_proactive_target');
    if (!isCurrent()) throw new Error('proactive_stale');
    return this.api(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, 'POST', { content: textWithMentions(content.trim()), msg_type: 0 }).then(sentReceipt);
  }
  async proactiveImage(groupOpenid, preparedImage, { isCurrent = () => true } = {}) {
    if (!validId(groupOpenid)) throw new Error('qq_invalid_proactive_target');
    const image=inspectImage(preparedImage?.buffer,preparedImage?.mime,{allowExtended:true});
    const target=`/v2/groups/${encodeURIComponent(groupOpenid)}`;
    if (!isCurrent()) throw new Error('proactive_stale');
    const uploaded=await this.api(`${target}/files`,'POST',{file_type:1,file_data:image.buffer.toString('base64'),file_name:image.fileName,srv_send_msg:false});
    if(typeof uploaded.file_info!=='string'||!uploaded.file_info||uploaded.file_info.length>65536)throw Error('qq_invalid_media_upload');
    if (!isCurrent()) throw new Error('proactive_stale');
    return this.api(`${target}/messages`,'POST',{msg_type:7,media:{file_info:uploaded.file_info}}).then(sentReceipt);
  }
  async proactiveVoice(groupOpenid, preparedVoice, { isCurrent = () => true } = {}) {
    if (!validId(groupOpenid)) throw new Error('qq_invalid_proactive_target');
    const voice=inspectVoice(preparedVoice?.buffer),target=`/v2/groups/${encodeURIComponent(groupOpenid)}`;
    if (!isCurrent()) throw new Error('proactive_stale');
    const uploaded=await this.api(`${target}/files`,'POST',{file_type:3,file_data:voice.buffer.toString('base64'),file_name:voice.fileName,srv_send_msg:false});
    if(typeof uploaded.file_info!=='string'||!uploaded.file_info||uploaded.file_info.length>65536)throw Error('qq_invalid_media_upload');
    if (!isCurrent()) throw new Error('proactive_stale');
    return this.api(`${target}/messages`,'POST',{msg_type:7,media:{file_info:uploaded.file_info}}).then(sentReceipt);
  }
  async groupMembers(groupOpenid,{cursor=''}={}) {
    if(!validId(groupOpenid)||typeof cursor!=='string'||cursor.length>4096)throw Error('qq_invalid_group_query');
    return this.api(`/v2/groups/${encodeURIComponent(groupOpenid)}/members${cursor?'?cursor='+encodeURIComponent(cursor):''}`);
  }
  async groupBotState(groupOpenid) {
    if(!validId(groupOpenid))throw Error('qq_invalid_group_query');
    return this.api(`/v2/groups/${encodeURIComponent(groupOpenid)}/bot_state`);
  }
  stop() { this.stopped = true; this.connected = false; clearInterval(this.heartbeat); clearTimeout(this.reconnectTimer); clearTimeout(this.handshakeTimer); this.ws?.close(); }
  async run(onMessage) {
    let delay = 2000;
    while (!this.stopped) {
      try {
        const token = await this.accessToken();
        const gateway = await this.api('/gateway/bot');
        if (!gateway.url?.startsWith('wss://')) throw new Error('invalid_gateway');
        await new Promise((resolve) => {
          const ws = this.ws = new WebSocket(gateway.url, { handshakeTimeout: 15000, maxPayload: 2 * 1024 * 1024, ...(this.webSocketAgent ? {agent:this.webSocketAgent} : {}) });
          let acknowledged = true;
          const send = payload => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
          this.handshakeTimer = setTimeout(() => ws.terminate(), 20000);
          ws.on('message', raw => {
            let event; try { event = JSON.parse(raw.toString()); } catch { return; }
            if (event.s !== undefined && event.s !== null) this.seq = event.s;
            if (event.op === 10) {
              const heartbeatInterval = Number(event.d?.heartbeat_interval);
              if (!Number.isFinite(heartbeatInterval) || heartbeatInterval < 1000) return ws.terminate();
              if (this.session) send({ op: 6, d: { token: `QQBot ${token}`, session_id: this.session, seq: this.seq } });
              else send({ op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] } });
              clearInterval(this.heartbeat);
              this.heartbeat = setInterval(() => {
                if (!acknowledged) return ws.terminate();
                acknowledged = false; send({ op: 1, d: this.seq });
              }, heartbeatInterval);
            } else if (event.op === 11) acknowledged = true;
            else if (event.op === 1) send({ op: 1, d: this.seq });
            else if (event.op === 7) ws.close();
            else if (event.op === 9) { this.session = null; this.seq = null; ws.close(); }
            else if (event.op === 0 && (event.t === 'READY' || event.t === 'RESUMED')) {
              this.connected = true;
              clearTimeout(this.handshakeTimer); delay = 2000;
              if (event.d?.session_id) this.session = event.d.session_id;
              if (event.t === 'READY' || event.d?.user) this.selfIds = new Set(userIds(event.d?.user));
              this.log('QQ 已连接，等待单聊和群聊消息。');
            } else if (event.op === 0 && ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(event.t)) {
              const isGroup = event.t !== 'C2C_MESSAGE_CREATE';
              if (isGroup && !event.d?.group_openid) return;
              const mentions = isGroup ? groupMentions(event.d, event.t, this.selfIds) : { explicit_mention: false };
              const selfAuthor = userIds(event.d?.author).some(id => this.selfIds.has(id));
              this.log(isGroup ? (mentions.explicit_mention ? '收到 QQ 群聊 @ 消息。' : '收到 QQ 群聊普通消息。') : '收到 QQ 单聊消息。');
              Promise.resolve(onMessage({ ...event.d, chat_type: isGroup ? 'group' : 'private', event_type: event.t, ...mentions,
                ...(selfAuthor ? { is_self: true } : {}) })).catch(() => this.log('消息处理失败，请检查本机配置或重发消息。'));
            }
          });
          ws.on('error', () => {});
          ws.on('close', code => {
            this.connected = false;
            clearInterval(this.heartbeat); clearTimeout(this.handshakeTimer);
            if ([4006, 4007].includes(code)) { this.session = null; this.seq = null; }
            if ([4004, 4013, 4014].includes(code)) { this.token = null; this.session = null; }
            this.log(`QQ 连接断开（${code}），准备重连。`); resolve();
          });
        });
      } catch (error) { this.log(`连接失败：${error.message.startsWith('qq_') ? error.message : '网络或网关暂不可用'}`); }
      if (!this.stopped) await new Promise(resolve => { this.reconnectTimer = setTimeout(resolve, delay); });
      delay = Math.min(delay * 2, 60000);
    }
  }
}
