import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeMathDocument, mathDocumentText, isMathLayoutRequest } from '../src/math_document.mjs';
import { parseChatResponse, conversationPrompt } from '../src/model_client.mjs';
import { Companion } from '../src/core.mjs';
const ROOT = resolve(import.meta.dirname, '..');
const document = { title: '极限与渐近线', blocks: [
  { type: 'text', content: '先计算线性部分，再计算常数项。' },
  { type: 'math', content: '\\lim_{x\\to+\\infty}\\frac{f(x)}{x}=\\frac12' },
  { type: 'math', content: 'y=\\frac{x}{2}-\\frac34' }
], summary: '斜渐近线为 y=x/2−3/4。' };

test('bounded math document keeps LaTeX intact and invalid documents fall back without accepting paths', () => {
  assert.deepEqual(normalizeMathDocument(document), document);
  assert.equal(normalizeMathDocument(null), null);
  assert.equal(normalizeMathDocument({ ...document, outputPath: 'D:/secret' }), null);
  assert.equal(normalizeMathDocument({ ...document, blocks: [{ type: 'image', content: 'url' }] }), null);
  assert.equal(normalizeMathDocument({ ...document, blocks: Array.from({length:33},()=>({type:'text',content:'step'})) }), null);
  assert.equal(normalizeMathDocument({ ...document, blocks: Array.from({length:8},()=>({type:'math',content:'x'.repeat(4000)})) }), null);
  assert.match(mathDocumentText(document), /\\lim/);
});

test('math response preserves the entire readable fallback and cannot initiate an imagegen or sticker action', () => {
  const reply = '第一步：求 k=1/2。\n第二步：求 b=-3/4。\n所以斜渐近线是 y=x/2−3/4。';
  const result = parseChatResponse(JSON.stringify({ reply, messages: ['见图'], memories: [], math_document: document,
    media: { create_prompt: 'draw formulas', send_id: 'old-avatar', voice_id: 'voice_old' } }));
  assert.equal(result.reply, reply); assert.deepEqual(result.messages, []);
  assert.deepEqual(result.math_document, document);
  assert.equal(result.media.create_prompt, ''); assert.equal(result.media.send_id, ''); assert.equal(result.media.voice_id, '');
  const noReply = parseChatResponse(JSON.stringify({ reply:'', memories:[], math_document:document }));
  assert.match(noReply.reply, /先计算线性部分/); assert.match(noReply.reply, /\\frac34/);
});

test('core passes a mathematical document separately and records actual page delivery rather than claiming a PDF upload', async t => {
  const dataDir = await mkdtemp(join(ROOT, 'temp', 'math_core_')); t.after(() => rm(dataDir, { recursive:true, force:true }));
  const bot = await new Companion({dataDir,generate:async()=>({reply:'完整文字解答',messages:['不要替代完整步骤'],memories:[],
    math_document:document,media:{create_prompt:'not allowed',send_id:'not allowed'}})}).init();
  const event={id:'question',group_openid:'group',author:{member_openid:'alice'},content:'把解答做成图发我'};
  const result=await bot.handle(event,async(text,options)=>{
    assert.equal(text,'完整文字解答'); assert.deepEqual(options.math_document,document);
    assert.equal(options.media,undefined); assert.equal(options.messages,undefined);
    return {id:'actual-page',sent_text:'',delivered_messages:[{messageId:'actual-page',content:'[数学解答图片：极限与渐近线，第1/1页]'}]};
  });
  assert.equal(result.status,'replied');
  assert.match(bot.groupContext('group').at(-1).content,/数学解答图片/);
  assert.doesNotMatch(bot.groupContext('group').at(-1).content,/PDF已上传/);
});

test('math formatting is optional for short formulas, selected for dense derivations, and schema remains declarative', async () => {
  for(const content of ['把解答做成图发我','把这道题解答做成一张图片发我','公式排版成PDF']) assert.equal(isMathLayoutRequest({content}),true);
  assert.equal(isMathLayoutRequest({content:'画一张小柯开心的表情'}),false);
  assert.equal(isMathLayoutRequest({content:'> 把解答做成图发我\n你好'}),false);
  const prompt=conversationPrompt('角色',{runtimeCapabilities:{math:{available:true}},structured:true,text:'求极限'});
  assert.match(prompt,/math_document通常为null/); assert.match(prompt,/绝不能用media.create_prompt画公式/);
  assert.match(prompt,/reply同时给完整可读/); assert.match(prompt,/QQ实际发送PNG/);
  const schema=JSON.parse(await readFile(join(ROOT,'src/chat_response.schema.json'),'utf8'));
  assert.ok(schema.required.includes('math_document'));
  assert.equal(schema.properties.math_document.anyOf[0].type,'null');
  assert.deepEqual(schema.properties.math_document.anyOf[1].properties.blocks.items.properties.type.enum,['text','math']);
});
