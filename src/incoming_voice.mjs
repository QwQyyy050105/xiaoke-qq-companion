import {addAbortListener} from 'node:events';
import {fetchMediaVoice} from './safe_media_fetch.mjs';
import {isVoiceAttachment} from './rich_context.mjs';

// Cache only the recognized text for a recent QQ message. No audio is written.
export function createVoiceInput({enabled, recognize, download = fetchMediaVoice, timeoutMs = 20000, onError = () => {}}) {
  const recent = new Map();
  const pending = new Map();
  let lifetime = new AbortController();

  async function read(attachment, event, signal) {
    const source = attachment.voice_wav_url || attachment.url;
    const voice = await download(source, {signal});
    signal.throwIfAborted();
    if (!enabled(event)) return '';
    const result = await recognize({buffer:voice.buffer, mime:voice.mime, fileName:voice.fileName, signal});
    signal.throwIfAborted();
    return result?.status === 'ok' && typeof result.text === 'string' ? result.text.trim().slice(0, 2000) : '';
  }

  return {
    reset() { lifetime.abort(); lifetime = new AbortController(); recent.clear(); pending.clear(); },
    async apply(event, authorization) {
      if (!event.id || event.is_self || event.author?.bot || !Array.isArray(event.attachments) || !enabled(event)) return event;
      const index = event.attachments.findIndex(isVoiceAttachment);
      const attachment = event.attachments[index];
      if (!attachment || attachment.asr_refer_text?.trim?.() || !(attachment.voice_wav_url || attachment.url)) return event;
      const scope = event.group_openid || event.author?.user_openid || event.author?.id;
      if (!scope) return event;
      const key = JSON.stringify([event.group_openid ? 'group' : 'private', scope, event.id, index]);
      const generation = lifetime.signal;
      let text = recent.get(key);
      if (!text) {
        let task = pending.get(key);
        if (!task) {
          if (pending.size >= 8) { onError('busy'); return event; }
          const signals = [generation, AbortSignal.timeout(timeoutMs)];
          if (authorization) signals.push(authorization);
          const signal = AbortSignal.any(signals);
          signal.throwIfAborted();
          task = new Promise((resolve, reject) => {
            const subscription = addAbortListener(signal, () => reject(signal.reason));
            read(attachment, event, signal).then(resolve, reject).finally(() => subscription[Symbol.dispose]());
          });
          pending.set(key, task);
        }
        try { text = await task; }
        catch { if (!authorization?.aborted && !generation.aborted) onError('unavailable'); return event; }
        finally { if (pending.get(key) === task) pending.delete(key); }
        if (text && !generation.aborted && !authorization?.aborted && enabled(event)) {
          recent.set(key, text);
          if (recent.size > 128) recent.delete(recent.keys().next().value);
        }
      }
      if (!text || generation.aborted || authorization?.aborted || !enabled(event)) return event;
      const attachments = [...event.attachments];
      attachments[index] = {...attachment, asr_refer_text:text};
      return {...event, attachments};
    }
  };
}
