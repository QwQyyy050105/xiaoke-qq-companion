import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexExecutable } from '../src/codex_executable.mjs';

const temp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
async function fixture(t) {
  await fs.mkdir(temp, {recursive:true});
  const root = await fs.mkdtemp(path.join(temp, 'codex_resolution_'));
  assert.ok(root.startsWith(temp + path.sep));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  async function file(relative, mtime = Date.now()) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), {recursive:true});
    await fs.writeFile(target, 'fixture executable');
    await fs.utimes(target, new Date(mtime), new Date(mtime));
    return fs.realpath(target);
  }
  return {root, file, options:{platform:'win32',env:{LOCALAPPDATA:root,PATH:''}}};
}

test('an existing configured executable wins over environment and bundled updates', async t => {
  const f = await fixture(t), custom = await f.file('custom/codex.exe');
  const bundled = await f.file('OpenAI/Codex/bin/new/codex.exe');
  f.options.env.CODEX_CLI_PATH = bundled;
  assert.equal(await resolveCodexExecutable({codexPath:custom}, f.options), custom);
});

test('stale version directory recovers to a real executable and skips empty newer directories', async t => {
  const f = await fixture(t);
  await f.file('OpenAI/Codex/bin/old/codex.exe', 1000);
  const newest = await f.file('OpenAI/Codex/bin/new/codex.exe', 2000);
  await fs.mkdir(path.join(f.root, 'OpenAI/Codex/bin/newest-empty'));
  const config = {codexPath:path.join(f.root, 'removed/codex.exe')};
  assert.equal(await resolveCodexExecutable(config, f.options), newest);
  await fs.unlink(newest);
  const replacement = await f.file('OpenAI/Codex/bin/replacement/codex.exe', 3000);
  assert.equal(await resolveCodexExecutable(config, f.options), replacement);
});

test('explicit environment and absolute PATH entries work without a desktop installation', async t => {
  const f = await fixture(t), cli = await f.file('cli/codex.exe');
  f.options.env.CODEX_CLI_PATH = cli;
  assert.equal(await resolveCodexExecutable({}, f.options), cli);
  delete f.options.env.CODEX_CLI_PATH;
  f.options.env.PATH = ';relative_folder;' + path.dirname(cli);
  assert.equal(await resolveCodexExecutable({}, f.options), cli);
});

test('missing, zero-byte and directory candidates give a bounded error', async t => {
  const f = await fixture(t), empty = await f.file('OpenAI/Codex/bin/incomplete/codex.exe');
  await fs.truncate(empty, 0);
  await assert.rejects(resolveCodexExecutable({codexPath:f.root}, f.options), {message:'codex_executable_missing'});
});
