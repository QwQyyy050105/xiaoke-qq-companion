import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const loader = new URL('./fixtures/optional_dependency_guard.mjs', import.meta.url).href;
function run(source) {
  return spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', source],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

test('plain text startup and media validators work while heavy dependencies are unavailable', () => {
  const result = run(`
    const math = await import('./src/math_render.mjs');
    const speech = await import('./src/speech.mjs');
    await import('./src/owner_browser.mjs');
    math.validateMathDocument({title:'Example',summary:'',blocks:[{type:'math',content:'x+1'}]});
    if (!speech.speechRequest({content:'用语音说一句'})) throw Error('request failed');
    speech.validateSpeechText('hello');
    console.log('ready_without_media_dependencies');
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready_without_media_dependencies/);
});

test('using formula typesetting requests its real dependency on demand', () => {
  const result = run(`
    const math = await import('./src/math_render.mjs');
    await math.mathHtml({title:'Example',summary:'',blocks:[{type:'math',content:'x+1'}]});
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /optional_dependency_requested:katex/);
  assert.doesNotMatch(result.stderr, /optional_dependency_requested:playwright-core/);
});
