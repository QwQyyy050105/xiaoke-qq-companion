import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultChatSettings = Object.freeze({ allowWebSearch: false, spontaneousStickers: false, allowImageCreation: false, proactiveEnabled: false });
export async function openChatSettings({ root }) {
  const path = join(root, 'data', 'chat_settings.json');
  await mkdir(join(root, 'data'), { recursive: true });
  async function check() { try { if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw Error('settings_path_rejected'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  await check();
  let saved = {};
  try { saved = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let value = { ...defaultChatSettings };
  for (const key of Object.keys(value)) if (typeof saved[key] === 'boolean') value[key] = saved[key];
  let writes = Promise.resolve();
  return { get: () => ({ ...value }), update(patch) {
    if (!patch || !Object.keys(patch).length || Object.entries(patch).some(([key, v]) => !(key in defaultChatSettings) || typeof v !== 'boolean')) return Promise.reject(Error('invalid_settings'));
    const task = writes.catch(() => {}).then(async () => {
      await check();
      const next = { ...value, ...patch }, temp = path + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temp, path); value = next; return { ...value };
    });
    writes = task.catch(() => {}); return task;
  } };
}

export function explicitlyRequestsMedia(event) {
  return (event.turn_messages?.length ? event.turn_messages : [event]).some(item => {
    const text = String(item.addressed_content ?? item.content ?? '').replace(/^\s*>.*$/gm, '');
    return /(?:发|来|给|看|重发).{0,12}(?:图|表情|头像|语音)|(?:图片|表情包|头像|语音).{0,8}(?:发|来|给|看)|这题我会/.test(text);
  });
}
