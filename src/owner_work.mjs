import {isAbsolute as isPortableAbsolute} from 'node:path';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const sha = text => createHash('sha256').update(text).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(['queued', 'running', 'awaiting_answer', 'awaiting_approval', 'applying', 'approved', 'rejected', 'canceled', 'failed', 'expired']);
const PENDING = new Set(['queued', 'running', 'awaiting_answer', 'awaiting_approval']);
const EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.html', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.sql', '.tex', '.xml', '.svg']);
const MAX_FILES = 12, MAX_FILE_BYTES = 64 * 1024, MAX_TOTAL_BYTES = 256 * 1024, MAX_JOBS = 100;
const fail = code => Object.assign(new Error(code), { code });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (base, file) => { const relative = path.relative(base, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const ordered = files => files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const boundedText = (value, max) => typeof value === 'string' && [...value].length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

function validRelative(file) {
  if (typeof file !== 'string' || file.length > 200 || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes('\\')) return false;
  const parts = file.split('/');
  if (parts.length > 6 || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    || /^(?:credentials?|secrets?|passwords?|tokens?|auth|authentication|cookies?|sessions?|keychain|id_rsa|id_ed25519|known_hosts|authorized_keys|config\.local)(?:[._-]|$)/i.test(part))) return false;
  return EXTENSIONS.has(path.posix.extname(file).toLowerCase());
}
function validContent(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= MAX_FILE_BYTES
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    && Buffer.from(value).toString('utf8') === value
    && !/-----BEGIN[^\r\n]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|(?:app[_ -]?secret|api[_ -]?key|access[_ -]?token|password|密码|密钥)["']?\s*[:=：]\s*["']?[^\s"']+|data:[^;\s]+;base64,|[A-Za-z0-9+/]{1024,}={0,2}/i.test(value);
}
function proposalValue(value) {
  if (!value || Object.keys(value).some(key => !['question', 'summary', 'files'].includes(key))
    || !boundedText(value.question, 1000) || !boundedText(value.summary, 2000) || !Array.isArray(value.files) || value.files.length > MAX_FILES) throw fail('owner_work_invalid_proposal');
  const keys = new Set(); let bytes = 0;
  const files = value.files.map(file => {
    if (!file || Object.keys(file).some(key => !['path', 'content'].includes(key)) || !validRelative(file.path) || !validContent(file.content)
      || keys.has(file.path.toLowerCase())) throw fail('owner_work_invalid_file');
    keys.add(file.path.toLowerCase()); bytes += Buffer.byteLength(file.content);
    return { path: file.path, content: file.content };
  });
  if (bytes > MAX_TOTAL_BYTES || (value.question.trim() && files.length)) throw fail('owner_work_invalid_proposal');
  for (const key of keys) if ([...keys].some(other => other !== key && other.startsWith(key + '/'))) throw fail('owner_work_path_conflict');
  return { question: value.question.trim(), summary: value.summary.trim(), files: ordered(files) };
}
async function directory(base, parts, create = false) {
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (!inside(base, current)) throw fail('owner_work_path_boundary');
    if (create) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(current), current)) throw fail('owner_work_path_boundary');
  }
  return current;
}
async function readFile(file, limit = MAX_TOTAL_BYTES * 2 + 16384) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw fail('owner_work_file_boundary');
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size) throw fail('owner_work_file_changed');
    const bytes = Buffer.alloc(info.size + 1); let count = 0;
    while (count < bytes.length) { const next = await handle.read(bytes, count, bytes.length - count, count); if (!next.bytesRead) break; count += next.bytesRead; }
    if (count !== info.size) throw fail('owner_work_file_changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } finally { await handle.close(); }
}
async function atomicJson(base, name, value) {
  const target = path.join(base, name), temporary = path.join(base, `${name}.${randomUUID()}.tmp`);
  try { const info = await fs.lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw fail('owner_work_file_boundary'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, target); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function workspaceFiles(workspace) {
  const files = []; let bytes = 0;
  async function visit(base, prefix = '') {
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      const relative = prefix + entry.name, file = path.join(base, entry.name);
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) throw fail('owner_work_path_boundary');
      if (info.isDirectory()) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name) || relative.split('/').length >= 6) throw fail('owner_work_path_boundary');
        await directory(workspace, relative.split('/')); await visit(file, relative + '/');
      } else {
        if (!validRelative(relative) || files.length >= MAX_FILES) throw fail('owner_work_invalid_file');
        const content = await readFile(file, MAX_FILE_BYTES);
        if (!validContent(content)) throw fail('owner_work_invalid_file');
        bytes += Buffer.byteLength(content); if (bytes > MAX_TOTAL_BYTES) throw fail('owner_work_size_limit');
        files.push({ path: relative, content });
      }
    }
  }
  await visit(workspace); return ordered(files);
}
const baselineOf = files => files.map(file => ({ path: file.path, sha256: sha(file.content) }));
const approvalHash = (job, proposal) => sha(JSON.stringify({ version: 1, id: job.id, ownerHash: job.ownerHash,
  createdAt: job.createdAt, expiresAt: job.expiresAt, task: job.task, answer: job.answer, answerSources: job.answerSources, baseline: job.baseline, proposal }));

export class OwnerWorkQueue {
  static async open(options) { const queue = new OwnerWorkQueue(options); await queue.init(); return queue; }
  constructor({ root, getOwner, generateProposal, now = Date.now, log = () => {}, ttlMs = 86400000, modelTimeoutMs = 180000 } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof getOwner !== 'function' || typeof generateProposal !== 'function'
      || typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000
      || !Number.isSafeInteger(modelTimeoutMs) || modelTimeoutMs < 1 || modelTimeoutMs > 180000) throw fail('owner_work_invalid_options');
    Object.assign(this, { root, getOwner, generateProposal, now, log, ttlMs, modelTimeoutMs });
    this.jobs = new Map(); this.pending = []; this.active = new Map(); this.commands = Promise.resolve(); this.draining = false; this.stopped = false;
  }
  async init() {
    this.root = await fs.realpath(this.root);
    if (process.platform === 'win32' && !isPortableAbsolute(this.root)) throw fail('owner_work_requires_d_storage');
    this.base = await directory(this.root, ['data', 'owner_work', 'jobs'], true);
    const entries = await fs.readdir(this.base, { withFileTypes: true });
    if (entries.length > MAX_JOBS) throw fail('owner_work_capacity');
    for (const entry of entries) {
      if (!UUID.test(entry.name)) continue;
      try {
        const base = await this.jobDirectory(entry.name);
        const job = JSON.parse(await readFile(path.join(base, 'job.json'), 131072));
        if (!this.validJob(job, entry.name)) throw fail('owner_work_invalid_record');
        this.jobs.set(job.id, job);
        if (['queued', 'running', 'applying'].includes(job.status)) {
          job.summary = job.status === 'applying' ? '上次应用过程被中断，工作目录可能包含已批准结果；没有自动重复应用。' : '上次处理被中断，没有自动重复生成；请创建新任务。';
          job.status = 'failed'; await this.save(job);
        } else await this.expire(job);
      } catch { this.log('主人任务记录无法安全恢复，已跳过该记录。'); }
    }
  }
  validJob(job, id) {
    return job && job.version === 1 && job.id === id && UUID.test(id) && HASH.test(job.ownerHash) && HASH.test(job.sourceHash)
      && STATES.has(job.status) && boundedText(job.task, 4000) && boundedText(job.answer, 12000)
      && boundedText(job.question, 1000) && boundedText(job.summary, 2000)
      && Number.isSafeInteger(job.createdAt) && Number.isSafeInteger(job.expiresAt) && job.expiresAt > job.createdAt && job.expiresAt - job.createdAt <= 86400000
      && Number.isSafeInteger(job.updatedAt) && Number.isInteger(job.rounds) && job.rounds >= 0 && job.rounds <= 5
      && Array.isArray(job.answerSources) && job.answerSources.length <= 5 && job.answerSources.every(value => HASH.test(value))
      && Array.isArray(job.baseline) && job.baseline.length <= MAX_FILES && job.baseline.every(file => validRelative(file?.path) && HASH.test(file?.sha256))
      && (job.proposalHash === '' || HASH.test(job.proposalHash));
  }
  serialize(work) { const task = this.commands.catch(() => {}).then(work); this.commands = task.catch(() => {}); return task; }
  jobDirectory(id) { if (!UUID.test(id)) throw fail('owner_work_invalid_id'); return directory(this.base, [id]); }
  async save(job) { job.updatedAt = this.now(); await atomicJson(await this.jobDirectory(job.id), 'job.json', job); }
  async expire(job) {
    if (PENDING.has(job.status) && this.now() >= job.expiresAt) {
      this.active.get(job.id)?.abort(fail('owner_work_expired')); job.status = 'expired'; job.summary = '任务已超过有效期，旧审批与回答均已失效。'; await this.save(job);
    }
  }
  snapshot() {
    const labels = { queued: '等待处理', running: '正在准备文字文件提案', awaiting_answer: '等待主人补充答案', awaiting_approval: '等待主人审批文件提案', applying: '正在应用已批准提案', approved: '已应用至独立工作目录', rejected: '提案已拒绝', canceled: '任务已取消', failed: '任务处理失败', expired: '任务已过期' };
    return [...this.jobs.values()].map(job => ({ id: job.id, status: PENDING.has(job.status) && this.now() >= job.expiresAt ? 'expired' : job.status,
      summary: labels[PENDING.has(job.status) && this.now() >= job.expiresAt ? 'expired' : job.status] }));
  }
  async handle(event, text) {
    const match = typeof text === 'string' && text.trim().match(/^\/(work|workstatus|approve|reject|cancel|answer)(?:\s+([\s\S]*))?$/i);
    if (!match) return { handled: false, reply: '' };
    const command = match[1].toLowerCase(), argument = (match[2] || '').trim();
    let owner; try { owner = await this.getOwner(); } catch {}
    const sender = event?.author?.user_openid ?? event?.author?.openid ?? event?.author?.id;
    if (typeof owner !== 'string' || !owner || sender !== owner || event?.group_openid
      || (event?.chat_type && event.chat_type !== 'private') || event?.is_self || event?.author?.bot) {
      return { handled: true, reply: '这些工作与审批命令只接受已绑定主人的私聊。' };
    }
    return this.serialize(async () => {
      if (this.stopped) return { handled: true, reply: '工作服务已停止，当前没有启动新操作。' };
      if (await this.getOwner() !== owner) return { handled: true, reply: '主人绑定已变化，本次命令没有执行。' };
      try { return { handled: true, reply: await this.command(command, argument, event, sha(owner)) }; }
      catch { this.log('主人工作操作未完成，未绕过文件或审批检查。'); return { handled: true, reply: '这次工作操作未完成，文件或审批校验没有通过；没有自动重试，请查看 /workstatus。' }; }
    });
  }
  async command(command, argument, event, ownerHash) {
    for (const job of this.jobs.values()) if (job.ownerHash === ownerHash) await this.expire(job);
    if (command === 'work') {
      if (!argument || !boundedText(argument, 4000)) return '用 /work 任务内容 创建任务，正文最多 4000 字。';
      if (typeof event?.id !== 'string' || !event.id || event.id.length > 512) return '消息缺少可核验编号，没有创建任务。';
      const sourceHash = sha(JSON.stringify([ownerHash, event.id]));
      const old = [...this.jobs.values()].find(job => job.sourceHash === sourceHash && job.ownerHash === ownerHash);
      if (old) return `这条消息已创建任务 ${old.id}，没有重复执行。\n/workstatus ${old.id}`;
      if (this.jobs.size >= MAX_JOBS || [...this.jobs.values()].filter(job => ['queued', 'running'].includes(job.status)).length >= 8) return '工作队列已达到保留或排队上限，没有另建任务。';
      const id = randomUUID(), createdAt = this.now();
      const base = await directory(this.base, [id], true); await directory(base, ['workspace'], true);
      const job = { version: 1, id, ownerHash, sourceHash, status: 'queued', task: argument, answer: '', question: '', summary: '',
        createdAt, updatedAt: createdAt, expiresAt: createdAt + this.ttlMs, rounds: 0, answerSources: [], baseline: [], proposalHash: '' };
      this.jobs.set(id, job); await this.save(job); this.pending.push(id); this.schedule();
      return `工作任务 ${id} 已排队。模型只会准备文本文件提案，尚未应用文件。\n/workstatus ${id}`;
    }
    if (command === 'workstatus' && !argument) {
      const jobs = [...this.jobs.values()].filter(job => job.ownerHash === ownerHash).slice(-10).reverse();
      return jobs.length ? jobs.map(job => `${job.id} — ${job.status}\n/workstatus ${job.id}`).join('\n\n') : '目前没有主人工作任务。';
    }
    const split = argument.match(/^([^\s]+)(?:\s+([\s\S]*))?$/), id = split?.[1], answer = split?.[2]?.trim() || '';
    const job = UUID.test(id || '') ? this.jobs.get(id) : null;
    if (!job || job.ownerHash !== ownerHash) return '没有找到属于当前主人的有效任务编号。';
    if (command !== 'answer' && answer) return `此命令只接受任务编号：/${command} ${job.id}`;
    if (command === 'workstatus') return this.describe(job);
    if (!PENDING.has(job.status)) return `任务 ${job.id} 当前状态为 ${job.status}，旧审批不能重复使用。`;
    if (command === 'cancel' || command === 'reject') {
      this.active.get(id)?.abort(fail('owner_work_canceled')); job.status = command === 'cancel' ? 'canceled' : 'rejected';
      job.summary = command === 'cancel' ? '主人已取消任务，没有继续应用提案。' : '主人已拒绝提案，没有应用文件。'; await this.save(job);
      return `任务 ${id} 已${command === 'cancel' ? '取消' : '拒绝'}，旧审批已失效。`;
    }
    if (command === 'answer') {
      if (typeof event?.id !== 'string' || !event.id || event.id.length > 512) return '消息缺少可核验编号，没有继续运行。';
      const answerSource = sha(JSON.stringify([ownerHash, event.id]));
      if (job.answerSources.includes(answerSource)) return `这条回答已经处理过，没有重复推进任务 ${id}。`;
      if (job.status !== 'awaiting_answer') return `任务 ${id} 当前没有等待回答的问题。`;
      if (!answer || !boundedText(answer, 4000) || [...job.answer, ...answer].length > 10000 || job.rounds >= 5) return '答案为空、过长或已达到补充轮数上限，没有继续运行。';
      const combined = `${job.answer}${job.answer ? '\n\n' : ''}问题：${job.question}\n主人回答：${answer}`;
      if (!boundedText(combined, 12000)) return '累计回答过长，没有继续运行。';
      job.answer = combined; job.answerSources.push(answerSource); job.question = ''; job.status = 'queued'; job.proposalHash = ''; await this.save(job); this.pending.push(id); this.schedule();
      return `任务 ${id} 已收到回答并继续准备提案；这不代表批准应用。\n/workstatus ${id}`;
    }
    if (command === 'approve') {
      if (job.status !== 'awaiting_approval') return `任务 ${id} 还没有可批准的提案。`;
      return this.approve(job);
    }
    return '未知工作命令。';
  }
  async readProposal(job) {
    const base = await this.jobDirectory(job.id);
    const disk = JSON.parse(await readFile(path.join(base, 'job.json'), 131072));
    if (JSON.stringify(disk) !== JSON.stringify(job)) throw fail('owner_work_record_changed');
    const proposal = proposalValue(JSON.parse(await readFile(path.join(base, 'proposal.json'))));
    if (approvalHash(job, proposal) !== job.proposalHash) throw fail('owner_work_proposal_changed');
    return proposal;
  }
  async describe(job) {
    const heading = `任务 ${job.id}\n状态：${job.status}`;
    if (job.status === 'awaiting_answer') return `${heading}\n${job.question}\n/answer ${job.id} 你的答案`;
    if (job.status !== 'awaiting_approval') return `${heading}${job.summary ? '\n' + job.summary : ''}${job.status === 'approved' ? '\n文件目录：data/owner_work/jobs/' + job.id + '/workspace' : ''}`;
    try {
      const proposal = await this.readProposal(job);
      const files = proposal.files.map(file => `${file.path}（${Buffer.byteLength(file.content)} 字节，SHA-256 ${sha(file.content)}）\n${[...file.content].slice(0, 80).join('')}${[...file.content].length > 80 ? '\n…' : ''}`).join('\n\n');
      return `${heading}\n${[...proposal.summary].slice(0, 500).join('')}\n提案校验：${job.proposalHash}\n${files || '提案没有文件变更。'}\n完整提案：data/owner_work/jobs/${job.id}/proposal.json\n确认应用：/approve ${job.id}\n拒绝：/reject ${job.id}`;
    } catch { job.status = 'failed'; job.summary = '提案内容或任务记录已变化，旧审批已失效。'; await this.save(job); return `${heading}\n${job.summary}`; }
  }
  schedule() { if (!this.draining && !this.stopped) { this.draining = true; queueMicrotask(() => this.drain().catch(() => this.log('主人工作队列未完成。')).finally(() => { this.draining = false; if (this.pending.length && !this.stopped) this.schedule(); })); } }
  async drain() {
    while (this.pending.length && !this.stopped) {
      const id = this.pending.shift(), job = this.jobs.get(id); if (!job) continue;
      const controller = new AbortController(); let files, timer, rejectAbort;
      try {
        const ready = await this.serialize(async () => {
          await this.expire(job); if (job.status !== 'queued' || this.stopped) return false;
          const workspace = await directory(await this.jobDirectory(id), ['workspace']); files = await workspaceFiles(workspace);
          job.baseline = baselineOf(files); job.status = 'running'; job.rounds++; await this.save(job); this.active.set(id, controller); return true;
        });
        if (!ready) continue;
        const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason || fail('owner_work_canceled')); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
        timer = setTimeout(() => controller.abort(fail('owner_work_timeout')), Math.min(this.modelTimeoutMs, Math.max(1, job.expiresAt - this.now()))); timer.unref?.();
        const generated = await Promise.race([Promise.resolve().then(() => this.generateProposal({ task: job.task, answer: job.answer, files, signal: controller.signal })), aborted]);
        await this.serialize(async () => {
          await this.expire(job); if (controller.signal.aborted || job.status !== 'running' || this.stopped) return;
          const proposal = proposalValue(generated);
          const current = await workspaceFiles(await directory(await this.jobDirectory(id), ['workspace']));
          if (JSON.stringify(baselineOf(current)) !== JSON.stringify(job.baseline)) throw fail('owner_work_baseline_changed');
          job.summary = proposal.summary; job.question = proposal.question;
          if (proposal.question) job.status = 'awaiting_answer';
          else {
            await atomicJson(await this.jobDirectory(id), 'proposal.json', proposal);
            job.proposalHash = approvalHash(job, proposal); job.status = 'awaiting_approval';
          }
          await this.save(job);
        });
      } catch (error) {
        await this.serialize(async () => {
          if (!['queued', 'running'].includes(job.status)) return;
          job.status = this.now() >= job.expiresAt ? 'expired' : 'failed';
          job.summary = error?.code === 'owner_work_timeout' ? '模型处理超过 180 秒上限，本次没有生成可审批结果。' : '模型结果或工作目录未通过安全校验，没有应用文件。'; await this.save(job);
        });
      } finally { clearTimeout(timer); if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort); this.active.delete(id); }
    }
  }
  async approve(job) {
    let proposal, original;
    try {
      proposal = await this.readProposal(job);
      original = await workspaceFiles(await directory(await this.jobDirectory(job.id), ['workspace']));
      if (JSON.stringify(baselineOf(original)) !== JSON.stringify(job.baseline) || this.now() >= job.expiresAt) throw fail('owner_work_baseline_changed');
    } catch { job.status = 'failed'; job.summary = '提案、原文件或有效期已变化，旧审批已失效；没有应用文件。'; await this.save(job); return `任务 ${job.id}：${job.summary}`; }
    job.status = 'applying'; await this.save(job);
    const base = await this.jobDirectory(job.id), stageName = `workspace_stage_${randomUUID()}`, backupName = `workspace_backup_${randomUUID()}`;
    const stage = await directory(base, [stageName], true), workspace = path.join(base, 'workspace'), backup = path.join(base, backupName);
    let moved = false, committed = false;
    try {
      const merged = new Map(original.map(file => [file.path.toLowerCase(), file]));
      for (const file of proposal.files) merged.set(file.path.toLowerCase(), file);
      if (merged.size > MAX_FILES || [...merged.values()].reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > MAX_TOTAL_BYTES) throw fail('owner_work_size_limit');
      for (const file of merged.values()) {
        const parts = file.path.split('/'), name = parts.pop(); const folder = await directory(stage, parts, true);
        await fs.writeFile(path.join(folder, name), file.content, { flag: 'wx', mode: 0o600 });
      }
      if (JSON.stringify(baselineOf(await workspaceFiles(await directory(base, ['workspace'])))) !== JSON.stringify(job.baseline) || this.now() >= job.expiresAt) throw fail('owner_work_baseline_changed');
      await fs.rename(workspace, backup); moved = true;
      await fs.rename(stage, workspace); committed = true;
      job.status = 'approved'; job.summary = `已将 ${proposal.files.length} 个批准的文本文件应用到本任务工作目录。`; await this.save(job);
      return `任务 ${job.id} 已应用，审批已使用，不能重复执行。\n${proposal.files.map(file => file.path).join('\n')}\n目录：data/owner_work/jobs/${job.id}/workspace`;
    } catch {
      if (moved && !committed) await fs.rename(backup, workspace);
      job.status = 'failed'; job.summary = committed ? '批准的文件已经写入，但完成记录未能保存；没有自动重复应用。' : '应用提案未完成，原工作目录已保留；旧审批已失效。'; await this.save(job);
      return `任务 ${job.id}：${job.summary}`;
    } finally {
      for (const target of committed ? [stage, backup] : [stage]) {
        if (!inside(base, target)) continue;
        try { if (samePath(await fs.realpath(target), target) && !(await fs.lstat(target)).isSymbolicLink()) await fs.rm(target, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'ENOENT') this.log('主人任务应用临时目录清理未完成。'); }
      }
    }
  }
  async stop() {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort(fail('owner_work_canceled'));
    return this.serialize(async () => { for (const job of this.jobs.values()) if (['queued', 'running'].includes(job.status)) { job.status = 'canceled'; job.summary = '工作服务已停止，本次没有继续生成或应用。'; await this.save(job); } });
  }
}
