import test from 'node:test';
import assert from 'node:assert/strict';
import {scanText,scanFilename} from '../scripts/release_check.mjs';

test('release scan detects secrets without returning values', () => {
  const secret = 'gh' + 'p_' + 'a'.repeat(40);
  const hits = scanText('src/example.mjs','const token = "' + secret + '";');
  assert.equal(hits[0].rule,'github_token');
  assert.equal(JSON.stringify(hits).includes(secret),false);
});
test('release scan checks private identifiers with line locations', () => {
  const hits = scanText('README.md','one\nExampleSensitivePerson\n',['ExampleSensitivePerson']);
  assert.deepEqual(hits,[{file:'README.md',line:2,rule:'private_identifier_1'}]);
});
test('release scan rejects runtime, credentials and media files', () => {
  for (const file of ['.env','deployment.local.json','template.config.json','state/messages.json','photo.png','node_modules/example/index.js']) assert.ok(scanFilename(file).length > 0,file);
});
test('release scan permits safe public examples', () => {
  assert.deepEqual(scanFilename('.env.example'),[]);
  assert.deepEqual(scanFilename('config.example.json'),[]);
  assert.deepEqual(scanText('config.example.json','{"apiKeyEnv":"MODEL_API_KEY","model":"example-model"}'),[]);
});
test('release scan catches private key material', () => {
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  assert.equal(scanText('accidental.txt',header)[0].rule,'private_key');
});
