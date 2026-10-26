import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { durableWriteFile } from '../src/durable_write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = path.join(ROOT, 'temp');
async function fixture(t) {
  await fs.mkdir(TEMP, { recursive: true });
  const root = await fs.mkdtemp(path.join(TEMP, 'durable_write_test_'));
  t.after(async () => {
    assert.equal(path.dirname(root), TEMP);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('sync failure leaves the previous committed file untouched and removes the unfinished sibling', async t => {
  const root = await fixture(t), target = path.join(root, 'state.json');
  const original = '{"committed":"先前记录"}\n';
  await fs.writeFile(target, original);
  let closed = false, renamed = false;
  const io = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      return {
        writeFile: (...values) => handle.writeFile(...values),
        sync: async () => { throw Object.assign(new Error('simulated_flush_failure'), { code: 'EIO' }); },
        close: async () => { await handle.close(); closed = true; }
      };
    },
    rename: async () => { renamed = true; assert.fail('unflushed file must not be published'); }
  };
  await assert.rejects(durableWriteFile(target, '{"committed":"new"}', { io }), { code: 'EIO' });
  assert.equal(closed, true); assert.equal(renamed, false);
  assert.equal(await fs.readFile(target, 'utf8'), original);
  assert.deepEqual(await fs.readdir(root), ['state.json']);
});

test('concurrent writes use distinct sibling files, close after sync, and only publish a whole payload', async t => {
  const root = await fixture(t), target = path.join(root, 'state.json');
  const names = new Set(), events = new Map();
  let publication = Promise.resolve();
  const payloads = Array.from({ length: 12 }, (_, i) => JSON.stringify({ i, text: 'complete-payload-'.repeat(100) }));
  const io = {
    ...fs,
    async open(file, ...args) {
      assert.equal(path.dirname(file), root);
      assert.ok(!names.has(file)); names.add(file); events.set(file, []);
      const handle = await fs.open(file, ...args);
      return {
        writeFile: async (...values) => { await handle.writeFile(...values); events.get(file).push('write'); },
        sync: async () => { await handle.sync(); events.get(file).push('sync'); },
        close: async () => { await handle.close(); events.get(file).push('close'); }
      };
    },
    async rename(from, to) {
      assert.deepEqual(events.get(from), ['write', 'sync', 'close']);
      // Production owners keep same-target writes ordered. This fixture overlaps
      // temporary writes while serializing publication, including on Windows.
      const next = publication.then(() => fs.rename(from, to));
      publication = next.catch(() => {});
      await next;
    }
  };
  const results = await Promise.allSettled(payloads.map(payload => durableWriteFile(target, payload, { io })));
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message);
  assert.equal(names.size, payloads.length);
  assert.ok(payloads.includes(await fs.readFile(target, 'utf8')));
  assert.deepEqual(await fs.readdir(root), ['state.json']);
});

test('rename failure preserves prior committed contents and cleans up the synced temporary file', async t => {
  const root = await fixture(t), target = path.join(root, 'state.json');
  await fs.writeFile(target, 'old');
  await assert.rejects(durableWriteFile(target, 'new', { io: {
    ...fs, rename: async () => { throw Object.assign(new Error('simulated_replace_failure'), { code: 'EACCES' }); }
  } }), { code: 'EACCES' });
  assert.equal(await fs.readFile(target, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(root), ['state.json']);
});

test('Windows runtime host writer creates and replaces UTF-8 status without running startup', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'data'));
  const quote = text => "'" + text.replaceAll("'", "''") + "'";
  const script = path.join(root, 'verify_host_writer.ps1');
  await fs.writeFile(script, `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.join(ROOT, 'Start.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Start.ps1 parse failed' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-CompanionRuntimeHost' }, $true)
if (-not $definition) { throw 'runtime writer missing' }
. ([scriptblock]::Create($definition.Extent.Text))
Write-CompanionRuntimeHost -Root ${quote(root)} -Record @{ status='running'; pid=123 }
Write-CompanionRuntimeHost -Root ${quote(root)} -Record @{ status='exited'; pid=123; exitCode=0 }
`);
  await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: root, windowsHide: true, env: { ...process.env, TEMP, TMP: TEMP }, timeout: 15000 });
  const bytes = await fs.readFile(path.join(root, 'data', 'runtime_host.json'));
  assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(bytes.includes(0), false);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), { status: 'exited', pid: 123, exitCode: 0 });
  assert.deepEqual(await fs.readdir(path.join(root, 'data')), ['runtime_host.json']);
});
