import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { durableWriteFile } from './durable_write.mjs';
import { normalizeExpression } from './character.mjs';
import { validateSpeechText } from './speech.mjs';
import { validateStickerSelection } from './sticker_context.mjs';
import { socialDecision, restoreSocialPlan, applySocialPlan, socialSnapshot, publicRoomMemory, publicMediaCatalog, proactiveMediaSelection, repeatsRecentReply, SOCIAL_NOTE_TTL } from './social_policy.mjs';
import { groupMemberSpeaker, normalizeWaitPlan, matchWaitPlan, waitSnapshot } from './social_wait.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const digest = value => createHash('sha256').update(value).digest('hex');
const clip = (value, limit) => Array.from(String(value ?? '')).slice(0, limit).join('');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\x00-\x1f]/.test(value);
const timestamp = value => Number.isFinite(value) && value >= 0 ? value : 0;
const chinaHour = time => new Date(time + 8 * HOUR).getUTCHours();
const cleanText = value => clip(String(value ?? '').replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim(), 300);
const commandFor = text => /^\/quiet(?:\s|$)/i.test(text) || /^(?:小柯[，,\s]*)?安静一会儿[。！!～~]?$/u.test(text)
  ? 'quiet' : /^\/wake(?:\s|$)/i.test(text) || /^(?:小柯[，,\s]*)?出来聊聊[。！!～~]?$/u.test(text) ? 'wake' : null;
const errorReason = error => {
  const match = String(error?.message ?? '').match(/^qq_(?:api|token)_error_(\d+)$/);
  if (match) return `qq_api_error_${match[1]}`;
  const code = error?.code ?? error?.status;
  return /^\d+$/.test(String(code ?? '')) ? `qq_api_error_${code}` : 'qq_send_uncertain';
};
const permissionBlocked = (error, reason) => [401, 403].includes(Number(error?.status)) || /^qq_api_error_(?:401|403|40034105)$/.test(reason);
const speechAvailability = (status, now) => {
  const reason = status?.enabled !== true ? 'disabled' : status.paused === true ? 'paused'
    : status.ready !== true ? 'not_ready' : Number(status.pending || 0) !== 0 ? 'busy'
      : timestamp(status.lastSentAt) && now - status.lastSentAt <= 2 * MINUTE ? 'cooldown' : 'ready';
  return { available: reason === 'ready', reason, max_chars: 120 };
};
const speechSelection = output => {
  try {
    const text = validateSpeechText(output?.speech?.text);
    return { text, mood: normalizeExpression({ mood: output.speech.mood })?.mood || 'calm' };
  } catch { return null; }
};

// Only real visible group events register a destination. The scheduler never invents targets.
export class ProactiveCompanion {
  constructor({ dataDir, generate, send, getRoomHistory, getRoomMemory, getRoomExpression, setRoomExpression, characterGrowth, getMediaCatalog, getVoiceCatalog, getSpeechStatus, getAuthorization, isAwake, now = Date.now, random = Math.random, isBusy = () => false, isContextBlocked = () => false, log = () => {} }) {
    this.dataDir = dataDir;
    this.generate = generate;
    this.send = send;
    this.getRoomHistory = getRoomHistory;
    this.getRoomMemory = getRoomMemory;
    this.getRoomExpression = getRoomExpression;
    this.setRoomExpression = setRoomExpression;
    this.characterGrowth = characterGrowth;
    this.getMediaCatalog = getMediaCatalog;
    this.getVoiceCatalog = getVoiceCatalog;
    this.getSpeechStatus = getSpeechStatus;
    this.getAuthorization = getAuthorization;
    this.isAwake = isAwake;
    this.now = now;
    this.random = random;
    this.isBusy = isBusy;
    this.isContextBlocked = isContextBlocked;
    this.log = log;
    this.writeQueue = Promise.resolve();
    this.ticking = false;
    this.sendingRooms = new Set();
    this.stopped = false;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    this.statePath = join(this.dataDir, 'social_state.json');
    let saved;
    try { saved = JSON.parse(await readFile(this.statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.state = { version: 1, groups: Object.create(null) };
    for (const source of Object.values(saved?.groups ?? {})) {
      if (!source || !validId(source.groupOpenid)) continue;
      const room = {
        groupOpenid: source.groupOpenid,
        enabled: source.enabled !== false,
        version: Number.isSafeInteger(source.version) ? Math.max(0, source.version) : 0,
        contextEpoch: Number.isSafeInteger(source.contextEpoch) ? Math.max(0, source.contextEpoch) : 0,
        lastInteractionAt: timestamp(source.lastInteractionAt),
        nextAt: timestamp(source.nextAt),
        quietUntil: timestamp(source.quietUntil),
        awaitingReply: source.awaitingReply === true,
        lastSentAt: timestamp(source.lastSentAt),
        blocked: source.blocked === true || permissionBlocked({}, source.lastAttemptReason),
        lastAttemptReason: /^qq_(?:api_error_\d+|send_uncertain)$/.test(source.lastAttemptReason ?? '') ? source.lastAttemptReason : null,
        reservation: source.reservation && typeof source.reservation.id === 'string' ? {
          id: source.reservation.id, at: timestamp(source.reservation.at)
        } : null,
        seen: Array.isArray(source.seen) ? source.seen.filter(id => /^[a-f0-9]{64}$/.test(id)).slice(-200) : [],
        // Legacy rooms observed only addressed events. Preserve their deduplication on upgrade.
        addressedSeen: (Array.isArray(source.addressedSeen) ? source.addressedSeen : Array.isArray(source.seen) ? source.seen : [])
          .filter(id => /^[a-f0-9]{64}$/.test(id)).slice(-200),
        roomHistory: Array.isArray(source.roomHistory) ? source.roomHistory.filter(item => item?.role === 'user' && typeof item.content === 'string')
          .slice(-12).map(item => ({ role: 'user', content: cleanText(item.content) })) : [],
        topics: Array.isArray(source.topics) ? source.topics.filter(item => typeof item === 'string').slice(-12).map(item => clip(item, 180)) : [],
        knownSpeakers: Array.isArray(source.knownSpeakers) ? source.knownSpeakers.filter(item => /^member_[a-f0-9]{16}$/.test(item)).slice(-50) : [],
        ...restoreSocialPlan(source, this.now())
      };
      room.waitPlan = normalizeWaitPlan(source.waitPlan, { allowedSpeakers: room.knownSpeakers, now: this.now(), restoring: true });
      // Upgrade the old 30–90 minute idle cadence; keep model-chosen waits intact.
      if (room.wakeReason === 'idle_opportunity' && !room.waitPlan && room.nextAt > this.now() + 30 * MINUTE) {
        room.nextAt = this.now() + this.delay();
      }
      // A persisted reservation might already have reached QQ before the process stopped.
      if (room.reservation) room.awaitingReply = true;
      this.state.groups[digest(room.groupOpenid)] = room;
    }
    return this;
  }

  persist() {
    const write = this.writeQueue.catch(() => {}).then(async () => {
      // Serialize the current state here, not an earlier observe/tick snapshot.
      await durableWriteFile(this.statePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    });
    this.writeQueue = write;
    return write;
  }

  delay() {
    const sample = Number(this.random());
    return (12 + 18 * (Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5)) * MINUTE;
  }

  async observe(event, { addressed = true } = {}) {
    const group = event?.group_openid;
    const member = event?.author?.member_openid || event?.author?.id;
    if (event?.is_self || event?.from_self || event?.author?.bot || !(event?.chat_type === 'group' || ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(event?.t)) || !validId(group) || !validId(event?.id) || !validId(member)) {
      return { handled: false, reply: null };
    }
    const text = cleanText(event.content);
    const command = addressed ? commandFor(text) : null;
    const key = digest(group);
    const seenKey = digest(event.id);
    const current = this.now();
    const room = this.state.groups[key] ??= {
      groupOpenid: group, enabled: true, version: 0, contextEpoch: 0, lastInteractionAt: current,
      nextAt: current + this.delay(), quietUntil: 0, awaitingReply: false,
      lastSentAt: 0, blocked: false, lastAttemptReason: null, reservation: null,
      seen: [], addressedSeen: [], roomHistory: [], topics: [], knownSpeakers: [], waitPlan: null, ...restoreSocialPlan({}, current)
    };
    const wasSeen = room.seen.includes(seenKey);
    // QQ may publish the same message as both a normal group event and a bot mention.
    if (wasSeen && (!addressed || room.addressedSeen.includes(seenKey))) return { handled: Boolean(command), reply: null };
    room.knownSpeakers = [...new Set([...(room.knownSpeakers || []), groupMemberSpeaker(group, member)])].slice(-50);
    const wake = !wasSeen && !addressed && room.enabled && !room.blocked && room.quietUntil <= current
      ? matchWaitPlan(room.waitPlan, event) : null;
    if (addressed || wake) room.waitPlan = null;
    // These changes happen before awaiting disk I/O, cancelling any stale generation immediately.
    room.version++;
    if (!wasSeen) room.seen = [...room.seen, seenKey].slice(-200);
    if (addressed) room.addressedSeen = [...room.addressedSeen, seenKey].slice(-200);
    room.lastInteractionAt = current;
    // A cancelled, not-yet-attempted reservation is not an unanswered message.
    if (addressed || wake || (room.reservation && !this.sendingRooms.has(key))) room.awaitingReply = false;
    room.reservation = null;
    room.nextAt = current + this.delay();
    room.quietDecisions = 0;
    room.wakeReason = wake ? `wait_${wake.reason}` : 'idle_opportunity';
    let reply = null;
    if (command === 'quiet') {
      room.quietUntil = current + DAY;
      reply = '好，我先安静一天。叫我还是会回，想恢复就说“小柯，出来聊聊”。';
    } else if (command === 'wake') {
      room.enabled = true;
      room.quietUntil = 0;
      room.blocked = false;
      room.lastAttemptReason = null;
      room.nextAt = current + MINUTE;
      reply = '我出来啦。等会儿想到有意思的就来找你们聊。';
    } else if (addressed && (text === '/forget' || text === '/reset')) {
      // Group snippets have no member identity, so erase the entire shared snapshot.
      // Let Companion process the command, and require a new real message before initiating again.
      room.roomHistory = [];
      room.contextEpoch++;
      room.topics = [];
      room.recentSent = [];
      room.activeTopic = null;
      room.pendingThought = null;
      room.waitPlan = null;
      room.knownSpeakers = [];
      room.awaitingReply = true;
    } else if (!wasSeen && text && !text.startsWith('/')) {
      room.roomHistory.push({ role: 'user', content: text });
      room.roomHistory = room.roomHistory.slice(-12);
    }
    await this.persist();
    return { handled: Boolean(command), reply, ...(wake ? { wake } : {}) };
  }

  applyWait(room, social) {
    if (social && Object.hasOwn(social, 'wait')) room.waitPlan = normalizeWaitPlan(social.wait,
      { allowedSpeakers: room.knownSpeakers || [], now: this.now() });
  }

  context(groupOpenid) {
    const room = validId(groupOpenid) ? this.state.groups[digest(groupOpenid)] : null;
    if (!room) return null;
    return { ...socialSnapshot(room, this.now()), wait: waitSnapshot(room.waitPlan),
      enabled: room.enabled, quietUntil: room.quietUntil, awaitingReply: room.awaitingReply,
      nextOpportunityAt: room.waitPlan && room.waitPlan.mode !== 'timer' ? null : room.nextAt, knownSpeakers: [...(room.knownSpeakers || [])] };
  }

  snapshot() {
    return Object.entries(this.state.groups).map(([scope, room]) => ({
      scope, enabled: room.enabled, blocked: room.blocked, quietUntil: room.quietUntil,
      nextAt: room.nextAt, awaitingReply: room.awaitingReply, lastSentAt: room.lastSentAt,
      lastInteractionAt: room.lastInteractionAt, waitMode: room.waitPlan?.mode || 'timer',
      lastAttemptReason: room.lastAttemptReason, generatingOrSending: Boolean(this.activeScope === scope || room.reservation || this.sendingRooms.has(scope))
    }));
  }

  // Local, authenticated operator controls only. These are not model tools.
  async control(scope, action) {
    if (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope) || !['wake', 'quiet', 'enable', 'disable'].includes(action)) return false;
    const room = this.state.groups[scope];
    if (!room) return false;
    const current = this.now();
    room.version++;
    if (room.reservation && !this.sendingRooms.has(scope)) room.awaitingReply = false;
    room.reservation = null;
    if (action === 'disable') room.enabled = false;
    else if (action === 'enable') {
      room.enabled = true;
      room.nextAt = current + MINUTE;
    } else if (action === 'quiet') {
      room.quietUntil = current + DAY;
      room.waitPlan = null;
    } else {
      room.enabled = true;
      room.quietUntil = 0;
      room.blocked = false;
      room.lastAttemptReason = null;
      room.waitPlan = null;
      room.awaitingReply = false;
      room.nextAt = current + MINUTE;
      room.quietDecisions = 0;
      room.wakeReason = 'idle_opportunity';
    }
    await this.persist();
    return true;
  }

  async markReplied(groupOpenid, { social, engaged = false } = {}) {
    if (!validId(groupOpenid)) return false;
    const key = digest(groupOpenid);
    const room = this.state.groups[key];
    if (!room) return false;
    room.version++;
    // A real delivered reply proves engagement. Merely evaluating an ambient
    // message or choosing silence must not clear this state.
    if(engaged===true)room.awaitingReply = false;
    applySocialPlan(room, socialDecision({ social }), this.now(), this.delay(), { reason: 'reply_followup' });
    this.applyWait(room, social);
    if (room.reservation && !this.sendingRooms.has(key)) room.awaitingReply = false;
    room.reservation = null;
    await this.persist();
    return true;
  }

  async markObserved(groupOpenid, { social } = {}) {
    if (!validId(groupOpenid)) return false;
    const room = this.state.groups[digest(groupOpenid)];
    if (!room) return false;
    // A deliberate silent outcome updates only the future opportunity and intention.
    // It is neither a delivered message nor an answer to an unsolicited message.
    room.version++;
    applySocialPlan(room, socialDecision({ social }), this.now(), this.delay(), { silent: true, reason: 'reply_followup' });
    this.applyWait(room, social);
    await this.persist();
    return true;
  }

  eligible(room, time, { reserved = false } = {}) {
    if (this.isContextBlocked(room.groupOpenid)) return false;
    const elapsed = time - room.lastInteractionAt;
    const hour = chinaHour(time);
    const awake = typeof this.isAwake === 'function'
      ? this.isAwake(room.groupOpenid, time, { lastInteractionAt: room.lastInteractionAt, lastSentAt: room.lastSentAt }) !== false
      : hour >= 9 || hour < 1 || (elapsed >= 0 && elapsed <= 2 * HOUR);
    return !this.stopped && room.enabled && !room.blocked && (!room.waitPlan || room.waitPlan.mode === 'timer') && (reserved || !room.awaitingReply)
      && room.quietUntil <= time && room.nextAt <= time && elapsed >= 0 && elapsed < 7 * DAY && awake;
  }

  async tick() {
    if (this.ticking || this.stopped || this.isBusy()) return false;
    this.ticking = true;
    try {
      const due = Object.entries(this.state.groups).filter(([, room]) => this.eligible(room, this.now()))
        .sort(([, a], [, b]) => a.nextAt - b.nextAt);
      if (!due.length) return false;
      const [key, room] = due[0];
      this.activeScope = key;
      const version = room.version;
      const runtimeAuthorization=this.getAuthorization?.(room.groupOpenid);
      const contextEpoch = room.contextEpoch;
      const characterSnapshot = this.characterGrowth?.snapshot({group_openid:room.groupOpenid});
      let output, roomHistory, mediaCatalog, voiceCatalog, speechStatus;
      try {
        const [publicHistory, memory, images, voices, expression, voiceStatus] = await Promise.all([
          typeof this.getRoomHistory === 'function' ? this.getRoomHistory(room.groupOpenid) : null,
          typeof this.getRoomMemory === 'function' ? this.getRoomMemory(room.groupOpenid) : [],
          typeof this.getMediaCatalog === 'function' ? this.getMediaCatalog(room.groupOpenid) : [],
          typeof this.getVoiceCatalog === 'function' ? this.getVoiceCatalog(room.groupOpenid) : [],
          typeof this.getRoomExpression === 'function' ? this.getRoomExpression(room.groupOpenid) : null,
          typeof this.getSpeechStatus === 'function'
            ? Promise.resolve().then(() => this.getSpeechStatus(room.groupOpenid)).catch(() => null) : null
        ]);
        if (this.state.groups[key]?.version !== version || !this.eligible(room, this.now()) || this.isBusy()) return false;
        roomHistory = structuredClone(Array.isArray(publicHistory) ? publicHistory : room.roomHistory);
        mediaCatalog = publicMediaCatalog(images, { groupOpenid: room.groupOpenid });
        voiceCatalog = publicMediaCatalog(voices, { groupOpenid: room.groupOpenid, voice: true });
        speechStatus = speechAvailability(voiceStatus, this.now());
        output = await this.generate({
          history: [], memory: [], mode: 'proactive',
          ...(runtimeAuthorization?{runtimeAuthorization}:{}),
          text: '这是一次定时参与机会。看看当前群聊，有自己想说的就说，没有也可以继续待着。',
          roomHistory, roomMemory: publicRoomMemory(memory), topics: [...room.topics],
          ...(characterSnapshot ? {characterGrowth:characterSnapshot} : {}),
          ...(expression?{expressionState:structuredClone(expression)}:{}),
          speechStatus: structuredClone(speechStatus),
          mediaCatalog: structuredClone(mediaCatalog), voiceCatalog: structuredClone(voiceCatalog),
          socialState: { ...socialSnapshot(room, this.now(), roomHistory), wait: waitSnapshot(room.waitPlan), knownSpeakers: [...room.knownSpeakers] }
        });
      } catch {
        if (this.state.groups[key]?.version === version) {
          this.state.groups[key].nextAt = this.now() + this.delay();
          await this.persist();
        }
        this.log('主动话题生成暂未完成，稍后再试。');
        return false;
      }
      const speech = speechSelection(output);
      const draft = clip(typeof output === 'string' ? output.trim() : typeof output?.reply === 'string' ? output.reply.trim() : '', 300);
      const decision = socialDecision(output);
      const stickerChoice=validateStickerSelection({catalog:mediaCatalog,input:{mode:'proactive'},media:output?.media,roomMessages:roomHistory});
      const selectedOutput=stickerChoice.allowed?output:{...output,media:{...output?.media,send_id:''}};
      const selection = proactiveMediaSelection(selectedOutput, mediaCatalog, voiceCatalog);
      const dynamicSpeech = speech && speechStatus.available && !selection.mediaId && !selection.voiceId ? speech : null;
      const answer = draft || (!selection.mediaId && !selection.voiceId && !dynamicSpeech ? speech?.text || '' : '');
      const intendedText = dynamicSpeech ? `[发送语音：${dynamicSpeech.text}]` : [answer, ...selection.labels].filter(Boolean).join('\n');
      const expression = normalizeExpression(output?.expression, this.now());
      const latest = this.state.groups[key];
      if (!latest || latest.version !== version || !this.eligible(latest, this.now()) || this.isBusy()) return false;
      const reflectionIsCurrent = () => !this.stopped && !this.isContextBlocked(latest.groupOpenid)
        && this.state.groups[key] === latest && latest.version === version;
      if (characterSnapshot && output?.character_updates?.some(row=>['style','interest','rapport'].includes(row?.kind))) {
        try { await this.characterGrowth.apply({group_openid:latest.groupOpenid},output.character_updates.filter(row=>['style','interest','rapport'].includes(row?.kind)),
          {expectedRevision:characterSnapshot.revision,messages:roomHistory,guard:reflectionIsCurrent}); }
        catch { this.log('人格成长记录暂未保存。'); }
      }
      if (!reflectionIsCurrent() || !this.eligible(latest,this.now()) || this.isBusy()) return false;
      const duplicate = intendedText && repeatsRecentReply(intendedText, latest, roomHistory, this.now());
      if (decision.action === 'silent' || !intendedText || duplicate) {
        applySocialPlan(latest, decision, this.now(), this.delay(), { silent: true });
        this.applyWait(latest, output?.social);
        await this.persist();
        if (duplicate) this.log('主动话题与近期发言重复，已留待下次自然接话。');
        return false;
      }
      const reservation = `${version}:${this.now()}`;
      latest.awaitingReply = true;
      latest.reservation = { id: reservation, at: this.now() };
      await this.persist();
      const beforeSend = this.state.groups[key];
      // The sender must recheck this after any asynchronous synthesis/prepare
      // work, immediately before its first actual QQ transport call.
      const isCurrent = () => this.state.groups[key] === beforeSend && beforeSend?.version === version
        && beforeSend.reservation?.id === reservation && this.eligible(beforeSend, this.now(), { reserved: true }) && !this.isBusy();
      if (!isCurrent()) {
        if (beforeSend?.reservation?.id === reservation) {
          beforeSend.awaitingReply = false;
          beforeSend.reservation = null;
          await this.persist();
        }
        return false;
      }
      this.sendingRooms.add(key);
      let deliveredText;
      try {
        const delivery = await this.send(beforeSend.groupOpenid, answer, { mediaId: selection.mediaId, voiceId: selection.voiceId,
          ...(runtimeAuthorization?{authorization:runtimeAuthorization}:{}),
          ...(dynamicSpeech ? { speech: structuredClone(dynamicSpeech) } : {}), isCurrent });
        if (typeof delivery?.sent_text === 'string') deliveredText = delivery.sent_text.trim();
        else if (Array.isArray(delivery?.delivered_messages)) deliveredText = delivery.delivered_messages
          .filter(item => typeof item?.content === 'string' && item.content.trim()).slice(0, 5).map(item => item.content.trim()).join('\n');
        else if (!dynamicSpeech && !expression) deliveredText = intendedText; // Legacy text/media callbacks resolve after a successful send.
        if (!deliveredText) throw new Error('qq_send_uncertain');
        deliveredText = clip(deliveredText, 300);
      } catch (error) {
        const current = this.state.groups[key];
        if(error?.code==='scope_revoked'&&error.messageNotSent===true){current.awaitingReply=false;current.reservation=null;await this.persist();return false;}
        if (error?.message === 'proactive_stale') {
          // The sender guarantees this means no QQ send was attempted. Preserve
          // a newer real conversation's state instead of marking it unanswered.
          if (current?.reservation?.id === reservation) {
            current.awaitingReply = false; current.reservation = null; await this.persist();
          }
          return false;
        }
        const reason = errorReason(error);
        current.awaitingReply = true;
        current.reservation = null;
        current.blocked ||= permissionBlocked(error, reason);
        current.lastAttemptReason = reason;
        await this.persist();
        this.log(`主动消息未确认送达：${reason}。`);
        return false;
      } finally {
        this.sendingRooms.delete(key);
      }
      const current = this.state.groups[key];
      if (expression && typeof this.setRoomExpression === 'function' && reflectionIsCurrent()) {
        try { await this.setRoomExpression(current.groupOpenid, { ...expression, at: this.now() }, reflectionIsCurrent); }
        catch { this.log('角色状态暂未保存。'); }
      }
      current.lastSentAt = this.now();
      current.lastAttemptReason = null;
      if (current.contextEpoch === contextEpoch && !this.isContextBlocked(current.groupOpenid)) {
        current.topics = [...current.topics, clip(deliveredText, 180)].slice(-12);
        current.recentSent = [...current.recentSent.filter(item => this.now() - item.at <= SOCIAL_NOTE_TTL), { text: deliveredText, at: this.now() }].slice(-24);
      }
      if (current.version === version && !this.isContextBlocked(current.groupOpenid)) {
        applySocialPlan(current, decision, this.now(), this.delay());
        this.applyWait(current, output?.social);
        current.pendingThought = null;
      }
      if (current.reservation?.id === reservation) current.reservation = null;
      // A real mention during send has already cleared awaitingReply and scheduled its own delay.
      await this.persist();
      return true;
    } finally { this.ticking = false; this.activeScope = null; }
  }

  invalidateAuthorization(){for(const room of Object.values(this.state.groups)){room.version++;if(room.reservation&&!this.sendingRooms.has(digest(room.groupOpenid)))room.awaitingReply=false;room.reservation=null;}}

  start() {
    this.stopped = false;
    if (!this.timer) {
      this.timer = setInterval(() => { this.tick().catch(() => this.log('主动聊天状态暂未保存，本轮已停止。')); }, MINUTE);
      this.timer.unref?.();
    }
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }
}
