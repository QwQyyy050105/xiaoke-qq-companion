import test from 'node:test';
import assert from 'node:assert/strict';
import { plainMessage, normalizeMessages, requestedWebSearch } from '../src/message_format.mjs';

test('QQ prose removes markdown while preserving math, emoji and usable source links', () => {
  assert.equal(plainMessage('**小柯**：2 * 3 * 4 = 24。\n[出处](https://example.org/a) 🐉'), '小柯：2 * 3 * 4 = 24。\n出处（https://example.org/a） 🐉');
  assert.equal(plainMessage('```js\nx = 2 * 3;\n```'), 'x = 2 * 3;');
});
test('explicit bubbles become one canonical saved reply without duplicate delivery', () => {
  assert.deepEqual(normalizeMessages('ignored parallel draft', ['第一位的答案', '第二位的答案']), { reply:'第一位的答案\n\n第二位的答案',messages:['第一位的答案','第二位的答案'] });
  assert.deepEqual(normalizeMessages('完整答复', ['x'.repeat(1801)]), {reply:'完整答复',messages:[]});
});
test('read-only search is available when needed during replies or proactive facts, respecting current opt-out', () => {
  assert.equal(requestedWebSearch({text:'小柯，帮我查一下这个词是什么意思'}),true);
  assert.equal(requestedWebSearch({text:'不用联网查，陪我聊聊'}),false);
  assert.equal(requestedWebSearch({text:'你可以联网吗',roomHistory:[{content:'帮我查一下新闻'}]}),true);
  assert.equal(requestedWebSearch({text:'今天这个政策有什么变化'}),true);
  assert.equal(requestedWebSearch({text:'好耶'}),true); // Available does not mean the model should invoke it.
  assert.equal(requestedWebSearch({mode:'proactive',text:'帮我搜一下新闻'}),true);
  assert.equal(requestedWebSearch({mode:'proactive',text:'不用联网',chatSettings:{allowWebSearch:false}}),false);
  assert.equal(requestedWebSearch({turnMessages:[{content:'帮我搜索公开资料'},{content:'我在听'}]}),true);
  assert.equal(requestedWebSearch({turnMessages:[{content:'查一下资料'},{content:'不要搜索'}]}),false);
  assert.equal(requestedWebSearch({mode:'visual_review',text:'比较两张图'}),false);
  assert.equal(requestedWebSearch({mode:'routing',text:'最新新闻'}),false);
});
