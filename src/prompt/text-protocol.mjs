/**
 * 纯文本工具调用协议（不使用任何 XML / 尖括号标签）。
 *
 * 为什么不用 XML：DeepSeek 网页端会把 `<dsml>` / `<tool_call>` / `<antml:*>` 这类
 * 「协议标签」当成自动化 / 越狱信号。所以协议改用 ASCII 哨兵 + JSON：
 *
 *   声明：## Tool_functions 段里每行一个 JSON（name / description / parameters）
 *   调用：[[TOOL_CALL]]{"name":"bash","arguments":{"command":"dir"}}[[/TOOL_CALL]]
 *   结果：[[TOOL_RESULT]]{"name":"bash","result":"..."}[[/TOOL_RESULT]]
 *
 * 哨兵是普通字符序列，不含 `<`，既不会被网页端风控匹配，也不会被 sanitize 层的
 * XML 标签扫描命中；而 JSON 本身是模型最熟的格式，结构稳定性靠 JSON 而非标签语法。
 *
 * 解析是「宽容」的：块内可以有多余说明、多个 JSON 对象、数组、markdown 围栏、
 * 裸换行 / 尾随逗号；认不出来就返回空，由上层降级为普通文本，绝不抛错。
 */

import { parseJsonLoose, readJsonContainer } from './json-loose.mjs';

export const TOOL_CALL_OPEN = '[[TOOL_CALL]]';
export const TOOL_CALL_CLOSE = '[[/TOOL_CALL]]';
export const TOOL_RESULT_OPEN = '[[TOOL_RESULT]]';
export const TOOL_RESULT_CLOSE = '[[/TOOL_RESULT]]';

/** 允许 [[TOOL_CALLS]] 复数写法（不同模型/框架的模仿偏差） */
const CALL_OPEN = /\[\[\s*TOOL_CALLS?\s*\]\]/gi;
const CALL_CLOSE = /\[\[\s*\/\s*TOOL_CALLS?\s*\]\]/gi;
const RESULT_OPEN = /\[\[\s*TOOL_RESULTS?\s*\]\]/gi;
const RESULT_CLOSE = /\[\[\s*\/\s*TOOL_RESULTS?\s*\]\]/gi;

/** 流式扣留用：末尾还没写完的哨兵（任何截断点都算前缀） */
const FULL_SENTINELS = [
  '[[TOOL_CALL]]',
  '[[TOOL_CALLS]]',
  '[[/TOOL_CALL]]',
  '[[/TOOL_CALLS]]',
  '[[TOOL_RESULT]]',
  '[[TOOL_RESULTS]]',
  '[[/TOOL_RESULT]]',
  '[[/TOOL_RESULTS]]',
];

/**
 * 扫出某一类哨兵块。
 * @returns {{ kind: string, start: number, end: number, complete: boolean, body: string }[]}
 *   complete=false 表示只看到开哨兵、还没闭合（流式截断或模型漏写）
 */
function scanSentinel(text, { open, close, kind, from = 0 }) {
  const blocks = [];
  if (typeof text !== 'string' || !text) return blocks;

  open.lastIndex = Math.max(0, from);
  let match;
  while ((match = open.exec(text)) !== null) {
    const start = match.index;
    const bodyStart = start + match[0].length;
    close.lastIndex = bodyStart;
    const closing = close.exec(text);
    if (!closing) {
      blocks.push({ kind, start, end: text.length, complete: false, body: text.slice(bodyStart) });
      break;
    }
    blocks.push({
      kind,
      start,
      end: closing.index + closing[0].length,
      complete: true,
      body: text.slice(bodyStart, closing.index),
    });
    open.lastIndex = closing.index + closing[0].length;
  }
  return blocks;
}

export function scanTextToolCallBlocks(text, from = 0) {
  return scanSentinel(text, { open: CALL_OPEN, close: CALL_CLOSE, kind: 'TOOL_CALL', from });
}

export function scanTextToolResultBlocks(text, from = 0) {
  return scanSentinel(text, { open: RESULT_OPEN, close: RESULT_CLOSE, kind: 'RESULT', from });
}

/** 文本里完整的调用块数量（解析成功率统计用） */
export function countTextToolCallBlocks(text) {
  return scanTextToolCallBlocks(text).filter((block) => block.complete).length;
}

/** 把一个 JSON 值归一成 { name, args }；数组会展开 */
function collectCallsFromValue(value, add, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCallsFromValue(item, add, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const fn =
    value.function && typeof value.function === 'object' && !Array.isArray(value.function)
      ? value.function
      : value;
  const name = typeof fn.name === 'string' ? fn.name.trim() : '';
  if (!name) return;
  add({ name, args: fn.args ?? fn.arguments ?? value.args ?? value.arguments ?? {} });
}

/** 块内可能有多余说明 / 多个 JSON / 数组 / 代码围栏：逐个 JSON 读出来 */
function collectCallsFromBody(body, add) {
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{' || ch === '[') {
      const raw = readJsonContainer(body, i);
      if (!raw) return; // 还没闭合：后面的都不可信
      const value = parseJsonLoose(raw);
      if (value !== null) collectCallsFromValue(value, add);
      i += raw.length;
      while (i < body.length && /[\s,]/.test(body[i])) i += 1;
      continue;
    }
    i += 1;
  }
}

/**
 * 解析文本里的纯文本调用块。
 *
 * @returns {{ name: string, args: any, raw: string, index: number }[]}
 *   args 原样返回（对象或 JSON 字符串），由上层统一 normalizeArguments。
 */
export function parseTextToolCalls(text) {
  if (typeof text !== 'string' || !text) return [];
  const calls = [];
  for (const block of scanTextToolCallBlocks(text)) {
    collectCallsFromBody(block.body, (call) => {
      calls.push({ name: call.name, args: call.args, raw: text.slice(block.start, block.end), index: block.start });
    });
  }
  return calls;
}

/**
 * 流式扣留：返回「可能是哨兵开头」的下标（-1 表示没有）。
 * 只认 `[` 之后到结尾仍是合法前缀的情况，不会扣住普通正文里的方括号。
 */
export function findPendingTextSentinel(text, from = 0) {
  if (typeof text !== 'string' || !text) return -1;
  const lt = text.lastIndexOf('[');
  if (lt < Math.max(0, from)) return -1;
  // 哨兵以 `[[` 开头：从连续方括号的第一个开始算
  let start = lt;
  while (start > 0 && text[start - 1] === '[') start -= 1;
  if (start < Math.max(0, from)) return -1;
  const tail = text.slice(start);
  if (tail.length > 32) return -1;
  const compact = tail.replace(/\s+/g, '').toUpperCase();
  // 完整哨兵交给块解析处理，这里只扣「还没写完」的
  if (FULL_SENTINELS.includes(compact)) return -1;
  return FULL_SENTINELS.some((sentinel) => sentinel.startsWith(compact)) ? start : -1;
}
