import test from 'node:test';
import assert from 'node:assert/strict';
import {mathHtml,validateMathDocument,renderMathReply} from '../src/math_render.mjs';

const doc={title:'参数曲线',summary:'斜渐近线',blocks:[{type:'text',content:'先求斜率，再求截距。'},{type:'math',content:'y=\\frac12x-\\frac34'}]};
test('math renderer keeps exact formula structure and escapes prose instead of executing HTML',async()=>{
 const html=await mathHtml({...doc,title:'<script>evil()</script>',blocks:[{type:'text',content:'<img src="https://invalid.example/">' },doc.blocks[1]]});
 assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
 assert.ok(html.includes('&lt;img src=&quot;https://invalid.example/'));
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('katex-mathml'));assert.ok(html.includes('data:font/woff2;base64,'));
 assert.ok(!/url\((?:https?:|fonts\/)/.test(html));
});
test('math renderer refuses external resources, macro execution and arbitrary font resizing',()=>{
 for(const command of ['\\href{https://example.com}{x}','\\includegraphics{x}','\\htmlClass{x}{y}','\\def\\x{x}','\\Huge x']){
  assert.throws(()=>validateMathDocument({...doc,blocks:[{type:'math',content:command}]}),/math_command_not_allowed/);
 }
});
test('invalid formulas fail explicitly instead of becoming red raw TeX',async()=>{
 await assert.rejects(()=>mathHtml({...doc,blocks:[{type:'math',content:'\\frac{1'}]}),/math_formula_invalid/);
});
test('resource bounds reject huge documents and non-project output paths',async()=>{
 assert.throws(()=>validateMathDocument({...doc,blocks:Array(33).fill(doc.blocks[1])}),/math_document_invalid/);
 assert.throws(()=>validateMathDocument({...doc,blocks:[{type:'math',content:'x'.repeat(4001)}]}),/math_document_invalid/);
 await assert.rejects(()=>renderMathReply({root:'relative/math',document:doc}),/math_root_must_be_D/);
});
test('cancellation before render creates no browser job',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>renderMathReply({root:process.cwd(),document:doc,signal:controller.signal}),{name:'AbortError'});
});
