import { senderId, hash } from './core.mjs';
import { isExplicitGroupMention } from './routing.mjs';

const command = text => /^\s*\//.test(text) || /^(?:安静一会儿|出来聊聊)[。！!～~]?$/.test(text.trim());

const messageFrom = (event, now) => ({
  id: String(event.id), content: String(event.content || ''), author: { member_openid: senderId(event) },
  ...(typeof event.timestamp === 'string' ? { timestamp: event.timestamp } : {}),
  _receivedAt: Number.isFinite(event._receivedAt) ? event._receivedAt : now,
  ...(typeof event.allow_silence === 'boolean' ? { allow_silence: event.allow_silence } : {}),
  ...(Array.isArray(event.attachments) ? { attachments: structuredClone(event.attachments.slice(0, 5)) } : {}),
  ...(event.message_scene ? { message_scene: structuredClone(event.message_scene) } : {}),
  ...(event.message_reference ? { message_reference: structuredClone(event.message_reference) } : {}),
  ...(Array.isArray(event.msg_elements) ? { msg_elements: structuredClone(event.msg_elements.slice(0, 8)) } : {}),
  ...(event.message_type !== undefined ? { message_type: event.message_type } : {}),
  ...(typeof event.explicit_mention === 'boolean' ? { explicit_mention: event.explicit_mention } : {})
});

// Decisions may run concurrently; delivery into a group's inbox keeps arrival order.
export class OrderedGroupDispatch {
  constructor() { this.tails = new Map(); }
  dispatch(groupId, decisionPromise, deliver) {
    // Observe rejection immediately, even while an older decision is still pending.
    const decision = Promise.resolve(decisionPromise).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    const previous = this.tails.get(groupId) || Promise.resolve();
    const job = previous.then(async () => {
      const outcome = await decision;
      if (!outcome.ok) throw outcome.error;
      // Callers enqueue here without returning the inbox's eventual QQ reply promise.
      return await deliver(outcome.value);
    });
    const tail = job.then(() => undefined, () => undefined);
    this.tails.set(groupId, tail);
    tail.then(() => { if (this.tails.get(groupId) === tail) this.tails.delete(groupId); });
    return job;
  }
}

// Optional group turns retain each speaker's original messages instead of flattening identities.
export class GroupInbox {
  constructor({ handle, delayMs = 1200, gapMs = 4000, batchParticipants = false, coalesceWhileBusy = false, maxQueuedTurns = 64, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    this.handle = handle; this.delayMs = delayMs; this.gapMs = gapMs; this.now = now; this.sleep = sleep;
    this.batchParticipants = batchParticipants;
    this.coalesceWhileBusy = coalesceWhileBusy === true;
    this.maxQueuedTurns = Number.isSafeInteger(maxQueuedTurns) && maxQueuedTurns > 0 ? maxQueuedTurns : 64;
    this.rooms = new Map(); this.pending = 0;
  }
  hasPendingFor(event) {
    const last = this.rooms.get(event.group_openid)?.queue.at(-1);
    return Boolean(last && senderId(last.event) === senderId(event) && !command(last.event.content || ''));
  }
  pendingForGroup(groupOpenid) {
    const room = this.rooms.get(groupOpenid);
    const pendingMessages = [];
    for (const item of room ? [room.active, ...room.queue].filter(Boolean) : []) {
      for (const message of item.messages) {
        const speaker = `member_${hash(JSON.stringify([groupOpenid, message.author.member_openid])).slice(0, 16)}`;
        const parsedTime = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
        pendingMessages.push({ speaker, content: message.content, messageId: message.id,
          at: new Date(Number.isFinite(parsedTime) ? parsedTime : message._receivedAt).toISOString() });
      }
    }
    return { pendingMessages, pendingSpeakers: [...new Set(pendingMessages.map(message => message.speaker))] };
  }
  render(item, latest) {
    item.event = { ...latest, content: this.batchParticipants ? item.messages.at(-1).content : item.messages.map(message => message.content).join('\n'),
      explicit_mention: item.messages.some(message => message.explicit_mention === true) ? true : latest.explicit_mention,
      allow_silence: latest.allow_silence === true && item.messages.every(message => message.explicit_mention !== true && message.allow_silence === true),
      source_ids: item.messages.map(message => message.id),
      ...(this.batchParticipants ? { turn_messages: structuredClone(item.messages) } : {}) };
  }
  enqueue(event) {
    if (typeof event?.group_openid !== 'string' || !event.group_openid || !event.id || !senderId(event)) return Promise.resolve({ status: 'ignored' });
    if (isExplicitGroupMention(event)) event = { ...event, explicit_mention: true, allow_silence: false };
    let room = this.rooms.get(event.group_openid);
    if (!room) { room = { queue: [], active: null, running: false, lastFinishedAt: 0, byId: new Map(), completed: new Map() }; this.rooms.set(event.group_openid, room); }
    return new Promise((resolve, reject) => {
      const completed = room.completed.get(event.id);
      if (completed) {
        // Only a known non-delivery may be upgraded. An error/unknown result may
        // already have sent a notice, so it must never be replayed automatically.
        if (!(completed.allowMentionUpgrade && event.explicit_mention === true)) { resolve(completed.result); return; }
        event = { ...event, _receivedAt: completed.receivedAt };
        room.completed.delete(event.id);
      }
      const existing = room.byId.get(event.id);
      if (existing) {
        existing.waiters.push({ resolve, reject });
        const message = existing.messages.find(message => message.id === event.id);
        if (message) {
          const update = messageFrom(event, this.now());
          if (event.explicit_mention === true) message.explicit_mention = true;
          message.allow_silence = message.allow_silence === true && event.allow_silence === true;
          for (const field of ['attachments', 'message_reference', 'msg_elements', 'message_type']) {
            if (Object.hasOwn(update, field) && (!Array.isArray(update[field]) || update[field].length)) message[field] = update[field];
          }
          if (update.message_scene) {
            const previousScene = message.message_scene || {};
            const extensions = [...(Array.isArray(previousScene.ext) ? previousScene.ext : []),
              ...(Array.isArray(update.message_scene.ext) ? update.message_scene.ext : [])];
            message.message_scene = { ...previousScene, ...update.message_scene };
            if (extensions.length) message.message_scene.ext = [...new Set(extensions)];
          }
        }
        this.render(existing, existing.event);
        return;
      }
      const tail = room.queue.at(-1);
      const current = this.now();
      const incoming = messageFrom(event, current);
      if (tail && (this.batchParticipants || senderId(tail.event) === senderId(event))
        && (!this.batchParticipants || current - tail.lastMessageAt <= this.delayMs || (this.coalesceWhileBusy && room.active))
        && !tail.messages.some(message => command(message.content)) && !command(incoming.content)
        && tail.messages.length < 20 && (tail.messages.reduce((size, message) => size + message.content.length, 0) + incoming.content.length < 7800)) {
        tail.messages.push(incoming); tail.lastMessageAt = current;
        this.render(tail, event);
        tail.waiters.push({ resolve, reject });
        room.byId.set(event.id, tail);
      } else if (room.queue.length < this.maxQueuedTurns) {
        const item = { event: { ...event }, messages: [incoming], waiters: [{ resolve, reject }], at: current, lastMessageAt: current };
        if (this.batchParticipants) this.render(item, event);
        room.queue.push(item); room.byId.set(event.id, item); this.pending++;
      } else {
        resolve({ status: 'busy', reason: 'queue_capacity', pendingTurns: room.queue.length + Number(Boolean(room.active)), source_ids: [event.id] });
        return;
      }
      if (!room.running) this.drain(room);
    });
  }
  invalidateAll(reason='scope_revoked') {
    for(const room of this.rooms.values()){
      const queued=room.queue.splice(0);this.pending-=queued.length;
      for(const item of queued)item.waiters.forEach(waiter=>waiter.resolve({status:'cancelled',reason}));
      room.byId.clear();room.completed.clear();
    }
  }
  async drain(room) {
    room.running = true;
    try {
      while (room.queue.length) {
        const first = room.queue[0];
        await this.sleep(Math.max(0, first.at + this.delayMs - this.now(), room.lastFinishedAt + this.gapMs - this.now()));
        const item = room.queue.shift();
        if(!item)continue;
        room.active = item;
        try {
          let attempted = item.event;
          let result = await this.handle(attempted);
          // render replaces the queued event, leaving an in-flight model input
          // stable. If that old input chooses silence, honor the newer explicit
          // mention once; a successful reply is shared by every variant instead.
          if (result?.status === 'silent' && attempted.allow_silence === true && attempted.explicit_mention !== true
            && item.event.explicit_mention === true) {
            attempted = item.event;
            result = await this.handle(attempted);
          }
          const allowMentionUpgrade = result?.status === 'silent' && attempted.allow_silence === true && attempted.explicit_mention !== true;
          for (const message of item.messages) room.completed.set(message.id,
            { result, allowMentionUpgrade, receivedAt: message._receivedAt });
          while (room.completed.size > 1000) room.completed.delete(room.completed.keys().next().value);
          item.waiters.forEach(waiter => waiter.resolve(result));
        }
        catch (error) { item.waiters.forEach(waiter => waiter.reject(error)); }
        finally { for (const id of item.event.source_ids || [item.event.id]) room.byId.delete(id); room.active = null; this.pending--; room.lastFinishedAt = this.now(); }
      }
    } finally { room.running = false; }
  }
}
