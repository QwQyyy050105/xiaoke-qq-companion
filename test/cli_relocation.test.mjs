import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));

test('init and doctor work after a partial restore when invoked from another directory', async t => {
  const temp = join(project, 'temp');
  await mkdir(temp, {recursive:true});
  const workspace = await mkdtemp(join(temp, 'cli_restore_'));
  t.after(() => rm(workspace, {recursive:true, force:true}));
  const restored = join(workspace, '小柯 #1');
  const caller = join(workspace, 'other directory');
  await mkdir(caller);
  await mkdir(restored);
  await cp(join(project, 'src'), join(restored, 'src'), {recursive:true});
  await copyFile(join(project, '.env.example'), join(restored, '.env.example'));
  const env = {PATH:caller, TMP:temp, TEMP:temp};
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const cli = (...args) => execute(process.execPath, [join(restored, 'src', 'cli.mjs'), ...args], {cwd:caller, env});

  const config = JSON.parse(await readFile(join(project, 'config.example.json'), 'utf8'));
  config.participation.timeZone = 'UTC';
  config.modelProvider.type = 'codex';
  const configPath = join(restored, 'config.local.json');
  const restoredConfig = JSON.stringify(config);
  await writeFile(configPath, restoredConfig);
  const envPath = join(restored, '.env');
  await cli('init');
  assert.equal(await readFile(configPath, 'utf8'), restoredConfig);
  assert.equal(await readFile(envPath, 'utf8'), await readFile(join(project, '.env.example'), 'utf8'));

  env.CODEX_CLI_PATH = join(workspace, 'old installation', 'codex');
  const checkModel = async () => {
    const {stdout} = await cli('doctor', '--json');
    const report = JSON.parse(stdout);
    assert.equal(report.networkTested, false);
    return report.checks.find(check => check.id === 'model').ok;
  };
  assert.equal(await checkModel(), false);
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const bin = join(workspace, 'new installation');
  await mkdir(bin);
  await writeFile(join(bin, executable), 'discovery only', {mode:0o700});
  env.PATH = bin;
  assert.equal(await checkModel(), true);

  await rm(configPath);
  const restoredEnv = '# already configured on this host\n';
  await writeFile(envPath, restoredEnv);
  await cli('init');
  assert.equal(await readFile(envPath, 'utf8'), restoredEnv);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).modelProvider.type, 'mock');
  assert.deepEqual(await readdir(caller), []);
});
