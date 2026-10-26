import {RuntimeScopeGuard,RUNTIME_AUTHORIZATION,applyRuntimeConfig,eventForMemoryCapture} from './runtime_scope.mjs';
import {inspectRuntimeCapabilities,ttsCapability,ttsResidentStatus,requireTTS,effectiveRole,prepareRuntimeInput} from './runtime_policy.mjs';
import {createOwnerBrowserWorker} from './owner_browser_worker.mjs';
import {loadEnv,openPublicConfig,isEventAllowed} from './public_config.mjs';
import {loadExtensions,wrapGenerate} from './extensions.mjs';
import {loadCharacter,characterSummary,characterRequest} from './character.mjs';
import {CharacterGrowth} from './character_growth.mjs';
import {synthesizeSpeech,speechRequest,verifyPreparedSpeech,isPreparedSpeechCurrent} from './speech.mjs';
import {deliverProactiveSpeech} from './proactive_speech.mjs';
import {SpeechJobs} from './speech_jobs.mjs';
import {planReplySpeech,speechReplyDeadline} from './reply_speech_route.mjs';
import {speechEngine,stopSpeech} from './qwen_speech.mjs';
import {replySpeechFallback,deliverReplyVoice} from './speech_capability.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, open, unlink, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { readJson, Companion } from './core.mjs';
import { MemoryCapture } from './memory_capture.mjs';
import { recordInteractionLatency } from './interaction_latency.mjs';
import { generator, chatGenerator, visualReviewer } from './model_client.mjs';
import { QQClient } from './qq.mjs';
import { createQQNetworkTransport } from './network_transport.mjs';
import { ProactiveCompanion } from './proactive.mjs';
import { GroupRouter } from './routing.mjs';
import { GroupInbox, OrderedGroupDispatch } from './inbox.mjs';
import { MediaLibrary } from './media.mjs';
import { observedContent, referenceForObservation } from './conversation_input.mjs';
import { deliveryPlan } from './delivery_plan.mjs';
import { StickerCreation } from './sticker_creation.mjs';
import { createImage } from './image_worker.mjs';
import { createImageVisualReviewer } from './image_visual_review.mjs';
import { rankStickerCatalog } from './sticker_actions.mjs';
import { VoiceLibrary } from './voice_library.mjs';
import { resolveReplyReference } from './reply_targets.mjs';
import { readConversationContext } from './conversation_context.mjs';
import { createRuntimeTelemetry } from './runtime_telemetry.mjs';
import { RuntimeLog } from './runtime_log.mjs';
import { startLocalConsole } from './local_console.mjs';
import { openChatSettings, explicitlyRequestsMedia } from './chat_settings.mjs';
import { VocabularyLearning } from './vocabulary_learning.mjs';
import { VocabularyResearch } from './vocabulary_research.mjs';
import { OwnerWorkQueue } from './owner_work.mjs';
import { OwnerBrowserService } from './owner_browser_service.mjs';
import { ownerBrowserNotifier } from './owner_browser_delivery.mjs';
import { GroupDirectory } from './group_directory.mjs';
import { MentionDirectory } from './recipient_resolver.mjs';
import { renderMathReply } from './math_render.mjs';
import { MathReplies, isMathContinuation } from './math_reply.mjs';
import { ChannelService,channelCli } from './channel_service.mjs';
import { ChannelMedia } from './channel_media.mjs';
import { isMathLayoutRequest } from './math_document.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, 'temp'), { recursive: true });
await loadEnv(root);
const configStore=await openPublicConfig(root);
const config=configStore.get();
if(process.env.QQ_APP_ID)config.appId=process.env.QQ_APP_ID;
const extensions=await loadExtensions({root,paths:config.plugins,config});
const scopeAccess=new RuntimeScopeGuard(()=>config);
const generate=scopeAccess.wrapGenerator(wrapGenerate(generator(root,config),extensions));
const observedTopics = async () => (await readJson(join(root, 'topics.json'), { sources: [] })).sources || [];
const generateChat = scopeAccess.wrapGenerator(wrapGenerate(chatGenerator(root, config),extensions));
if (process.argv.includes('--check')) {
  const answer = await generate({ history: [], memory: [], text: '你好，用一句话介绍一下你自己。' });
  console.log('CODEX_OK: ' + answer); process.exit(0);
}
if (process.argv.includes('--chat')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history = [];
  try {
    while (true) {
      const text = await rl.question('你 > ');
      if (text === '/quit') break;
      const answer = await generate({ history, memory: [], text }); console.log('小柯 > ' + answer);
      history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
      if (history.length > 40) history.splice(0, history.length - 40);
    }
  } finally { rl.close(); }
  process.exit(0);
}
if (!process.env.QQ_APP_SECRET || !config.appId || !config.pairingHash) {
  console.error('配置尚未完成：先运行 npm run init，将 QQ 官方 AppID/AppSecret 和配对口令填入 .env，再运行 npm run doctor。'); process.exit(1);
}
const lockPath = join(root, 'temp', 'bridge.lock');
let lock;
try {
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const oldPid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(oldPid) || oldPid <= 0) throw new Error('invalid_lock');
    try { process.kill(oldPid, 0); throw new Error('already_running'); }
    catch (probeError) {
      if (probeError.code !== 'ESRCH') throw probeError;
      await unlink(lockPath);
      lock = await open(lockPath, 'wx');
    }
  }
  await lock.writeFile(String(process.pid));
} catch { console.error('已有实例或锁状态异常，无法启动第二个实例。'); process.exit(1); }
const logs = await RuntimeLog.open({ root, maxBytes: 512 * 1024, retain: 3 });
const log = message => { void logs.info(message).catch(() => {}); };
const warn = message => { void logs.warn(message).catch(() => {}); };
const settings = await openChatSettings({ root });
const vocabulary = await new VocabularyLearning({ dataDir: join(root, 'data'), now: Date.now }).init();
const qqNetwork = createQQNetworkTransport(config.proxy);
const client = new QQClient(config.appId, process.env.QQ_APP_SECRET, { log, fetcher:scopeAccess.fetcher(qqNetwork.fetcher), webSocketAgent:qqNetwork.webSocketAgent });
delete process.env.QQ_APP_SECRET;
const directory = await GroupDirectory.open({ root, client });
const mentionDirectory = new MentionDirectory();
const telemetry = createRuntimeTelemetry({ root, version: '1.0.0' });
const writeRuntimeStatus = () => telemetry.writeStatus({ connected: client.connected === true, pid: process.pid }).catch(() => warn('运行状态记录暂未保存。'));
await writeRuntimeStatus();
const statusTimer = setInterval(() => void writeRuntimeStatus(), 15000); statusTimer.unref();
const media = await MediaLibrary.open({ root });
const voices = await VoiceLibrary.open({ root });
const voiceLastSent = new Map();
const speech = speechEngine(root,{isEnabled:()=>config.media.tts===true});
const speechControlTimer=setInterval(()=>speech.applyResourceControl(),2000);speechControlTimer.unref();
if(config.media.tts)void speech.warm().then(()=>log('共享语音状态已检查。')).catch(()=>warn('语音暂不可用，聊天继续用文字。'));
const mathReplies = await MathReplies.open({ root, render: renderMathReply });
const creation = await new StickerCreation({ root, config, media, createImage:scopeAccess.wrapGenerator(createImage),
  visualReview: createImageVisualReviewer({ reviewVision: scopeAccess.wrapGenerator(visualReviewer(root, config)) }),
  log: message => log(message)
}).init();
let companion;
let memoryCapture;
let ownerBrowser;
const characterGrowth = await CharacterGrowth.open({dataDir:join(root,'data')});
try { memoryCapture = await MemoryCapture.open({ dataDir: join(root, 'data'),
  extract: input => scopeAccess.withEvent(eventForMemoryCapture(input,config,companion?.state.owner),()=>generate(input)), isBusy: () => !companion || companion.pending > 0,
  onError: () => warn('记忆整理暂未完成，原有已保存记忆仍可读取。') }); }
catch { warn('记忆文件未通过读取校验，已保留原文件；聊天继续，长期记忆暂不可用，不启用旧字符串回退。'); }
companion = await new Companion({ dataDir: join(root, 'data'), pairingHash: config.pairingHash, memoryCapture, memoryCaptureRequired: true, characterGrowth,
  progressDelayMs: 0,
  onMemoryError: () => warn('本轮记忆保存失败，聊天继续。'),
  onTiming: record => recordInteractionLatency(root, record),
  prepareInput: async event => {
    const started = Date.now();
    await media.refreshApproved();
    const input = await prepareRuntimeInput({media,event,roomHistory:event.group_openid?companion.groupContext(event.group_openid):[],getConfig:()=>config});
    try{
    scopeAccess.assert();
    input.mediaCatalog = rankStickerCatalog(input.mediaCatalog, event,
      {roomMessages:event.group_openid?companion.groupContext(event.group_openid):[]});
    await voices.refresh(); input.voiceCatalog = voices.catalog();
    input.speechStatus = ttsCapability(config,speech);
    input.conversationContext = await readConversationContext({ event,
      getRoomHistory: group => companion.groupContext(group), getRoomMemory: group => companion.groupMemory(group),
      role: await effectiveRole(root,config)
    });
    // Bodies already occur in room_messages; this projection is just an index.
    if (input.conversationContext.own_recent_messages) input.conversationContext.own_recent_messages = input.conversationContext.own_recent_messages.map(({ content, ...item }) => item);
    if (event.group_openid) input.conversationContext.directory = directory.context(event.group_openid);
    input.chatSettings = {...settings.get(),style:config.character.style};
    if (!event.group_openid) {
      input.ownerBrowserContext = await ownerBrowser?.context(event) || [];
      const status = ownerBrowser?.status();
      input.ownerBrowserStatus = status ? { configured: status.configured, enabled: status.enabled,
        loginWindowOpen: status.loginWindowOpen, authentication: status.authentication } : { configured: false };
    }
    input.socialState = event.group_openid ? social.context(event.group_openid) : {};
    input.vocabulary = event.group_openid ? vocabulary.context(event.group_openid, { query: event.content, limit: 8 })
      .map(({ id, term, status, meaning, confirmedBy, web_evidence }) => ({ id, term, status, meaning, confirmedBy,
        web_evidence: (web_evidence || []).slice(-1).map(report => ({ meaning: report.meaning, sources: report.sources })) })) : [];
    if (input.visionFiles.length || input.mediaErrors.length || input.quotes.length) {
      const receivedImages = input.visionFiles.filter(file => input.mediaCatalog.some(item => item.id === file.id && item.source !== 'approved')).length;
      const dimensions = input.visionFiles.map(file => `${file.width || '?'}x${file.height || '?'}`).join(',');
      log(`图片准备：加载 ${input.visionFiles.length} 张，其中聊天图片 ${receivedImages} 张，尺寸 ${dimensions || '无'}，引用 ${input.quotes.length} 条，未加载 ${input.mediaErrors.length} 张，用时 ${Date.now()-started}ms。`);
    }
    return input;
    }catch(error){await media.releaseVisionFiles(input.visionFiles||[]).catch(()=>warn('临时图片清理未完成。'));throw error;}
  },
  releaseInput: input => media.releaseVisionFiles(input?.visionFiles || []).catch(() => warn('临时图片清理未完成。')),
  generate: async input => generateChat({ ...input, backgroundMemory: Boolean(memoryCapture), chatSettings: {...settings.get(),style:config.character.style}, topics: await observedTopics(), speechStatus: ttsCapability(config,speech) })
}).init();
const speechJobs = await SpeechJobs.open({dataDir:join(root,'data'),
  synthesize:(text,options)=>{requireTTS(config);return synthesizeSpeech(root,text,options);},
  verifyPrepared:(prepared,options)=>verifyPreparedSpeech(root,prepared,options),
  onError:()=>warn('语音任务记录暂未完成，未重发结果。')});
const cancelSpeechForControl = event => {
  if(!companion.canReply(event))return;
  const text=String(event.content||'').trim();
  if(!['/forget','/reset'].includes(text)&&!/^\/quiet(?:\s|$)/i.test(text)&&! /^(?:小柯[，,\s]*)?安静一会儿[。！!～~]?$/.test(text))return;
  companion.invalidateDeliveries(event);
  void speechJobs.invalidate(event).catch(()=>warn('语音任务已取消，取消记录暂未保存。'));
};
const stopSpeechJobs = () => speechJobs.stop().catch(()=>warn('语音任务已停止，结束记录暂未保存。'));
const ownerWork = await OwnerWorkQueue.open({ root, getOwner: () => companion.state.owner,
  generateProposal: input => generate({ ...input, mode: 'owner_work', structured: true }), log });
ownerBrowser = await OwnerBrowserService.open({ root, config, runWorker:scopeAccess.wrapGenerator(createOwnerBrowserWorker()), getOwner: () => companion.state.owner,
  enabled: () => settings.get().allowWebSearch !== false }).catch(() => {
    warn('浏览任务记录暂未通过加载校验，聊天继续，原记录保留。');
    return { status: () => ({ configured: false, enabled: false, authentication: 'unavailable', jobs: [] }),
      context: async () => '', handle: async (_event, text) => /^\/(browse|browsestatus|browsecancel)(?:\s|$)/i.test(text.trim())
        ? { handled: true, reply: '浏览这边暂时没准备好，先接着聊。' } : { handled: false },
      openLogin: async () => { throw Error('owner_browser_unavailable'); }, closeLogin: async () => ({}),
      ownerChanged: async () => {}, forget: async () => {}, stop: async () => {} };
  });
const channelMedia = new ChannelMedia({root,getCatalog:event=>media.contextFor(event).images,prepare:(...args)=>media.prepare(...args)});
const channels = await new ChannelService({ root, generate, run:(args,options={})=>scopeAccess.run(options,input=>channelCli(root,args,input)), getOwner: () => companion.state.owner, media:channelMedia }).init();
const router = new GroupRouter({ decideWithReply: true, ambientParticipation: true, aliases:()=>config.character.aliases });
const inbox = new GroupInbox({ handle: event => processMessage(event), batchParticipants: true, coalesceWhileBusy: true, delayMs: 350, gapMs: 0 });
const orderedDispatch = new OrderedGroupDispatch();
const routeTasks = new Set();
if (memoryCapture) memoryCapture.isBusy = () => companion.pending > 0 || inbox.pending > 0 || routeTasks.size > 0;
const queueNotices = new Map();
const social = await new ProactiveCompanion({
  dataDir: join(root, 'data'),
  getAuthorization:group=>scopeAccess.issue({group_openid:group}),
  generate: async input => scopeAccess.withAuthorization(input.runtimeAuthorization,async()=>generate({ ...input, structured: true, chatSettings: {...settings.get(),style:config.character.style}, topics: [...(input.topics || []), ...await observedTopics()] })),
  send: async (groupOpenid, text, { mediaId, voiceId, speech: spoken, isCurrent = () => true, authorization } = {}) => scopeAccess.withAuthorization(authorization,async()=>{
    if (!settings.get().proactiveEnabled || !isEventAllowed(config,{group_openid:groupOpenid})) throw Error('proactive_disabled');
    if (!isCurrent()) throw Error('proactive_stale');
    const event = { group_openid: groupOpenid, chat_type: 'group' };
    let delivery, actual = text;
    // One proactive opportunity sends only one item; there is no partial
    // picture+caption retry that could duplicate a successfully sent image.
    if (mediaId) {
      if (!settings.get().spontaneousStickers) throw Error('proactive_media_disabled');
      const selected = media.contextFor(event).images.find(item => item.id === mediaId);
      if (!selected || selected.type !== 'sticker') throw Error('proactive_media_rejected');
      const prepared = await media.prepare(event, mediaId, { original: true });
      if (!settings.get().proactiveEnabled || !settings.get().spontaneousStickers) throw Error('proactive_disabled');
      if (!isCurrent()) throw Error('proactive_stale');
      delivery = await client.proactiveImage(groupOpenid, prepared, { isCurrent }); actual = '[发送图片：' + (selected.title || selected.label || '表情') + ']';
      if (delivery?.id && isCurrent()) await media.markUsed(event, mediaId, { messageId: delivery.id }).catch(() => warn('图片已发送，使用记录暂未保存。'));
    } else if (voiceId) {
      if (!settings.get().spontaneousStickers) throw Error('proactive_media_disabled');
      const prepared = await voices.prepare(voiceId);
      if (!settings.get().proactiveEnabled || !settings.get().spontaneousStickers) throw Error('proactive_disabled');
      if (!isCurrent()) throw Error('proactive_stale');
      delivery = await client.proactiveVoice(groupOpenid, prepared, { isCurrent }); actual = '[发送语音：' + (prepared.label || '已批准语音') + ']';
    } else if (spoken?.text) {
      ({ delivery, actual } = await deliverProactiveSpeech({ group: groupOpenid, text, spoken, isCurrent,
        status: () => ttsResidentStatus(config,speech), settings: () => settings.get(), lastSent: voiceLastSent,
        synthesize: content => {requireTTS(config);return synthesizeSpeech(root, content);},
        verifyPrepared: prepared => verifyPreparedSpeech(root, prepared),
        sendVoice: (group, prepared) => client.proactiveVoice(group, prepared,
          { isCurrent: () => config.media.tts===true && isCurrent() && isPreparedSpeechCurrent(root, prepared) }),
        sendText: (group, content) => client.proactive(group, content, { isCurrent }) }));
    } else delivery = await client.proactive(groupOpenid, text, { isCurrent });
    if (isCurrent()) await companion.recordGroupAssistant(groupOpenid, actual,
      { messageId: delivery?.id, referenceId: delivery?.ext_info?.ref_idx })
      .catch(() => warn('主动消息已发送，聊天记录暂未保存。'));
    log('群聊主动消息已被 QQ 接受。');
    return { sent_text: actual, delivered_messages: [{ content: actual, messageId: delivery?.id }] };
  }),
  getRoomHistory: groupOpenid => companion.groupContext(groupOpenid),
  getRoomMemory: groupOpenid => companion.groupMemory(groupOpenid),
  getRoomExpression: groupOpenid => companion.groupExpression(groupOpenid),
  setRoomExpression: (groupOpenid, expression, isCurrent) => companion.setGroupExpression(groupOpenid, expression, isCurrent),
  characterGrowth,
  getSpeechStatus: groupOpenid => ({ ...ttsResidentStatus(config,speech), enabled: config.media.tts===true && settings.get().spontaneousStickers,
    lastSentAt: voiceLastSent.get(groupOpenid) || 0 }),
  getMediaCatalog: async group => {
    if (!settings.get().spontaneousStickers) return [];
    await media.refreshApproved(); return media.contextFor({ group_openid: group }).images.filter(item => item.type === 'sticker');
  },
  getVoiceCatalog: async () => { if (!settings.get().spontaneousStickers) return []; await voices.refresh(); return voices.catalog(); },
  isBusy: () => !settings.get().proactiveEnabled || companion.pending > 0 || inbox.pending > 0 || routeTasks.size > 0,
  isContextBlocked: groupOpenid => !isEventAllowed(config,{group_openid:groupOpenid}) || companion.personalMemoryBridge.blocksRoom(groupOpenid),
  log: message => log(message)
}).init();
const research = new VocabularyResearch({ learning: vocabulary, getAuthorization:event=>scopeAccess.issue(event), generate: input => scopeAccess.withAuthorization(input.runtimeAuthorization,()=>generate({ ...input, chatSettings: settings.get() })),
  enabled: () => settings.get().allowWebSearch, isBusy: () => companion.pending > 0 || inbox.pending > 0 || routeTasks.size > 0, log });
research.start();
let localConsole;
try {
  localConsole = await startLocalConsole({ root, port:config.consolePort, callbacks: {
    status: () => telemetry.writeStatus({ connected: client.connected === true, pid: process.pid }),
    feedback: () => readJson(join(root, 'data', 'feedback.json'), []),
    settings: () => settings.get(), updateSettings: body => settings.update(body),
    publicConfig:()=>configStore.get(),
    updatePublicConfig:async body=>{if('plugins' in body)throw Error('plugins_require_restart');const next=await applyRuntimeConfig({store:configStore,config,patch:body,guard:scopeAccess,inbox,social,onScopeChanged:async()=>{research.clearPending();await memoryCapture?.cancelPending();},onRevoked:async event=>{companion.invalidateDeliveries(event);await speechJobs.invalidate(event).catch(()=>{});}});speech.applyResourceControl();if(next.participation.mode==='active')social.start();else social.stop();return {ok:true};},
    capabilities:async()=>{const runtime=await inspectRuntimeCapabilities(root,config);return {official_qq_transport:true,character_card:true,web_search:config.modelProvider.type==='codex'&&settings.get().allowWebSearch,vision:runtime.vision.available,asr:config.media.asr&&extensions.supports('asr'),tts:ttsCapability(config,speech).available,native_image_generation:runtime.image_generation.available,runtime,plugins:extensions.ids};},
    groups: () => { const lookup = new Map(directory.snapshot().map(row => [row.scope, row])); return social.snapshot().map(row => ({ ...row, directory: lookup.get(row.scope) || { status: 'not_queried' } })); },
    groupAction: (scope, action) => social.control(scope, action),
    vocabulary: () => vocabulary.snapshot(), reviewVocabulary: (scope, id, options) => vocabulary.review(scope, id, options),
    channelJobs: () => channels.jobs.size, ownerJobs: () => ownerWork.snapshot(), logs: () => logs.summary({ limit: 12 }),
    browserStatus: () => ownerBrowser.status(),
    browserAction: action => action === 'open_login' ? ownerBrowser.openLogin() : ownerBrowser.closeLogin({ confirmed: action === 'confirm_login' }),
    speechStatus: () => ttsResidentStatus(config,speech), memoryStatus: () => ({...(memoryCapture?.status() || {enabled:false,lastError:'memory_capture_unavailable'}),
      legacyCounts:{scope:'legacy_conversation_store_not_deduplicated_with_background',privateFacts:companion.state.memory?.length||0,
        groupFacts:Object.values(companion.state.groups||{}).reduce((n,g)=>n+(g.memory?.length||0),0),
        groupConversation:Object.values(companion.state.rooms||{}).reduce((n,r)=>n+(r.memory?.length||0),0)}})
  } });
  log('本机控制台已启动。');
} catch { warn('本机控制台暂未启动，QQ聊天继续运行。'); }
const cleanup = async () => { clearInterval(statusTimer); clearInterval(speechControlTimer); await stopSpeechJobs(); stopSpeech(root); research.stop(); directory.stop(); await ownerWork.stop(); await ownerBrowser.stop(); creation.stop(); social.stop(); await channels.stop(); await memoryCapture?.close(); client.stop(); await localConsole?.close(); await writeRuntimeStatus(); await logs.flush(); await lock.close(); await unlink(lockPath).catch(() => {}); process.exit(0); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
log('小柯 QQ 桥接启动。关闭这个窗口会下线；按 Ctrl+C 可正常退出。');
log(companion.state.owner ? '已绑定主人，等待消息。' : '请在 QQ 单聊发送设置窗口显示的 /pair 配对码。');
try { await client.accessToken(); log('QQ 凭据校验通过。'); }
catch (error) {
  warn('QQ 凭据校验失败：' + error.message);
  warn('100016 表示 AppID/AppSecret 不匹配。请在本机 Setup.cmd 更新真实 AppSecret；无需重置或分享密钥。');
  clearInterval(statusTimer); clearInterval(speechControlTimer); await stopSpeechJobs(); stopSpeech(root); await writeRuntimeStatus(); await lock.close(); await unlink(lockPath).catch(() => {}); process.exit(1);
}
async function processMessage(event){try{return await scopeAccess.withEvent(event,()=>processAuthorizedMessage(event));}catch(error){if(error.code==='scope_revoked')return {status:'cancelled',reason:'scope_revoked'};throw error;}}
async function processAuthorizedMessage(event) {
  const authorization=scopeAccess.assert();
  cancelSpeechForControl(event);
  const deliveryEpoch=companion.deliveryEpoch(event);
  let sequence = 0;
  const processingAt = Date.now();
  let firstSentAt = 0;
  const eventTime = Date.parse(event.timestamp || '');
  const receivedAt = Math.min(event._receivedAt || Date.now(), Number.isFinite(eventTime) ? eventTime : Infinity);
  const expired = () => Date.now() - receivedAt >= (event.group_openid ? 270000 : 3540000);
  scopeAccess.assert(authorization,event);
  if (expired()) return { status: 'expired' };
  if (event.turn_messages?.length > 1) {
    const members = new Set(event.turn_messages.map(message => message.author?.member_openid));
    log(`群聊共同回合：${members.size} 位成员，${event.turn_messages.length} 条消息。`);
  }
  const deliverNow = async (content, options = {}) => {
    scopeAccess.assert(authorization,event);
    if (expired()) throw new Error('group_reply_expired');
    if (!settings.get().spontaneousStickers && !options.creationJobKey && !explicitlyRequestsMedia(event)
      && (options.media?.send_id || options.media?.voice_id)) {
      options = { ...options, media: { ...options.media, send_id: '', voice_id: '' } };
      if (!String(content || '').trim()) content = '嗯，我在听。';
    }
    let delivery;
    const referenceId = resolveReplyReference(event, event.group_openid ? companion.groupContext(event.group_openid) : [], options.delivery?.reply_to_message_id);
    const mentions = mentionDirectory.resolve(event, options.delivery?.mention_speakers || []);
    const receipts = [];
    const members = (event.turn_messages?.length ? event.turn_messages : [event]).map(item => item.author?.member_openid || item.author?.id).filter(Boolean);
    const recipients = event.group_openid ? [...new Set(members)].map(member => companion.groupSpeaker(event.group_openid, member)) : [];
    const record = async (content, result) => {
      firstSentAt ||= Date.now();
      const receipt = { content, messageId:result?.id || result?.body?.id,
        referenceId:result?.ext_info?.ref_idx ?? result?.body?.ext_info?.ref_idx };
      receipts.push(receipt);
      if (event.group_openid) await companion.recordGroupAssistant(event.group_openid, content,
        { ...receipt, originId:event.id, speaker:recipients.at(-1), speakers:recipients });
    };
    if (options.math_document || options.math_continue) {
      if (options.math_document) await mathReplies.prepare(event, options.math_document, content);
      const result = await mathReplies.deliver(event, {
        remaining: () => (event.group_openid ? 5 : 4) - sequence,
        sendImage: async (image, description) => {
          if (expired()) throw Error('group_reply_expired');
          const nextSequence = ++sequence;
          const sent = await client.replyImage(event, image, nextSequence, { referenceId });
          await record(description, sent).catch(() => warn('数学图片已发送，聊天记录暂未保存。')); return sent;
        },
        sendText: async text => {
          if (expired()) throw Error('group_reply_expired');
          const nextSequence = ++sequence;
          const sent = await client.reply(event, text, nextSequence, { referenceId, mentions: receipts.length === 0 ? mentions : [] });
          await record(text, sent).catch(() => warn('数学文字已发送，聊天记录暂未保存。')); return sent;
        }
      });
      if (result.expired) throw Error('group_reply_expired');
      if (result.empty) throw Object.assign(Error('math_forgotten'), { code: 'math_forgotten' });
      if (!receipts.length && !result.duplicate) throw Error('math_delivery_unconfirmed');
      log('数学解答分页交付已处理。');
      return { ...result, delivered_messages: receipts };
    }
    const voiceKey=event.group_openid||event.author?.user_openid||event.author?.id;
    // Dynamic speech is owned by SpeechJobs below. This transport queue only
    // sends prepared media/text and never waits for model generation.
    if(!String(content||'').trim()&&options.speech?.text)content=options.speech.text;
    const mediaCount = Number(!!options.media?.send_id) + Number(!!options.media?.voice_id);
    // Extra media consumes a slot before the shared text/image budget is planned.
    let parts = deliveryPlan(content, { messages:options.messages, image:mediaCount > 0, used:sequence + Math.max(0, mediaCount - 1), limit: event.group_openid ? 5 : 4 }).texts;
    const picture = options.media?.send_id ? await media.prepare(event, options.media.send_id, { original: true }) : null;
    const voice = options.media?.voice_id ? await voices.prepare(options.media.voice_id) : null;
    if (options.media?.collect_id) {
      try {
       const saved=await media.collect(event, options.media.collect_id, options.media.label||options.media.note, options.media.remember_sticker?{type:'sticker',tags:options.media.tags,title:options.media.label||'收藏的表情'}:{});
       if(options.media.note)await media.note(event,saved.id,{note:options.media.note,tags:options.media.tags,usage:options.media.usage});
       log('本会话图片已收藏。');
      }catch{warn('表情收藏暂未完成。');}
    }
    if (picture) {
      if (expired()) throw new Error('group_reply_expired');
      delivery = await client.replyImage(event, picture, sequence + 1, { referenceId });
      sequence++;
      const label = media.contextFor(event).images.find(image => image.id === options.media.send_id)?.label || '图片';
      await record('[发送图片：' + label + ']', delivery);
      const imageReceiptId = delivery?.id || delivery?.body?.id;
      if (imageReceiptId) await media.markUsed(event, options.media.send_id, { messageId: imageReceiptId }).catch(() => warn('图片已发送，使用记录暂未保存。'));
      if (options.creationJobKey) await creation.confirmDelivered(event, options.creationJobKey);
      log('QQ 图片回复已发送。');
    }
    if (voice) {
      if (expired()) throw new Error('group_reply_expired');
      const voiceResult=await deliverReplyVoice({
        sendVoice:()=>client.replyVoice(event,voice,++sequence,{referenceId}),
        onCancelled:error=>replySpeechFallback({content,text:voice.label,requested:speechRequest(event),state:ttsCapability(config,speech),
          deliveryFailed:error.message!=='qq_voice_cancelled_before_send'})
      });
      if(voiceResult.cancelled){
        sequence--; // The transport proved that /messages was never called.
        const fallback=voiceResult.fallback;
        parts=deliveryPlan(fallback.content,{messages:fallback.replaceMessages?[]:options.messages,used:sequence,limit:event.group_openid?5:4}).texts;
      }
      const voiceDelivery=voiceResult.delivery;if(voiceDelivery)delivery=voiceDelivery;
      if(voiceDelivery?.id){voiceLastSent.set(voiceKey,Date.now());
      await record('[发送语音：' + (voice.label || '已批准语音') + ']', delivery).catch(()=>warn('语音已发送，聊天记录暂未保存。'));
      log('QQ 语音回复已发送。');}
    }
    for (const [index, part] of parts.entries()) {
      if (index > 0 || picture) await new Promise(resolve => setTimeout(resolve, Math.min(650, 200 + part.length * 4)));
      if (expired()) throw new Error('group_reply_expired');
      const nextSequence = sequence + 1;
      for (let attempt = 0; ; attempt++) {
        try { delivery = await client.reply(event, part, nextSequence, { referenceId, mentions: index === 0 ? mentions : [] }); break; }
        catch (error) {
          const retryable = error.name === 'TimeoutError' || error.name === 'TypeError' || /^qq_api_error_(429|5\d\d)$/.test(error.message);
          if (!retryable || attempt >= 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      sequence = nextSequence;
      await record(part, delivery);
    }
    if (options.media?.note_id) {
      await media.note(event, options.media.note_id, { note: options.media.note, tags: options.media.tags, usage: options.media.usage })
        .catch(() => warn('本会话图片备注暂未保存。'));
    }
    if(receipts.length)log(event.group_openid ? '群聊回复已发送。' : '单聊回复已发送。');
    return { ...delivery, sent_text:parts.join('\n\n'), delivered_messages:receipts };
  };
  // The worker may finish while another bubble is being sent for this message.
  // Serialize only QQ deliveries, never hold the normal chat queue during drawing.
  let deliveries = Promise.resolve();
  const serializeDelivery = callback => {
    const task = deliveries.catch(() => {}).then(callback);
    deliveries = task.catch(() => {}); return task;
  };
  const deliver = (content, options) => serializeDelivery(() => deliverNow(content, options));
  const deliverPending = () => creation.deliverPending(event, result => deliver(result.message,
    result.status === 'ready' ? { media: { send_id: result.id }, creationJobKey: result.jobKey } : {}));
  const sendPrepared = async (content, options = {}) => {
    if (options.feedback) await telemetry.feedback(options.feedback).catch(() => warn('技术反馈暂未保存。'));
    if (options.math_document) return deliver(content, options);
    if (!options.media?.create_prompt) {
      const voiceKey=event.group_openid||event.author?.user_openid||event.author?.id;
      const plan=planReplySpeech({event,content,options,capability:ttsCapability(config,speech),state:ttsResidentStatus(config,speech),
        settings:settings.get(),lastSentAt:voiceLastSent.get(voiceKey)||0});
      if(!plan.job)return deliver(plan.content,{...options,...(plan.replaceMessages?{messages:[]}:{} )});
      const speechExpiresAt=speechReplyDeadline(event);
      if(speechExpiresAt===null)return deliver(plan.content,{...options,messages:[]});
      const epoch=deliveryEpoch;
      const current=()=>scopeAccess.valid(authorization,event)&&config.media.tts===true&&!expired()&&companion.isDeliveryCurrent(event,epoch);
      const referenceId=resolveReplyReference(event,event.group_openid?companion.groupContext(event.group_openid):[],options.delivery?.reply_to_message_id);
      const guardedSend=(send,isCurrent)=>serializeDelivery(async()=>{
        if(!current()||!isCurrent()||sequence>=(event.group_openid?5:4))throw Object.assign(Error('speech_job_cancelled_before_send'),{messageNotSent:true});
        const seq=++sequence;
        try{const receipt=await send(seq,()=>current()&&isCurrent());firstSentAt ||= Date.now();return receipt;}
        catch(error){if(error?.messageNotSent===true)sequence--;throw error;}
      });
      try{return await speechJobs.execute(event,{...plan.job,expiresAt:speechExpiresAt},{
        isCurrent:current,
        sendVoice:(prepared,{isCurrent})=>guardedSend(async(seq,guard)=>{
          const receipt=await client.replyVoice(event,prepared,seq,{referenceId,
            isCurrent:()=>guard()&&ttsCapability(config,speech).available&&isPreparedSpeechCurrent(root,prepared)});
          if(receipt?.id)voiceLastSent.set(voiceKey,Date.now());return receipt;
        },isCurrent),
        sendText:(text,{isCurrent})=>guardedSend((seq,guard)=>client.reply(event,text,seq,{referenceId,isCurrent:guard}),isCurrent),
        recordDeferred:async(text,receipt,{isCurrent})=>{
          await companion.recordDeliveredAssistant(event,text,receipt,{epoch,guard:isCurrent});
          if(event.group_openid&&isCurrent())await social.markReplied(event.group_openid,{engaged:true});
        }
      });}catch(error){
        if(!current())return {deferredSpeech:{status:'cancelled'},sent_text:'',delivered_messages:[]};
        if(error?.messageNotSent!==true||!['speech_jobs_busy','speech_jobs_unavailable','speech_job_request_invalid'].includes(error?.code)){
          warn('语音任务结果未确认，未重发内容。');
          return {deferredSpeech:{status:'unconfirmed'},sent_text:'',delivered_messages:[]};
        }
        const fallback=replySpeechFallback({content,text:plan.job.text,requested:plan.job.requested,state:ttsCapability(config,speech)});
        return deliver(fallback.content,{...options,messages:fallback.replaceMessages?[]:options.messages});
      }
    }
    if (isMathLayoutRequest(event)) return deliver('公式解答应使用精确数学排版，这次未得到有效排版文档，先保留文字内容：\n\n' + content);
    if (!config.media.imageGeneration || !settings.get().allowImageCreation) return deliver('本机主人暂时关闭了新图片制作，可以继续聊天或使用现有表情。');
    const result = await creation.execute(event, options.media, { onComplete: async () => {
      if (expired()) return;
      if (await deliverPending() && event.group_openid) await social.markReplied(event.group_openid, {});
    } });
    // Replace speculative model completion language with the real workflow status.
    if (['ready', 'failed'].includes(result.status)) {
      let receipt;
      const delivered = await creation.deliverPending(event, pending => deliver(pending.message,
        pending.status === 'ready' ? { media: { send_id: pending.id }, creationJobKey: pending.jobKey } : {}).then(value => { receipt = value; }));
      return delivered ? receipt : deliver('上一张制作结果正在交付，没有重复制作。');
    }
    return deliver(result.message);
  };
  const send = async (content, options = {}) => {
    const result = await sendPrepared(content, options);
    if (event.group_openid && options.vocabulary_actions?.length) {
      await vocabulary.applyModelActions(event, options.vocabulary_actions).catch(() => warn('词义候选暂未保存。'));
    }
    return result;
  };
  try {
    if(companion.canReply(event)&&characterRequest(event.content)){await send(characterSummary(await loadCharacter(root))+'\n\n'+characterGrowth.summary(event));return {status:'character_card'};}
    const work = await ownerWork.handle(event, String(event.content || ''));
    if (work.handled) { if (companion.canReply(event) && work.reply) await send(work.reply); return { status: 'owner_work' }; }
    const browserWork = await ownerBrowser.handle(event, String(event.content || ''), { deferStart: true,
      notify: ownerBrowserNotifier({ serialize: serializeDelivery,
        current: () => !expired() && companion.isDeliveryCurrent(event, deliveryEpoch),
        remaining: () => 4 - sequence, nextSequence: () => ++sequence, rollbackSequence: () => --sequence,
        sendText: (text, seq, isCurrent) => client.reply(event, text, seq, { isCurrent }),
        record: (text, receipt, guard) => companion.recordDeliveredAssistant(event, text, receipt,
          { epoch: deliveryEpoch, guard }) }) });
    if (browserWork.handled) {
      try {
        const ack = companion.canReply(event) && browserWork.reply ? await send(browserWork.reply) : null;
        if (browserWork.created && browserWork.jobId) {
          if (ack?.id || ack?.body?.id) await ownerBrowser.activate(browserWork.jobId);
          else await ownerBrowser.cancel(browserWork.jobId);
        }
      } catch (error) { if (browserWork.created && browserWork.jobId) await ownerBrowser.cancel(browserWork.jobId); throw error; }
      return { status: 'owner_browser' };
    }
    if (companion.canReply(event) && ['/forget','/reset'].includes(String(event.content || '').trim())) {
      await creation.forget(event); await media.forget(event);
      await mathReplies.forget(event); await channels.forget(event);
      await ownerBrowser.forget(event);
      if (event.group_openid) { research.forget(event.group_openid); mentionDirectory.forget(event.group_openid); await vocabulary.forget(event.group_openid); }
    }
    if (companion.canReply(event) && channels.start(event, async text => {
      const result = await deliver(text);
      if (!event.group_openid) { companion.state.history.push({ role:'user', content:String(event.content || '') }, {role:'assistant',content:text}); companion.state.history=companion.state.history.slice(-40); await companion.persist(); }
      return result;
    })) return { status: 'channel_background' };
    if (companion.canReply(event) && isMathContinuation(event.content)) {
      if (mathReplies.pending(event)) await deliver('', { math_continue: true });
      else await deliver('当前没有待续发的公式页；如果想重新排版，可以把题目或完整解答再发给我。');
      if (event.group_openid) await social.markReplied(event.group_openid, { engaged: true });
      return { status: 'replied' };
    }
    const socialCommand = await social.observe(event, { addressed: event.allow_silence !== true || event.explicit_mention === true });
    if (socialCommand.handled) {
      if (socialCommand.reply) {
        const delivery = await send(socialCommand.reply);
        await companion.recordGroupAssistant(event.group_openid, socialCommand.reply, { messageId: delivery?.id, originId: event.id, referenceId: delivery?.ext_info?.ref_idx });
      }
      return;
    }
    if (companion.canReply(event) && !String(event.content || '').trim().startsWith('/')) {
      await deliverPending();
    }
    const oldOwner = companion.state.owner;
    const result = await companion.handle(event, send);
    if (companion.state.owner !== oldOwner) await ownerBrowser.ownerChanged();
    if (sequence && event.group_openid) await social.markReplied(event.group_openid, { social: result?.social, engaged: true });
    else if (result?.status === 'silent' && event.group_openid) await social.markObserved(event.group_openid, { social: result.social });
    return result;
  }
  catch (error) {
    if(!scopeAccess.valid(authorization,event))return {status:'cancelled',reason:'scope_revoked'};
    if (error.code === 'math_forgotten' || error.message === 'math_forgotten') return { status: 'canceled' };
    if (expired() || error.message === 'group_reply_expired') return { status: 'expired' };
    warn('处理失败：' + (error.message.match(/^(codex|qq)_[a-z0-9_]+$/) ? error.message : '本机处理异常'));
    if (!error.deliveryUncertain && companion.canReply(event) && sequence < (event.group_openid ? 5 : 4)) {
      const notice = /^(?:media_|qq_invalid_media)/.test(error.message) ? '这张图没读到，再发一下' : error.message === 'codex_timeout' ? '刚才那句等太久了，没生成出来' : /^codex_/.test(error.message) ? '刚才没回出来，再叫我一下' : '刚才没发出去，再叫我一下';
      await send(notice).catch(() => {});
    }
  } finally {
    if (event.group_openid) {
      const arrivals = (event.turn_messages?.length ? event.turn_messages : [event]).map(item => item._receivedAt).filter(Number.isFinite);
      const arrivedAt = arrivals.length ? Math.min(...arrivals) : receivedAt;
      log(`群聊耗时：进入处理前 ${Math.max(0,processingAt-arrivedAt)}ms，处理 ${Date.now()-processingAt}ms${firstSentAt ? `，首条送达 ${Math.max(0,firstSentAt-arrivedAt)}ms` : '，未发送'}。`);
    }
  }
}
if(config.participation.mode==='active')social.start();
async function handleIncoming(event) {
  if(!isEventAllowed(config,event))return;
  const named=config.character.aliases.some(alias=>String(event.content||'').includes(alias));
  if(event.group_openid&&config.participation.mode==='mentioned'&&event.explicit_mention!==true&&!named)return;
  event = { ...event, _receivedAt: Date.now() };
  if (!event.group_openid) {
    event = { ...event, content: observedContent(event) };
    cancelSpeechForControl(event);
    if (companion.canReply(event)) {
      if (['/forget', '/reset'].includes(String(event.content || '').trim())) await ownerBrowser.forget(event);
      media.observe(event);
      return media.flushRecent().catch(() => warn('近期图片索引暂未保存。')).then(() => processMessage(event));
    }
    return processMessage(event);
  }
  const key = event.group_openid;
  const before = companion.groupContext(key);
  if (event.is_self || event.author?.bot || before.some(item => item.role === 'assistant' && item.messageId === event.id)) return;
  mentionDirectory.observe(event);
  void directory.observe(event).catch(() => warn('群成员目录暂未刷新。'));
  media.observe(event);
  event = { ...event, content: observedContent(event), reference_id: referenceForObservation(event) };
  // Recognizable current-message controls cancel pending audio immediately;
  // disk observation and ordered semantic routing must not delay that guard.
  if(!event.mentions_other_members){
    const controlText=observedContent({...event,content:event.addressed_content??event.content})
      .replace(/^(?:小柯|小珂|柯霜|Codex|GPT娘)[，,：:\s]*(?=\/(?:quiet|forget|reset)(?:\s|$)|安静一会儿[。！!～~]?$)/i,'');
    cancelSpeechForControl({...event,content:controlText});
  }
  // Observe immediately, even while another member's reply or routing is still running.
  const decisionPromise = Promise.all([companion.observeGroup(event), social.observe(event, { addressed: false }), vocabulary.observe(event).catch(() => warn('词义候选暂未保存。')), media.flushRecent().catch(() => warn('近期图片索引暂未保存。'))])
    .then(([, observation]) => {
      if (!event.mentions_other_members && !event.is_self && !event.author?.bot) {
        if (mathReplies.pending(event) && isMathContinuation(event.addressed_content ?? event.content)) return { addressed: true, reason: 'math_continuation' };
        if (observation.wake) return { addressed: true, reason: 'wait_' + observation.wake.reason };
      }
      return router.decide(event, companion.groupContext(key), inbox.pendingForGroup(key));
    });
  // Classification may finish out of order; deliver in arrival order so commands and replies cannot overtake earlier input.
  const job = orderedDispatch.dispatch(key, decisionPromise, async decision => {
    if (decision.reason === 'bot_or_self' || decision.reason === 'invalid_group_event') return;
    if (!decision.addressed) {
      if (!['no_recent_bot_turn', 'outside_reply_window', 'no_clear_address'].includes(decision.reason) || !inbox.hasPendingFor(event)) {
        log('群聊暂不接话：' + decision.reason); return;
      }
    }
    // Preserve ordinary text, but make explicitly addressed control commands usable by name.
    const content = observedContent({ ...event, content:event.addressed_content ?? event.content }).replace(/^(?:小柯|小珂|柯霜|Codex|GPT娘)[，,：:\s]*(?=\/(?:quiet|wake|forget|reset|help|memory|roommemory|remember|mathnext)(?:\s|$)|(?:安静一会儿|出来聊聊)[。！!～~]?$)/i, '');
    cancelSpeechForControl({...event,content});
    // Stop background drawing as soon as a trusted clear command is routed;
    // the normal chat/memory command still retains its ordered queue position.
    if (['/forget', '/reset'].includes(content.trim())) {
      await characterGrowth.forget(event);
      await Promise.all([creation.forget({ ...event, content }), mathReplies.forget({ ...event, content })]);
      research.forget(event.group_openid);
    }
    log('群聊触发：' + (decision.addressed ? decision.reason : 'same_speaker_burst'));
    // Keep a continuation separate from another member's simultaneous question.
    const queuedContent = isMathContinuation(content) ? '/mathnext' : content;
    if (channels.accepts({ ...event, content: queuedContent })) { void processMessage({ ...event, content: queuedContent }).catch(() => warn('频道任务未完成。')); return; }
    void inbox.enqueue({ ...event, content: queuedContent, allow_silence: ['ambient_candidate','contextual_candidate','classified_continuation','clear_continuation'].includes(decision.reason) }).then(async result => {
      if (result?.status === 'expired') { log('群聊回合已超过 QQ 回复时限，原消息仍保留在上下文。'); return; }
      if (result?.status !== 'busy' || result.reason !== 'queue_capacity' || Date.now() - event._receivedAt >= 270000) return;
      if (Date.now() - (queueNotices.get(key) || 0) < 30000) return;
      queueNotices.set(key, Date.now());
      const notice = '这会儿消息排满了，这句没排进去，稍后再叫我一下。';
      const delivery = await client.reply(event, notice, 1);
      await companion.recordGroupAssistant(key, notice, { messageId: delivery?.id, referenceId: delivery?.ext_info?.ref_idx });
    }).catch(() => warn('群聊回复队列异常。'));
  });
  routeTasks.add(job);
  research.observe(event);
  void job.finally(() => routeTasks.delete(job)).catch(() => {});
  return job;
}
await client.run(event=>{if(!isEventAllowed(config,event))return;const authorization=scopeAccess.issue(event);return scopeAccess.withAuthorization(authorization,()=>handleIncoming({...event,[RUNTIME_AUTHORIZATION]:authorization}));});
social.stop(); await stopSpeechJobs(); clearInterval(speechControlTimer); stopSpeech(root); await memoryCapture?.close();
research.stop(); directory.stop(); await ownerWork.stop(); await ownerBrowser.stop(); await channels.stop(); await localConsole?.close();
clearInterval(statusTimer); await writeRuntimeStatus();
await logs.flush();
await lock.close(); await unlink(lockPath).catch(() => {});
