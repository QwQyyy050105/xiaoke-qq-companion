import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ignoredDirectories = new Set(['.git', '.test_tmp', 'node_modules', 'data', 'state', 'runtime', 'temp', 'cache', 'logs', '.npm_cache', '.pip_cache', '__pycache__']);
const textExtensions = new Set(['.mjs','.cjs','.js','.json','.md','.txt','.yml','.yaml','.py','.html','.css','.toml','.ps1','.cmd','.bat','.sh','.xml','.example','.ini','.cfg']);
const tokenRules = [
  ['github_token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['api_secret', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/g],
  ['aws_access_key', /\bAKIA[A-Z0-9]{16}\b/g],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['developer_path', /[A-Za-z]:[\\/](?:Users|Projects|SnowLuma|TTS|dy)[\\/][^\s"'<>]*/gi],
  ['credential_url', /https?:\/\/[A-Za-z0-9_.-]+:[^@\s/]{8,}@(?!example[.])[^/\s]+/g],
];
function location(text, index) { return text.slice(0,index).split('\n').length; }
export function scanText(relative, text, privateRules = []) {
  const findings = [];
  for (const [rule, re] of tokenRules) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) findings.push({file:relative,line:location(text,match.index),rule});
  }
  for (let i = 0; i < privateRules.length; i++) {
    const value = privateRules[i];
    if (typeof value !== 'string' || value.length < 2) continue;
    let at = text.indexOf(value);
    while (at >= 0) {
      findings.push({file:relative,line:location(text,at),rule:'private_identifier_' + (i + 1)});
      at = text.indexOf(value,at + value.length);
    }
  }
  return findings;
}
export function scanFilename(relative) {
  const name = path.posix.basename(relative.replaceAll('\\','/'));
  const pieces = relative.replaceAll('\\','/').split('/');
  const findings = [];
  const privateNames = new Set(['config.local.json','deployment.local.json','template.config.json','bridge_config.json','config.json','credentials.xml','character_card.local.json','group_profiles.local.json']);
  if (privateNames.has(name) || (name.startsWith('.env') && name !== '.env.example')) findings.push({file:relative,rule:'private_configuration'});
  if (pieces.some(p => ignoredDirectories.has(p))) findings.push({file:relative,rule:'generated_or_runtime_file'});
  if (/\.(?:db|db3|sqlite|sqlite3|enc|pem|pfx|p12|key|lnk|exe|dll|zip|7z|log|bak|mp3|wav|silk|amr|mp4|jpg|jpeg|png|webp)$/i.test(name)) findings.push({file:relative,rule:'binary_or_private_artifact'});
  return findings;
}
async function walk(root, dir = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const relative = path.posix.join(dir,entry.name);
    if (entry.isSymbolicLink()) { result.push(relative); continue; }
    if (entry.isDirectory()) result.push(...await walk(root,relative));
    else result.push(relative);
  }
  return result;
}
export async function candidateFiles(root) {
  // Use this repository only; never accidentally include a parent checkout.
  try {
    await fs.access(path.join(root,'.git'));
    const r = spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',windowsHide:true});
    if (r.status !== 0) throw new Error('git_inventory_failed');
    return [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
  } catch (error) {
    if (error.message === 'git_inventory_failed') throw error;
    return (await walk(root)).sort();
  }
}
export async function checkRelease(root, {privateRules=[]} = {}) {
  const policy = JSON.parse(await fs.readFile(path.join(root,'.release-policy.json'),'utf8'));
  const files = await candidateFiles(root);
  const findings = [];
  for (const required of policy.requiredFiles) {
    if (!files.includes(required)) findings.push({file:required,rule:'required_file_missing'});
  }
  for (const relative of files) {
    findings.push(...scanFilename(relative));
    const absolute = path.resolve(root,relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) { findings.push({file:relative,rule:'path_escape'}); continue; }
    let stat;
    try { stat = await fs.lstat(absolute); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink()) { findings.push({file:relative,rule:'symlink_in_release'}); continue; }
    if (stat.size > policy.maxSourceBytes) { findings.push({file:relative,rule:'oversized_source'}); continue; }
    if (!textExtensions.has(path.extname(relative)) && !['LICENSE','.gitignore','.env.example'].includes(path.basename(relative))) continue;
    const text = await fs.readFile(absolute,'utf8');
    findings.push(...scanText(relative,text,privateRules));
  }
  const pkg = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
  if (pkg.name !== policy.packageName) findings.push({file:'package.json',rule:'package_name_mismatch'});
  if (lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name) findings.push({file:'package-lock.json',rule:'lock_name_mismatch'});
  if (!pkg.license || !pkg.engines?.node) findings.push({file:'package.json',rule:'license_or_node_version_missing'});
  for (const script of ['init','doctor','demo','test','check:release']) {
    if (!pkg.scripts?.[script]) findings.push({file:'package.json',rule:'required_script_' + script});
  }
  for (const name of Object.keys(lock.packages ?? {})) {
    if (policy.forbiddenPackages.some(p => name.endsWith('node_modules/' + p))) findings.push({file:'package-lock.json',rule:'nonredistributable_dependency'});
    if (/^(?:file:|[A-Za-z]:[\\/])/.test(lock.packages[name]?.resolved ?? '')) findings.push({file:'package-lock.json',rule:'local_dependency'});
  }
  return {ok:findings.length === 0,package:pkg.name,candidateFileCount:files.length,privateRulesChecked:privateRules.length,findings};
}
async function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  let privateRules = [];
  const index = args.indexOf('--private-rules');
  if (index >= 0) {
    if (!args[index+1]) throw new Error('private_rules_path_required');
    const external = JSON.parse(await fs.readFile(path.resolve(args[index+1]),'utf8'));
    privateRules = Array.isArray(external) ? external : external.values;
    if (!Array.isArray(privateRules)) throw new Error('private_rules_array_required');
  }
  const result = await checkRelease(root,{privateRules});
  if (args.includes('--json')) process.stdout.write(JSON.stringify(result,null,2) + '\n');
  else {
    process.stdout.write((result.ok ? 'PASS' : 'FAIL') + ' release scan: ' + result.candidateFileCount + ' candidate files; ' + result.privateRulesChecked + ' private rules\n');
    for (const item of result.findings) process.stdout.write(item.file + (item.line ? ':'+item.line : '') + ' [' + item.rule + '] value redacted\n');
  }
  process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { process.stderr.write('Release scan failed: ' + e.message + '\n'); process.exitCode = 1; });
