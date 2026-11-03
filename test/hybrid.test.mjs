import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bezierPath,
  charDelayMs,
  chooseBodyForReplay,
  hybridLaunchArgs,
  keyInfoForChar,
  planTyping,
  sanitizeInitiator,
} from '../src/hybrid/client.mjs';
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

/* ------------------------------------------------------------------ *
 * 行为层纯函数：IME 规划、非线性节奏、贝塞尔轨迹、启动参数
 * ------------------------------------------------------------------ */

test('planTyping：中文走 IME 组合，ASCII 走键盘，换行走 Enter', () => {
  const ime = planTyping('你好', { rand: () => 0.5 });
  const imeActions = ime.filter((a) => a.kind === 'ime');
  assert.equal(imeActions.length, 1);
  assert.equal(imeActions[0].word, '你好');
  assert.equal(ime.filter((a) => a.kind === 'key').length, 0);

  const ascii = planTyping('ab\n', { ime: true, rhythm: false, typoRate: 0, baseMs: 45, rand: () => 0.5 });
  assert.deepEqual(
    ascii.filter((a) => a.kind !== 'sleep').map((a) => a.kind),
    ['key', 'key', 'enter'],
  );
});

test('planTyping：偶发输入错误会回退重打（错字 → Backspace → 正确字）', () => {
  const actions = planTyping('ab', { typoRate: 1, rand: () => 0.01, baseMs: 45 });
  const kinds = actions.filter((a) => a.kind !== 'sleep').map((a) => a.kind);
  assert.deepEqual(kinds.slice(0, 3), ['key', 'backspace', 'key']);
  assert.equal(actions[0].typo, true);
});

test('charDelayMs：句末停顿显著大于普通字，rhythm 关闭时恒定', () => {
  const plain = charDelayMs({ baseMs: 45, ch: 'a', rand: () => 0.5 });
  const period = charDelayMs({ baseMs: 45, ch: '。', rand: () => 0.5 });
  assert.ok(period > plain + 200, `period=${period} plain=${plain}`);
  const fixed = charDelayMs({ baseMs: 45, rhythm: false, ch: '。', rand: () => 0.5 });
  assert.ok(fixed <= 45 + 23);
});

test('bezierPath：多步曲线、末点精确、延时有加减速变化', () => {
  const pts = bezierPath({ x: 10, y: 10 }, { x: 400, y: 300 }, { rand: () => 0.3 });
  assert.ok(pts.length >= 8, `points=${pts.length}`);
  assert.deepEqual({ x: pts.at(-1).x, y: pts.at(-1).y }, { x: 400, y: 300 });
  const delays = new Set(pts.map((p) => p.delay));
  assert.ok(delays.size > 3, `distinct delays=${delays.size}`);
  // 曲线不是两点直线：中间点不在起终点连线上
  const mid = pts[Math.floor(pts.length / 2)];
  const onLine = ((mid.x - 10) * (300 - 10)) / (400 - 10);
  assert.ok(Math.abs(mid.y - (10 + onLine)) > 1, 'middle point should bow off the straight line');
});

test('hybridLaunchArgs：Windows 不带 no-sandbox，且不设置 UA', () => {
  const args = hybridLaunchArgs('win32');
  assert.ok(args.includes('--disable-gpu'));
  assert.ok(!args.includes('--no-sandbox'));
  assert.ok(!args.includes('--disable-dev-shm-usage'));
  assert.ok(!args.some((a) => a.includes('user-agent')));
  assert.ok(hybridLaunchArgs('linux').includes('--no-sandbox'));
});
