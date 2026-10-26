import {isAbsolute as isPortableAbsolute} from 'node:path';
import { mkdir, realpath, lstat, readFile, writeFile, readdir, open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const OWNER = 'qq_companion_runtime_log_v1';
const DEFAULT_BYTES = 512 * 1024;
const DEFAULT_RETAIN = 3;
const LABELS = Object.freeze({
  suppressed: '非诊断文本已省略', startup: '桥接启动', paired: '已绑定主人', pairing: '等待本机配对',
  setup_required: '需要本机配置', singleton_rejected: '已有实例或锁异常', authenticated: 'QQ 凭据校验通过',
  auth_failed: 'QQ 凭据校验失败', auth_help: 'QQ 凭据需要核对', connected: 'QQ 已连接', disconnected: 'QQ 连接断开',
  connection_failed: 'QQ 连接失败', receive_group_at: '收到群聊提及', receive_group: '收到群聊消息', receive_private: '收到单聊消息',
  processing_failed: '消息处理失败', reply_group: '群聊回复已发送', reply_private: '单聊回复已发送',
  reply_image: '图片回复已发送', reply_voice: '语音回复已发送', proactive_sent: '主动消息已被 QQ 接受',
  group_turn: '多人共同回合', image_prepare: '图片准备完成', group_timing: '群聊处理耗时',
  route_accept: '群聊接话', route_ignore: '群聊未接话', expired: '回复窗口已过期', queue_failed: '回复队列异常',
  media_collected: '会话图片已收藏', media_usage_failed: '图片使用记录未保存', media_note_failed: '图片备注未保存',
  media_cleanup_failed: '临时图片清理未完成', generation_held: '生成结果等待交付', generation_record_failed: '图片任务记录未完成',
  visual_preflight: '生图前尺寸检查', visual_postflight: '生图后尺寸检查', generation_cleanup_failed: '生图参考清理未完成',
  proactive_generation_failed: '主动话题生成未完成', proactive_duplicate: '主动话题重复已跳过',
  proactive_uncertain: '主动消息未确认送达', proactive_state_failed: '主动聊天状态未保存',
  status_failed: '运行状态未保存', feedback_failed: '技术反馈未保存'
});
const EXACT = new Map([
  ['小柯 QQ 桥接启动。关闭这个窗口会下线；按 Ctrl+C 可正常退出。', 'startup'],
  ['已绑定主人，等待消息。', 'paired'], ['请在 QQ 单聊发送设置窗口显示的 /pair 配对码。', 'pairing'],
  ['请先双击 Setup.cmd，在本机输入 QQ 机器人 AppSecret。', 'setup_required'],
  ['已有实例或锁状态异常，无法启动第二个实例。', 'singleton_rejected'],
  ['QQ 凭据校验通过。', 'authenticated'],
  ['100016 表示 AppID/AppSecret 不匹配。请在本机 Setup.cmd 更新真实 AppSecret；无需重置或分享密钥。', 'auth_help'],
  ['QQ 已连接，等待单聊和群聊消息。', 'connected'], ['收到 QQ 群聊 @ 消息。', 'receive_group_at'],
  ['收到 QQ 群聊普通消息。', 'receive_group'], ['收到 QQ 单聊消息。', 'receive_private'],
  ['消息处理失败，请检查本机配置或重发消息。', 'processing_failed'], ['群聊回复已发送。', 'reply_group'],
  ['单聊回复已发送。', 'reply_private'], ['QQ 图片回复已发送。', 'reply_image'], ['QQ 语音回复已发送。', 'reply_voice'],
  ['群聊主动消息已被 QQ 接受。', 'proactive_sent'], ['群聊回合已超过 QQ 回复时限，原消息仍保留在上下文。', 'expired'],
  ['群聊回复队列异常。', 'queue_failed'], ['本会话图片已收藏。', 'media_collected'],
  ['图片已发送，使用记录暂未保存。', 'media_usage_failed'], ['本会话图片备注暂未保存。', 'media_note_failed'],
  ['临时图片清理未完成。', 'media_cleanup_failed'], ['生成结果已保留，等待下一条可回复消息交付。', 'generation_held'],
  ['图片任务记录未完成，请检查本机任务记录。', 'generation_record_failed'], ['生图参考临时文件清理未完成。', 'generation_cleanup_failed'],
  ['主动话题生成暂未完成，稍后再试。', 'proactive_generation_failed'], ['主动话题与近期发言重复，已留待下次自然接话。', 'proactive_duplicate'],
  ['主动聊天状态暂未保存，本轮已停止。', 'proactive_state_failed'], ['运行状态记录暂未保存。', 'status_failed'], ['技术反馈暂未保存。', 'feedback_failed']
]);
const REASONS = new Set(['invalid_group_event', 'bot_or_self', 'already_addressed', 'duplicate_ignored', 'explicit_mention', 'empty_content',
  'references_bot_reply', 'mentions_other_member', 'called_by_name', 'outside_group_topic_window', 'continuation_command',
  'clear_continuation', 'classified_continuation', 'classified_unrelated', 'no_clear_address', 'contextual_candidate', 'same_speaker_burst']);
const ERROR_CODES = new Set(['qq_send_uncertain', 'qq_delivery_unconfirmed', 'qq_invalid_reply_target', 'qq_invalid_media_upload', 'qq_invalid_proactive_target',
  'codex_invalid_chat_response', 'codex_invalid_social_response', 'codex_image_path_rejected', 'codex_image_size_rejected',
  'codex_aborted', 'codex_launch_failed', 'codex_executable_missing', 'codex_timeout', 'codex_invalid_visual_review', 'codex_visual_review_requires_two_images']);
const NUMBERS = new Set(['members', 'messages', 'images', 'received_images', 'quotes', 'unloaded_images', 'elapsed_ms', 'queue_ms', 'processing_ms', 'first_delivery_ms', 'status', 'code', 'exit_code']);
const validNumber = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
function cleanFields(fields) {
  const result = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return result;
  for (const [key, value] of Object.entries(fields)) {
    if (NUMBERS.has(key) && validNumber(value)) result[key] = value;
    else if (key === 'reason' && REASONS.has(value)) result.reason = value;
    else if (key === 'error_code' && ERROR_CODES.has(value)) result.error_code = value;
    else if (key === 'size_check' && ['pass', 'fail', 'unverified'].includes(value)) result.size_check = value;
    else if (key === 'sent' && typeof value === 'boolean') result.sent = value;
  }
  return result;
}
function errorFields(value) {
  const numeric = /^(?:qq_(?:api|token)_error_|codex_failed_exit_)(\d{1,9})$/.exec(value);
  if (numeric) return { [value.startsWith('codex') ? 'exit_code' : 'code']: Number(numeric[1]) };
  return ERROR_CODES.has(value) ? { error_code: value } : {};
}

/** Strict template parser: unknown input is never copied, even when it resembles technical prose. */
export function sanitizeRuntimeEntry(message, { level = 'info', fields } = {}) {
  const safeLevel = level === 'warn' ? 'warning' : ['info', 'warning', 'error'].includes(level) ? level : 'info';
  let event = 'suppressed', parsed = {};
  if (typeof message === 'string' && message.length <= 4000) {
    event = EXACT.get(message) || event;
    let match;
    if ((match = /^群聊共同回合：(\d{1,5}) 位成员，(\d{1,5}) 条消息。$/.exec(message))) {
      event = 'group_turn'; parsed = { members: Number(match[1]), messages: Number(match[2]) };
    } else if ((match = /^群聊耗时：进入处理前 (\d{1,9})ms，处理 (\d{1,9})ms(?:，首条送达 (\d{1,9})ms|，未发送)。$/.exec(message))) {
      event = 'group_timing'; parsed = { queue_ms: Number(match[1]), processing_ms: Number(match[2]), sent: Boolean(match[3]), ...(match[3] ? { first_delivery_ms: Number(match[3]) } : {}) };
    } else if ((match = /^图片准备：加载 (\d{1,4}) 张，其中聊天图片 (\d{1,4}) 张，尺寸 (?:无|\d{1,5}x\d{1,5}(?:,\d{1,5}x\d{1,5}){0,9})，引用 (\d{1,4}) 条，未加载 (\d{1,4}) 张，用时 (\d{1,9})ms。$/.exec(message))) {
      event = 'image_prepare'; parsed = { images: Number(match[1]), received_images: Number(match[2]), quotes: Number(match[3]), unloaded_images: Number(match[4]), elapsed_ms: Number(match[5]) };
    } else if ((match = /^QQ 连接断开（(\d{1,5})），准备重连。$/.exec(message))) {
      event = 'disconnected'; parsed = { code: Number(match[1]) };
    } else if ((match = /^群聊(暂不接话|触发)：([a-z_]{1,50})$/.exec(message)) && REASONS.has(match[2])) {
      event = match[1] === '触发' ? 'route_accept' : 'route_ignore'; parsed = { reason: match[2] };
    } else if ((match = /^生图(前|后)实际视觉尺寸判断：(pass|fail|unverified)。$/.exec(message))) {
      event = match[1] === '前' ? 'visual_preflight' : 'visual_postflight'; parsed = { size_check: match[2] };
    } else if ((match = /^(QQ 凭据校验失败：|连接失败：|处理失败：|主动消息未确认送达：)([^\r\n]+?)[。]?$/.exec(message))) {
      event = ({ 'QQ 凭据校验失败：': 'auth_failed', '连接失败：': 'connection_failed', '处理失败：': 'processing_failed', '主动消息未确认送达：': 'proactive_uncertain' })[match[1]];
      parsed = errorFields(match[2]);
    }
  }
  // Caller fields are diagnostic counters only. A suppressed input cannot smuggle its metadata in.
  return { level: safeLevel, event, message: LABELS[event], fields: event === 'suppressed' ? {} : { ...cleanFields(fields), ...parsed } };
}

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function regular(file, maxBytes) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(file), file)) throw new Error('runtime_log_file_boundary');
    if (info.size > maxBytes) throw new Error('runtime_log_file_over_limit');
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const isoTime = value => { const time = new Date(value); if (!Number.isFinite(time.getTime())) throw new Error('runtime_log_invalid_time'); return time.toISOString(); };

/** One instance per service. Only this directory's marked, bounded diagnostic files are rotated. */
export class RuntimeLog {
  static async open(options = {}) { const logger = new RuntimeLog(options); await logger.init(); return logger; }
  constructor({ root, maxBytes = DEFAULT_BYTES, retain = DEFAULT_RETAIN, now = Date.now } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('runtime_log_invalid_root');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8 * 1024 * 1024) throw new Error('runtime_log_invalid_size');
    if (!Number.isSafeInteger(retain) || retain < 0 || retain > 5 || typeof now !== 'function') throw new Error('runtime_log_invalid_options');
    this.root = root; this.maxBytes = maxBytes; this.retain = retain; this.now = now; this.queue = Promise.resolve(); this.ready = false;
  }
  async init() {
    this.root = await realpath(this.root);
    if (process.platform === 'win32' && !isPortableAbsolute(this.root)) throw new Error('runtime_log_requires_d_storage');
    const data = path.join(this.root, 'data');
    await mkdir(data, { recursive: true });
    if (!samePath(await realpath(data), data)) throw new Error('runtime_log_directory_boundary');
    this.directory = path.join(data, 'runtime_logs');
    await mkdir(this.directory, { recursive: true });
    await this.checkDirectory();
    this.owner = { owner: OWNER, rootHash: createHash('sha256').update(this.root.toLowerCase()).digest('hex'), maxBytes: this.maxBytes, retain: this.retain };
    const marker = path.join(this.directory, 'owner.json');
    if (await regular(marker, 1024)) {
      const stored = JSON.parse(await readFile(marker, 'utf8'));
      if (JSON.stringify(stored) !== JSON.stringify(this.owner)) throw new Error('runtime_log_owner_mismatch');
    } else {
      if ((await readdir(this.directory)).length) throw new Error('runtime_log_unmanaged_directory');
      await writeFile(marker, JSON.stringify(this.owner), { flag: 'wx', mode: 0o600 });
    }
    for (let i = 0; i <= this.retain; i++) await regular(this.file(i), this.maxBytes);
    this.ready = true;
    return this;
  }
  file(index = 0) { return path.join(this.directory, index ? `runtime.${index}.jsonl` : 'runtime.jsonl'); }
  async checkDirectory() {
    if (!samePath(await realpath(this.root), this.root) || !samePath(await realpath(path.join(this.root, 'data')), path.join(this.root, 'data'))
      || !samePath(await realpath(this.directory), this.directory)) throw new Error('runtime_log_directory_boundary');
  }
  async checkOwner() {
    await this.checkDirectory();
    const marker = path.join(this.directory, 'owner.json');
    if (!await regular(marker, 1024) || await readFile(marker, 'utf8') !== JSON.stringify(this.owner)) throw new Error('runtime_log_owner_mismatch');
  }
  enqueue(work) { const task = this.queue.catch(() => {}).then(work); this.queue = task.catch(() => {}); return task; }
  log(message, options = {}) {
    const safe = sanitizeRuntimeEntry(message, options);
    const record = { at: isoTime(this.now()), ...safe };
    return this.enqueue(async () => {
      if (!this.ready) throw new Error('runtime_log_not_initialized');
      await this.checkOwner();
      const line = JSON.stringify(record) + '\n';
      const size = Buffer.byteLength(line);
      if (size > this.maxBytes) throw new Error('runtime_log_entry_over_limit');
      const current = await regular(this.file(), this.maxBytes);
      if ((current?.size || 0) + size > this.maxBytes) await this.rotate();
      const handle = await open(this.file(), 'a', 0o600);
      try { await handle.writeFile(line); } finally { await handle.close(); }
      return record;
    });
  }
  info(message, fields) { return this.log(message, { level: 'info', fields }); }
  warn(message, fields) { return this.log(message, { level: 'warning', fields }); }
  error(message, fields) { return this.log(message, { level: 'error', fields }); }
  flush() { return this.queue; }
  async rotate() {
    // Validate every participant before removing or moving any owned file.
    const files = await Promise.all(Array.from({ length: this.retain + 1 }, (_, i) => regular(this.file(i), this.maxBytes)));
    if (files[this.retain]) await unlink(this.file(this.retain));
    for (let i = this.retain - 1; i >= 0; i--) if (files[i]) await rename(this.file(i), this.file(i + 1));
  }
  summary({ limit = 20 } = {}) {
    limit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 50)) : 20;
    return this.enqueue(async () => {
      if (!this.ready) throw new Error('runtime_log_not_initialized');
      await this.checkOwner();
      const entries = []; let bytes = 0, files = 0, invalidRecords = 0;
      for (let index = this.retain; index >= 0; index--) {
        const info = await regular(this.file(index), this.maxBytes);
        if (!info) continue;
        bytes += info.size; files++;
        for (const line of (await readFile(this.file(index), 'utf8')).split('\n').filter(Boolean)) {
          try {
            const item = JSON.parse(line);
            if (!Object.hasOwn(LABELS, item.event) || !['info', 'warning', 'error'].includes(item.level)
              || typeof item.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.at) || !Number.isFinite(Date.parse(item.at))) throw new Error('invalid_record');
            entries.push({ at: item.at, level: item.level, event: item.event, message: LABELS[item.event], fields: cleanFields(item.fields) });
          } catch { invalidRecords++; }
        }
      }
      const counts = {};
      for (const item of entries) counts[item.event] = (counts[item.event] || 0) + 1;
      const warnings = entries.filter(item => item.level === 'warning').length;
      const errors = entries.filter(item => item.level === 'error').length;
      const totalReceived = (counts.receive_group || 0) + (counts.receive_group_at || 0) + (counts.receive_private || 0);
      const totalDelivered = ['reply_group', 'reply_private', 'reply_image', 'reply_voice', 'proactive_sent'].reduce((sum, key) => sum + (counts[key] || 0), 0);
      return { scope: 'retained_diagnostic_records', files, bytes, capacityBytes: this.maxBytes * (this.retain + 1), records: entries.length,
        warnings, errors, invalidRecords, counts, recent: limit ? entries.slice(-limit) : [],
        text: `近期诊断 ${entries.length} 条，收到消息事件 ${totalReceived} 次，发送记录 ${totalDelivered} 条，警告 ${warnings} 条，错误 ${errors} 条。日志占用 ${bytes}/${this.maxBytes * (this.retain + 1)} 字节；仅统计保留窗口。` };
    });
  }
}
