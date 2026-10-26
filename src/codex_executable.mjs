import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// Desktop updates replace the versioned bin directory. Recheck for every call;
// a cached/configured path must not keep the companion offline after an update.
export async function resolveCodexExecutable(config = {}, { env = process.env, platform = process.platform } = {}) {
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  async function existing(candidate) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
    try {
      const info = await stat(candidate);
      return info.isFile() && info.size > 0 ? await realpath(candidate) : null;
    } catch { return null; }
  }
  for (const candidate of [config.codexPath, env.CODEX_CLI_PATH]) {
    const found = await existing(candidate);
    if (found) return found;
  }
  // Ignore implicit cwd entries: QQ text must never influence executable lookup.
  const searchPath = env.PATH ?? env.Path ?? '';
  for (const directory of searchPath.split(platform === 'win32' ? ';' : ':')) {
    if (!path.isAbsolute(directory)) continue;
    const found = await existing(path.join(directory, executable));
    if (found) return found;
  }
  if (platform === 'win32' && env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)) {
    const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    let entries = [];
    try { entries = await readdir(bin, { withFileTypes: true }); } catch {}
    const candidates = [];
    for (const entry of entries.filter(entry => entry.isDirectory())) {
      const candidate = await existing(path.join(bin, entry.name, executable));
      if (candidate) {
        try { candidates.push({ path: candidate, modified: (await stat(candidate)).mtimeMs }); } catch {}
      }
    }
    candidates.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
    if (candidates.length) return candidates[0].path;
  }
  throw new Error('codex_executable_missing');
}
