import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseBodyForReplay, keyInfoForChar, sanitizeInitiator } from '../src/hybrid/client.mjs';
import { parseCompletionBodies } from '../src/browser/stream-capture.mjs';

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const buildSse = (answer) =>
  frame({ v: { response: { message_id: 'm-1', fragments: [] } } }) +
  frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: answer }] }) +
  frame({ p: 'response/status', o: 'SET', v: 'FINISHED' });

/* ------------------------------------------------------------------ *
 * keyInfoForChar：ASCII 走真实键盘事件，中文/换行交给 insertText / Shift+Enter
 * ------------------------------------------------------------------ */

test('keyInfoForChar：字母、数字、Shift 符号、中文', () => {
  assert.deepEqual(keyInfoForChar('a'), { key: 'a', code: 'KeyA', vk: 65, modifiers: 0 });
  assert.deepEqual(keyInfoForChar('A'), { key: 'A', code: 'KeyA', vk: 65, modifiers: 8 });
  assert.deepEqual(keyInfoForChar('1'), { key: '1', code: 'Digit1', vk: 49, modifiers: 0 });
  assert.deepEqual(keyInfoForChar('!'), { key: '!', code: 'Digit1', vk: 49, modifiers: 8 });
  assert.deepEqual(keyInfoForChar('?'), { key: '?', code: 'Slash', vk: 191, modifiers: 8 });
  assert.equal(keyInfoForChar('你'), null);
  assert.equal(keyInfoForChar('\n'), null);
  assert.equal(keyInfoForChar('🙂'), null);
});

/* ------------------------------------------------------------------ *
 * sanitizeInitiator：只保留类型与脚本位置，去掉查询串
 * ------------------------------------------------------------------ */

test('sanitizeInitiator：页面静态域算页面脚本，且不保留查询串', () => {
  const initiator = {
    type: 'script',
    stack: {
      callFrames: [
        { functionName: 'r', url: 'https://fe-static.deepseek.com/chat/static/default.js?v=1&token=x', lineNumber: 1, columnNumber: 2 },
        { functionName: 't', url: 'https://chat.deepseek.com/web.js?x=1', lineNumber: 9, columnNumber: 3 },
      ],
    },
  };
  const out = sanitizeInitiator(initiator);
  assert.equal(out.type, 'script');
  assert.equal(out.pageScript, true);
  assert.equal(out.topUrl, 'https://fe-static.deepseek.com/chat/static/default.js');
  assert.equal(out.frames.length, 2);
  for (const f of out.frames) assert.ok(!f.url.includes('?'));
});

test('sanitizeInitiator：第三方脚本不算页面脚本；空值返回 null', () => {
  const out = sanitizeInitiator({
    type: 'script',
    stack: { callFrames: [{ functionName: 'x', url: 'https://evil.example.com/a.js?k=1', lineNumber: 0, columnNumber: 0 }] },
  });
  assert.equal(out.pageScript, false);
  assert.equal(out.topUrl, 'https://evil.example.com/a.js');
  assert.equal(sanitizeInitiator(null), null);
  assert.equal(sanitizeInitiator(undefined), null);
});

/* ------------------------------------------------------------------ *
 * chooseBodyForReplay：回放的那段必须与权威文本一致
 * ------------------------------------------------------------------ */

test('chooseBodyForReplay：选与权威文本一致的那段 body', () => {
  const short = buildSse('短');
  const long = buildSse('这是更长的回答');
  const analysis = parseCompletionBodies([short, long]);
  assert.equal(analysis.text, '这是更长的回答');
  assert.equal(chooseBodyForReplay([short, long], analysis), long);
  // 其他顺序也一样，不依赖位置
  assert.equal(chooseBodyForReplay([long, short], analysis), long);
});

test('chooseBodyForReplay：单段/空列表不抛错', () => {
  const only = buildSse('唯一');
  const analysis = parseCompletionBodies([only]);
  assert.equal(chooseBodyForReplay([only], analysis), only);
  assert.equal(chooseBodyForReplay([], analysis), '');
});
