import test from 'node:test';
import assert from 'node:assert/strict';
import {mathChatRows,mathChatGroups,mathChatHtml,mathHtml,renderMathChatPreview} from '../src/math_render.mjs';

const doc={title:'参数曲线',summary:'斜渐近线',blocks:[{type:'text',content:'先求斜率，再求截距。'},{type:'math',content:'y=\\frac12x-\\frac34'}]};
test('QQ presentation separates aligned rows while preserving all mathematical operands and operators',()=>{
  assert.deepEqual(mathChatRows('\\begin{aligned}y-\\frac{x}{2}&=\\frac{t}{t^2-1}-\\frac{x}{2}\\\\&=-\\frac{t(t+2)}{2(t+1)}\\end{aligned}'),['y-\\frac{x}{2}=\\frac{t}{t^2-1}-\\frac{x}{2}','=-\\frac{t(t+2)}{2(t+1)}']);
});
test('QQ presentation preserves nested environments, escaped ampersands, braced linebreaks and paired delimiters',()=>{
  const nested='\\begin{matrix}a&b\\\\c&d\\end{matrix}';
  assert.deepEqual(mathChatRows('\\begin{aligned}A&='+nested+'\\\\B&=2\\end{aligned}'),['A='+nested,'B=2']);
  assert.deepEqual(mathChatRows('\\begin{aligned}x&=\\text{a \\& b}\\\\y&=\\left(1+2\\right)\\end{aligned}'),['x=\\text{a \\& b}','y=\\left(1+2\\right)']);
  const spaced='\\begin{aligned}x&=1\\\\[2pt]y&=2\\end{aligned}';
  assert.deepEqual(mathChatRows(spaced),[spaced]);
  assert.deepEqual(mathChatRows('x=\\frac{a}{b}'),['x=\\frac{a}{b}']);
});
test('QQ groups keep each parameter and branch right-hand value together and place continuation equality first',()=>{
  assert.deepEqual(mathChatGroups('x=\\frac{t^2}{t-1},\\qquad y=\\frac{t}{t^2-1},\\qquad t\\ne\\pm1'),['x=\\frac{t^2}{t-1},','y=\\frac{t}{t^2-1},','t\\ne\\pm1']);
  assert.deepEqual(mathChatGroups('t\\to-1 :~ x\\to-\\frac12 \\text{（垂直渐近线）}'),['t\\to-1 :~ x\\to-\\frac12','\\text{（垂直渐近线）}']);
  assert.deepEqual(mathChatGroups('k=\\lim_{t\\to1}\\frac yx=\\lim_{t\\to1}\\frac{1}{t(t+1)}=\\frac12'),['k=\\lim_{t\\to1}\\frac yx','=\\lim_{t\\to1}\\frac{1}{t(t+1)}','=\\frac12']);
  assert.deepEqual(mathChatGroups('z=\\text{x=y \\qquad a=b}'),['z=\\text{x=y \\qquad a=b}']);
});
test('QQ layout keeps source order, maps row fragments, uses fixed larger font, and does not alter full PDF HTML',async()=>{
  const withRows={...doc,blocks:[doc.blocks[0],{type:'math',content:'\\begin{aligned}x&=1\\\\y&=2\\end{aligned}'}]};
  const html=await mathChatHtml(withRows);
  assert.ok(html.includes('width:448px'));assert.ok(html.includes('font-size:28px'));assert.ok(html.includes('font-size:32px'));
  assert.ok(html.indexOf('data-index="0"')<html.indexOf('data-index="1"'));
  assert.ok(html.includes('data-index="1" data-fragment="0"'));assert.ok(html.includes('data-index="1" data-fragment="1"'));
  assert.ok(!html.includes('transform:scale'));assert.ok((await mathHtml(withRows)).includes('width:720px'));
});
test('QQ preview retains hostile-text escaping and refuses unsupported math commands',async()=>{
  const html=await mathChatHtml({...doc,title:'<img src=x>',blocks:[{type:'text',content:'<script>evil()</script>'},doc.blocks[1]]});
  assert.ok(html.includes('&lt;img src=x&gt;'));assert.ok(!html.includes('<script>'));
  await assert.rejects(()=>mathChatHtml({...doc,blocks:[{type:'math',content:'\\Huge x'}]}),/math_command_not_allowed/);
  await assert.rejects(()=>renderMathChatPreview({root:'relative/math',document:doc}),/math_root_must_be_D/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>renderMathChatPreview({root:process.cwd(),document:doc,signal:controller.signal}),{name:'AbortError'});
});
