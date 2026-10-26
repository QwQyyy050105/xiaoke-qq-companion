import {isAbsolute as isPortableAbsolute} from 'node:path';
import { mkdir, realpath, lstat, open } from 'node:fs/promises';
import { durableWriteFile } from './durable_write.mjs';
import path from 'node:path';

const LEVELS = new Set(['info', 'warning', 'error']);
const MAX_RECORDS = 100;
const MAX_FEEDBACK_BYTES = 256 * 1024;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const PRIVATE_CONTENT = /(?:app[ _-]?secret|api[ _-]?(?:key|token)|access[ _-]?token|authorization|password|passwd|secret|token|密钥|密码|口令|访问令牌|验证码)["']?\s*(?:[:=：]|为|是)\s*\S+|\bBearer\s+\S+|-----BEGIN\b[^\r\n]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|(?:chat[ _-]?(?:text|content|history)|user[ _-]?(?:message|content|text)|assistant[ _-]?(?:message|reply)|roomHistory|聊天(?:正文|内容|记录)|用户(?:说|消息|输入)|群聊(?:正文|内容|消息))["']?\s*[:=：]|["']role["']\s*:\s*["'](?:user|assistant)["']|\b(?:group_openid|member_openid|user_openid|room[ _-]?id|qq[ _-]?(?:id|number))["']?\s*[:=：]|(?:QQ号|群号|成员标识|会话标识)["']?\s*[:=：]/i;
const TECHNICAL = /(?:\berrors?\b|\bfail(?:ed|ure|s)?\b|\b(?:timeout|timed out|connect(?:ed|ion|ing)?|disconnect(?:ed)?|retry|reconnect|service|process|runtime|model|api|http|network|socket|gateway|queue|schema|memory|disk|file|image|worker|missing|invalid|unavailable|cancel(?:ed|led)?|abort(?:ed)?|crash|started|stopped|startup|shutdown|health|status|warning)\b|(?:codex|qq|media|image|runtime|sticker)_[a-z_]+|错误|异常|失败|超时|连接|断线|掉线|重连|重试|服务|进程|运行|模型|接口|网络|网关|队列|模式|内存|磁盘|文件|图片|生图|任务|缺少|无效|不可用|取消|中止|崩溃|启动|停止|状态|告警|限额|额度|版本)/i;

function cleanMessage(value) {
  if (typeof value !== 'string' || value.length > 16000 || PRIVATE_CONTENT.test(value) || PRIVATE_CONTENT.test(value.replace(CONTROL, ''))) return null;
  let message = value.replace(CONTROL, ' ').trim();
  if (!message || PRIVATE_CONTENT.test(message) || !TECHNICAL.test(message)) return null;
  message = message
    .replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>]+|\bwww\.[^\s"'<>]+/gi, '[url]')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|cn|org|net|io|dev|app|ai|edu|gov)(?:[/?#][^\s"'<>]*)?/gi, '[url]')
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?\1/g, '[path]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/)[^\s"'<>|，。；]+/g, '[path]')
    .replace(/(?:[A-Za-z0-9_.~-]+[\\/])+[A-Za-z0-9_.~-]+/g, '[path]')
    .replace(/<@!?[^>\s]+>|\b(?:member|group|user)_[A-Za-z0-9_-]+\b/g, '[id]')
    .replace(/[A-Za-z0-9_+=-]{24,}/g, '[token]')
    .replace(/\d{7,}/g, '[number]')
    .replace(/\s+/g, ' ').trim();
  return [...message].slice(0, 500).join('') || null;
}

function isoTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('runtime_telemetry_invalid_time');
  return date.toISOString();
}

async function regularFileOrMissing(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('runtime_telemetry_file_boundary');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Local technical status only. No caller-provided field beyond the documented schema is persisted. */
export function createRuntimeTelemetry({ root, version, now = Date.now } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('runtime_telemetry_invalid_root');
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) throw new Error('runtime_telemetry_invalid_version');
  if (typeof now !== 'function') throw new Error('runtime_telemetry_invalid_clock');
  let queue = Promise.resolve();
  const enqueue = work => {
    const task = queue.catch(() => {}).then(work);
    queue = task.catch(() => {});
    return task;
  };
  async function dataDirectory() {
    const canonicalRoot = await realpath(root);
    if (process.platform === 'win32' && !isPortableAbsolute(canonicalRoot)) throw new Error('runtime_telemetry_requires_d_storage');
    const data = path.join(canonicalRoot, 'data');
    await mkdir(data, { recursive: true });
    if (await realpath(data) !== data) throw new Error('runtime_telemetry_directory_boundary');
    return data;
  }
  async function atomicWrite(directory, name, value) {
    const target = path.join(directory, name);
    await regularFileOrMissing(target);
    await durableWriteFile(target, JSON.stringify(value, null, 2) + '\n');
  }
  async function readFeedback(directory) {
    const file = path.join(directory, 'feedback.json');
    await regularFileOrMissing(file);
    let handle;
    try {
      handle = await open(file, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FEEDBACK_BYTES) throw new Error('runtime_telemetry_feedback_invalid');
      const value = JSON.parse(await handle.readFile('utf8'));
      if (!Array.isArray(value)) throw new Error('runtime_telemetry_feedback_invalid');
      return value.slice(-MAX_RECORDS).flatMap(item => {
        const message = cleanMessage(item?.message);
        const at = typeof item?.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.at) && Number.isFinite(Date.parse(item.at)) ? item.at : null;
        return message && LEVELS.has(item?.level) && at ? [{ at, level: item.level, message }] : [];
      });
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    finally { await handle?.close(); }
  }
  return {
    async writeStatus({ connected, pid } = {}) {
      if (typeof connected !== 'boolean' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('runtime_telemetry_invalid_status');
      return enqueue(async () => {
        const status = { connected, updatedAt: isoTime(now()), pid, version };
        await atomicWrite(await dataDirectory(), 'runtime_status.json', status);
        return status;
      });
    },
    async feedback({ level, message } = {}) {
      if (!LEVELS.has(level)) throw new Error('runtime_telemetry_invalid_level');
      const safeMessage = cleanMessage(message);
      if (!safeMessage) return null;
      return enqueue(async () => {
        const directory = await dataDirectory();
        const record = { at: isoTime(now()), level, message: safeMessage };
        const records = [...await readFeedback(directory), record].slice(-MAX_RECORDS);
        await atomicWrite(directory, 'feedback.json', records);
        return record;
      });
    }
  };
}
