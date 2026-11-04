/**
 * 工具声明 / 调用解析。
 *
 * 对外协议只有一种：**纯文本哨兵 + JSON**（见 text-protocol.mjs）：
 *   [[TOOL_CALL]]{"name":"bash","arguments":{"command":"dir"}}[[/TOOL_CALL]]
 *
 * 声明用 ## Tool_functions 段里每行一个 JSON；历史里的调用 / 结果用同一套哨兵回写。
 * 全程不含 XML 标签 —— 网页端会把 XML 协议标签当成风控信号。
 *
 * 为了不丢调用，DSML / <tool_call> / 原生工具 token / 旧版 DO 仍然静默兜底解析，
 * 但它们不是对外协议，也不回写历史：模型没有可模仿的 XML 样板。
 */

import { parseDsmlCalls } from './dsml.mjs';
import { parseJsonLoose, readJsonContainer, readJsonObject } from './json-loose.mjs';
import { parseTextToolCalls, TOOL_RESULT_CLOSE, TOOL_RESULT_OPEN } from './text-protocol.mjs';

export { readJsonObject };

/** 把 OpenAI tools 定义渲染成「每行一个 JSON」的工具列表 */
export function renderToolDeclarations(tools = []) {
  const lines = [];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) continue;
    const decl = { name: fn.name.trim() };
    if (fn.description) decl.description = String(fn.description);
    if (fn.parameters && typeof fn.parameters === 'object') decl.parameters = fn.parameters;
    lines.push(JSON.stringify(decl));
  }
  return lines;
}

/**
 * 旧版 DO 行（`DO:{"name":...}`）的容错解析。
 *
 * 新协议里 prompt / 历史都不再出现 DO（历史调用走 ## Tool_calls 的哨兵行），
 * 这里保留只是兜底：万一模型/旧客户端还吐 DO，不丢调用、也不报错、不记日志。
 */
const DO_PATTERN = /\bDO\b[ \t*_`~]{0,6}[:：=][ \t*_`~]{0,6}\s*/g;

/** <tool_call>{...}</tool_call>（也认 <tool_calls>；流式截断时缺闭合标签就把后面整段当 body） */
const XML_TOOL_PATTERN = /<tool_calls?\b[^>]*>([\s\S]*?)(?:<\/tool_calls?>|$)/gi;

/** 原生工具 token：`<|tool▁calls▁begin|>`、`<|tool_calls|>`、`<|tool▁sep|>` 之类 */
const NATIVE_TOKEN_SOURCE = '<\\|[^|<>\\r\\n]{0,64}tool[^|<>\\r\\n]{0,64}\\|>';
const NATIVE_TOKEN_PATTERN = new RegExp(NATIVE_TOKEN_SOURCE, 'gi');
const NATIVE_TOKEN_AT = new RegExp(`^(?:${NATIVE_TOKEN_SOURCE})`, 'i');

/** 参数对象键排序后再序列化，方便不同格式的等价调用去重 / 比较 */
export function canonicalArguments(args) {
  try {
    return stableStringify(JSON.parse(args));
  } catch {
    return typeof args === 'string' ? args : JSON.stringify(args ?? {});
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 读出以 `{` / `[` 开头的 JSON 并宽松解析；不是 / 还没闭合就返回 null */
function readJsonValue(text, start) {
  const raw = readJsonContainer(text, start);
  return raw ? parseJsonLoose(raw) : null;
}

/**
 * 把解析出来的 JSON 归一成 { name, args }。
 * 兼容 OpenAI 风格 `{"function":{"name":...,"arguments":...}}` 包一层的情况。
 */
function normalizeCallObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fn =
    value.function && typeof value.function === 'object' && !Array.isArray(value.function)
      ? value.function
      : value;
  const name = typeof fn.name === 'string' ? fn.name.trim() : '';
  if (!name) return null;
  return { name, args: fn.args ?? fn.arguments ?? value.args ?? value.arguments ?? {} };
}

/** <tool_call> 里的 body：整个 JSON、截断的 JSON、后面跟着解释文字都尽量读出来 */
function parseToolCallBody(body) {
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) return null;
  const braceAt = trimmed[0] === '{' ? 0 : trimmed.indexOf('{');
  if (braceAt < 0) return null;
  return normalizeCallObject(readJsonValue(trimmed, braceAt));
}

/** 跳过原生 token / `function` 关键字 / ```json 围栏，落到真正的 JSON 上 */
function skipNativeLead(text, from) {
  let i = from;
  for (let step = 0; step < 16; step += 1) {
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const token = NATIVE_TOKEN_AT.exec(text.slice(i, i + 96));
    if (token) {
      i += token[0].length;
      continue;
    }

    const fence = /^```[a-zA-Z0-9_+-]{0,10}[ \t]*\r?\n?/.exec(text.slice(i, i + 24));
    if (fence) {
      i += fence[0].length;
      continue;
    }

    const keyword = /^(?:function|name)[ \t]*[:：=]?[ \t]*["']?/i.exec(text.slice(i, i + 24));
    if (keyword) {
      i += keyword[0].length;
      continue;
    }
    break;
  }
  return i;
}

/** 原生格式里工具名写在 JSON 前面：`function<|tool▁sep|>get_weather` */
function nativeNameBefore(text, from, to) {
  let window = text.slice(from, to);
  if (!window.trim()) return '';
  // 去掉 JSON 前面的代码围栏（```json\n），否则会把 "json" 当成函数名
  window = window.replace(/```[a-zA-Z0-9_+-]*[ \t]*\r?\n?[ \t]*$/, '');
  const match = /([A-Za-z_$][\w$.-]{0,63})[ \t\r\n]*$/.exec(window);
  if (!match) return '';
  const name = match[1];
  if (/^(?:function|name|tool|tools|json|arguments|args)$/i.test(name)) return '';
  return name;
}

/**
 * 原生工具 token 的兜底解析。两种形态都认：
 * 1. token 后面直接跟带 name / arguments 的 JSON；
 * 2. 真·原生格式：`function<|tool▁sep|>工具名` 在前，JSON 只是 arguments。
 */
function parseNativeToolCalls(text, add) {
  NATIVE_TOKEN_PATTERN.lastIndex = 0;
  let token;
  while ((token = NATIVE_TOKEN_PATTERN.exec(text)) !== null) {
    const tokenEnd = token.index + token[0].length;

    // 形态 1：token 后面就是完整 JSON（名字在 JSON 里）
    const jsonAt = skipNativeLead(text, tokenEnd);
    const directRaw = readJsonObject(text, jsonAt);
    const direct = directRaw ? normalizeCallObject(parseJsonLoose(directRaw)) : null;
    if (direct) {
      add(direct.name, normalizeArguments(direct.args), text.slice(token.index, jsonAt + directRaw.length), token.index);
      continue;
    }

    // 形态 2：JSON 只是参数，工具名在 JSON 前面
    const braceAt = text.indexOf('{', tokenEnd);
    if (braceAt < 0 || braceAt - tokenEnd > 600) continue;
    const argsRaw = readJsonObject(text, braceAt);
    if (!argsRaw) continue;
    const argsValue = parseJsonLoose(argsRaw);
    if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue)) continue;
    const name = nativeNameBefore(text, tokenEnd, braceAt);
    if (!name) continue;
    add(name, normalizeArguments(argsValue), text.slice(token.index, braceAt + argsRaw.length), token.index);
  }
}

/**
 * 解析模型回复中的工具调用。
 *
 * 顺序：纯文本哨兵（唯一对外协议）→ DSML → <tool_call> → 原生 token → 旧版 DO 兜底；
 * 最终按出现位置排序，用 canonicalArguments 去重
 * （同一次调用被模型用两种格式重复写出来时只保留一次）。
 *
 * 工具名不再按声明列表过滤：模型偶尔会调一个没声明过的名字（客户端 system / 历史里出现过），
 * 按名字丢弃等于把整轮输出一起吞掉 —— 客户端只会收到一条空的 assistant 消息并判定
 * 「模型未返回正文或工具调用」。未知名字照实返回，由客户端自己回一条 unknown tool，
 * agent 才能自我纠正、loop 才能继续（这也和 OpenAI 兼容接口的既有行为一致）。
 *
 * @param {string} text
 * @param {string[]} [knownTools] 保留参数：仅用于调用方日志（哪些名字是没声明的），不再参与过滤
 * @returns {{ name: string, arguments: string, raw: string, index: number }[]}
 */
export function parseToolCalls(text, knownTools = null) {
  if (!text || typeof text !== 'string') return [];
  const calls = [];
  const seen = new Set();

  const add = (name, args, raw, index) => {
    if (!name) return;
    const argsJson = normalizeArguments(args);
    const signature = `${name}\u0000${canonicalArguments(argsJson)}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    calls.push({ name, arguments: argsJson, raw, index });
  };

  // 1) 纯文本哨兵：对外协议，最高优先级
  for (const call of parseTextToolCalls(text)) {
    add(call.name, call.args, call.raw, call.index);
  }

  // 2) DSML 兜底（模型可能仍按旧样板书输出 XML 风格调用）
  for (const call of parseDsmlCalls(text)) {
    add(call.name, call.arguments, call.raw, call.index);
  }

  // 3) <tool_call>{...}</tool_call>：缺闭合标签时按截断处理
  XML_TOOL_PATTERN.lastIndex = 0;
  let xml;
  while ((xml = XML_TOOL_PATTERN.exec(text)) !== null) {
    const call = parseToolCallBody(xml[1]);
    if (!call) continue;
    add(call.name, call.args, xml[0], xml.index);
  }

  // 3) 原生工具 token（<|tool▁calls▁begin|> 之类）兜底
  parseNativeToolCalls(text, add);

  // 4) 旧版 DO 行：只做静默兜底，不记日志、不回写历史
  DO_PATTERN.lastIndex = 0;
  let match;
  while ((match = DO_PATTERN.exec(text)) !== null) {
    const raw = readJsonObject(text, match.index + match[0].length);
    const call = raw ? normalizeCallObject(parseJsonLoose(raw)) : null;
    if (!call) continue;
    add(call.name, call.args, `DO:${raw}`, match.index);
  }

  return calls.sort((a, b) => a.index - b.index);
}

/**
 * 有些模型在原生格式（DSML / <tool_call> / 原生 token / 旧版 DO）里会把包装对象原样塞进参数：
 *
 *   {"name":"bash","args":{"description":"...","command":"..."}}
 *   {"name":"bash","args":"{\"description\":...,\"command\":...}"}
 *
 * 上层拿到的应该是真正的参数对象，而不是这层包装。这里只在「键正好是 name + args/arguments」
 * 时才拆，避免误伤本来就有 name / args 字段的工具。
 */
export function unwrapCallArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'name' || key === 'args' || key === 'arguments')) return value;
  if (typeof value.name !== 'string' || !value.name.trim()) return value;
  if (!('args' in value) && !('arguments' in value)) return value;

  let inner = 'args' in value ? value.args : value.arguments;
  if (typeof inner === 'string') {
    const trimmed = inner.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    try {
      inner = JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return value;
  return inner;
}

/**
 * 工具调用的参数统一成 JSON 字符串（给 OpenAI tool_calls.arguments 用）。
 * 兼容字符串 / 对象；被包装成 {name,args} 的会先拆掉（见 unwrapCallArguments）。
 */
export function normalizeArguments(args) {
  if (args === undefined || args === null) return '{}';
  let value = args;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      value = JSON.parse(trimmed);
    } catch {
      // 不是合法 JSON 就包一层，避免下游解析炸掉
      return JSON.stringify({ input: args });
    }
  }
  return JSON.stringify(unwrapCallArguments(value));
}

/**
 * 工具执行结果 -> ## Tool_call_result 段里的一行哨兵块。
 * 形如：[[TOOL_RESULT]]{"name":"exec_shell","result":"Linux"}[[/TOOL_RESULT]]
 */
export function renderToolResult(name, content) {
  const result = typeof content === 'string' ? content : JSON.stringify(content);
  return `${TOOL_RESULT_OPEN}${JSON.stringify({ name: name || 'unknown', result })}${TOOL_RESULT_CLOSE}`;
}

/** 统计工具名（给调用方做「模型调了没声明的工具」这类日志/诊断用） */
export function collectToolNames(tools = []) {
  return tools
    .map((t) => (t?.function ?? t)?.name)
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => n.trim());
}
