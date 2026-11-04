import { ApiError } from '../errors.mjs';
import { contentToText } from '../util.mjs';
import {
  BASE_SYSTEM_RULES,
  FINAL_ANSWER_HINT,
  PROMPT_HEADER,
  REPLY_END_TOKEN,
  SECTION,
  SPECIAL_TOKENS_HEADER,
} from './special.mjs';
import { collectToolNames, renderToolDeclarations, renderToolResult } from './tools.mjs';
import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from './text-protocol.mjs';

const VALID_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);

/**
 * 把 OpenAI messages 拼成网页输入框里的一条 prompt。
 *
 * 输出形状（一次请求 = 一次全新对话，模型只能靠这些段落判断上下文）：
 *
 *   # Messages:
 *   ## System:
 *   <调用方传入的 system（客户端 prompt 最上面）>
 *
 *   ## Tool_functions:
 *   {"name":"exec_shell","description":"..."}
 *
 *   ## System:
 *   <自带的特殊 token 声明 / DSML 工具调用规范（放中间）>
 *
 *   ## User:
 *   你好
 *
 *   ## Assistant:
 *   你好！有什么可以帮你？
 *
 *   ## Tool_calls:
 *   [[TOOL_CALL]]{"name":"exec_shell","arguments":{"command":"uname -a"}}[[/TOOL_CALL]]
 *
 *   ## Tool_call_result:
 *   [[TOOL_RESULT]]{"name":"exec_shell","result":"Linux"}[[/TOOL_RESULT]]
 *
 *   ## User:
 *   解释一下
 *
 * 顺序：客户端 system 在最上面，自带协议提示词夹在中间，工具声明和对话历史（user）在后面。
 *
 * 注意两件事：
 * - 模型输出工具调用走纯文本哨兵协议（见 special.mjs），**历史里回写同一套哨兵**，
 *   模型看到的是「自己以前也这么写」，格式更稳；全程不出现任何 XML 标签。
 * - 工具结果**单独成段**（## Tool_call_result），不塞进 ## Assistant，
 *   模型就不会把「assistant 说调用、然后自己写结果」当成正确的模仿对象。
 */
export function buildPrompt({ messages, tools = [], systemExtra = '' }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'messages 不能为空', { code: 'invalid_messages' });
  }

  const systemTexts = [];
  /** @type {{role: 'user'|'assistant'|'toolCalls'|'toolResult', lines: string[]}[]} */
  const sections = [];

  for (const [index, message] of messages.entries()) {
    const role = message?.role;
    if (!VALID_ROLES.has(role)) {
      throw new ApiError(400, `messages[${index}].role 不合法: ${JSON.stringify(role)}`, {
        code: 'invalid_role',
        param: `messages[${index}].role`,
      });
    }

    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content, role).trim();
      if (text) systemTexts.push(text);
      continue;
    }

    if (role === 'user') {
      sections.push({ role: 'user', lines: [contentToText(message.content, 'user')] });
      continue;
    }

    if (role === 'assistant') {
      const text = contentToText(message.content, 'assistant');
      if (text.trim()) sections.push({ role: 'assistant', lines: [text] });

      const callLines = [];
      for (const call of message.tool_calls ?? []) {
        const fn = call?.function ?? {};
        if (!fn.name) continue;
        callLines.push(renderToolCall(fn.name, fn.arguments));
      }
      // 历史调用单独成段：回写与模型输出完全一致的哨兵块，模型没有第二种语法可学
      if (callLines.length) sections.push({ role: 'toolCalls', lines: callLines });

      if (!text.trim() && !callLines.length) sections.push({ role: 'assistant', lines: [''] });
      continue;
    }

    // tool / function 结果：单独成段，绝不并进 assistant 段落
    const name = message.name || findLastToolName(sections) || 'unknown';
    const resultLine = renderToolResult(name, contentToText(message.content, role));
    const last = sections.at(-1);
    if (last?.role === 'toolResult') last.lines.push(resultLine);
    else sections.push({ role: 'toolResult', lines: [resultLine] });
  }

  const lastSection = sections.at(-1);
  if (lastSection?.role === 'toolResult') {
    // 最后一段是工具结果时，段尾补一句「直接回答」，把话头收回来
    lastSection.lines.push('', FINAL_ANSWER_HINT);
  }

  // 顺序：客户端 system → 工具声明 → 自带提示词（单独 system 块）→ 对话历史（user 在最后）
  const extra = typeof systemExtra === 'string' ? systemExtra.trim() : '';
  const parts = [PROMPT_HEADER, SECTION.system];
  const systemBody = [...systemTexts, extra].filter(Boolean).join('\n\n');
  if (systemBody) parts.push(systemBody);

  const toolLines = renderToolDeclarations(tools);
  if (toolLines.length) {
    parts.push('', SECTION.tools, ...toolLines);
  }

  // 自带的协议提示词：单独一个 system 块，放在 TOOL_FUNCTIONS 之后、USER 之前。
  // 有工具声明时教纯文本哨兵协议（可解析成 tool_calls）；没有工具时只放基础规则。
  const protocolText = (toolLines.length ? SPECIAL_TOKENS_HEADER : BASE_SYSTEM_RULES).trim();
  parts.push('', SECTION.system, protocolText);

  for (const section of sections) {
    let body = section.lines.join('\n').trim();
    // END 结束标记只给模型看：输出给客户端时被过滤掉了，重建上下文时补回 assistant 段末尾
    if (section.role === 'assistant' && !body.includes(REPLY_END_TOKEN)) {
      body = body ? `${body}\n${REPLY_END_TOKEN}` : REPLY_END_TOKEN;
    }
    parts.push('', SECTION[section.role], body);
  }

  const prompt = parts.join('\n').trimEnd();

  return {
    prompt,
    systemTexts,
    // 服务端自带的协议说明原文：上送前自检时这段是有意保留的（不算客户端污染）
    protocolText,
    toolNames: collectToolNames(tools),
    stats: {
      chars: prompt.length,
      sections: sections.length,
      systemMessages: systemTexts.length,
      tools: toolLines.length,
    },
  };
}

/**
 * 复用网页会话时的「增量 prompt」：只渲染本轮新增的消息，不重放整段历史。
 *
 * 首轮的 system / 工具声明 / 协议说明已经在网页会话里，这里不再重复；
 * 增量里如果又出现 system（少见），仍按 ## System 段渲染。
 *
 * 跳过的那条 assistant 回复（上一轮模型自己的输出）由调用方负责排除；
 * tool 结果没带 name 时，用 tool_call_id → 工具名映射兜底（映射来自完整历史）。
 */
export function buildDeltaPrompt({ messages, from = 0, toolNameById = {} }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'messages 不能为空', { code: 'invalid_messages' });
  }

  const systemTexts = [];
  /** @type {{role: 'user'|'assistant'|'toolCalls'|'toolResult'|'system', lines: string[]}[]} */
  const sections = [];

  for (let index = Math.max(0, from); index < messages.length; index += 1) {
    const message = messages[index];
    const role = message?.role;
    if (!VALID_ROLES.has(role)) {
      throw new ApiError(400, `messages[${index}].role 不合法: ${JSON.stringify(role)}`, {
        code: 'invalid_role',
        param: `messages[${index}].role`,
      });
    }

    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content, role).trim();
      if (text) systemTexts.push(text);
      continue;
    }

    if (role === 'user') {
      sections.push({ role: 'user', lines: [contentToText(message.content, 'user')] });
      continue;
    }

    if (role === 'assistant') {
      const text = contentToText(message.content, 'assistant');
      if (text.trim()) sections.push({ role: 'assistant', lines: [text] });
      const callLines = [];
      for (const call of message.tool_calls ?? []) {
        const fn = call?.function ?? {};
        if (!fn.name) continue;
        callLines.push(renderToolCall(fn.name, fn.arguments));
      }
      if (callLines.length) sections.push({ role: 'toolCalls', lines: callLines });
      if (!text.trim() && !callLines.length) sections.push({ role: 'assistant', lines: [''] });
      continue;
    }

    const name =
      message.name ||
      (message.tool_call_id && toolNameById[message.tool_call_id]) ||
      findLastToolName(sections) ||
      'unknown';
    const resultLine = renderToolResult(name, contentToText(message.content, role));
    const last = sections.at(-1);
    if (last?.role === 'toolResult') last.lines.push(resultLine);
    else sections.push({ role: 'toolResult', lines: [resultLine] });
  }

  const lastSection = sections.at(-1);
  if (lastSection?.role === 'toolResult') {
    lastSection.lines.push('', FINAL_ANSWER_HINT);
  }

  const parts = [];
  if (systemTexts.length) parts.push(SECTION.system, systemTexts.join('\n\n'));
  for (const section of sections) {
    let body = section.lines.join('\n').trim();
    if (section.role === 'assistant' && !body.includes(REPLY_END_TOKEN)) {
      body = body ? `${body}\n${REPLY_END_TOKEN}` : REPLY_END_TOKEN;
    }
    parts.push('', SECTION[section.role], body);
  }
  if (!sections.length && !systemTexts.length) {
    throw new ApiError(400, '没有可发送的增量内容', { code: 'empty_delta' });
  }

  const prompt = parts.join('\n').trim();
  return {
    prompt,
    systemTexts,
    protocolText: '',
    toolNames: [],
    stats: {
      chars: prompt.length,
      sections: sections.length,
      systemMessages: systemTexts.length,
      tools: 0,
      delta: true,
    },
  };
}

/** 从完整历史里收集 tool_call_id → 工具名（增量 prompt 只有 tool 结果时用） */
export function collectToolNamesById(messages = []) {
  const map = {};
  for (const message of messages) {
    for (const call of message?.tool_calls ?? []) {
      const id = call?.id;
      const name = call?.function?.name;
      if (id && name) map[id] = name;
    }
  }
  return map;
}

/** 从历史里最近的 ## Tool_calls 段倒着找工具名（tool 结果没带 name 时兜底） */
function findLastToolName(sections) {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i].role !== 'toolCalls') continue;
    for (let j = sections[i].lines.length - 1; j >= 0; j -= 1) {
      const body = toolCallBodyOf(sections[i].lines[j]);
      if (!body) continue;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.name === 'string') return parsed.name;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 从一行历史（哨兵块或旧版裸 JSON）里取出 JSON 正文 */
function toolCallBodyOf(line) {
  if (!line) return null;
  if (line.startsWith(TOOL_CALL_OPEN) && line.endsWith(TOOL_CALL_CLOSE)) {
    return line.slice(TOOL_CALL_OPEN.length, -TOOL_CALL_CLOSE.length);
  }
  if (line.startsWith('{')) return line;
  return null;
}

/**
 * 把一次工具调用渲染成历史里给模型看的一行（绝不写 DSML / DO）。
 * 形如：[[TOOL_CALL]]{"name":"exec_shell","arguments":{"command":"uname -a"}}[[/TOOL_CALL]]
 */
function renderToolCall(name, args) {
  let parsed = {};
  if (typeof args === 'string') {
    try {
      const value = JSON.parse(args);
      parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : { input: value };
    } catch {
      parsed = { input: args };
    }
  } else if (args && typeof args === 'object') {
    parsed = args;
  }

  return `${TOOL_CALL_OPEN}${JSON.stringify({ name, arguments: parsed })}${TOOL_CALL_CLOSE}`;
}
