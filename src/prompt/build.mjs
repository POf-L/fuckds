import { ApiError } from '../errors.mjs';
import { contentToText } from '../util.mjs';
import { FINAL_ANSWER_HINT, PROMPT_HEADER, REPLY_END_TOKEN, SECTION, SPECIAL_TOKENS_HEADER } from './special.mjs';
import { collectToolNames, renderCompactToolDeclarations, renderToolDeclarations, renderToolResult } from './tools.mjs';

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
 *   {"name":"exec_shell","args":{"command":"uname -a"}}
 *
 *   ## Tool_call_result:
 *   {"name":"exec_shell","result":"Linux"}
 *
 *   ## User:
 *   解释一下
 *
 * 顺序：客户端 system 在最上面，自带协议提示词夹在中间，工具声明和对话历史（user）在后面。
 *
 * 注意两件事：
 * - 模型输出工具调用走原生 DSML（见 special.mjs），但**历史里绝不回写 DSML**：
 *   已发生的调用统一渲染成 ## Tool_calls 段的 JSON 行，模型没有可模仿的语法样板；
 * - 工具结果**单独成段**（## Tool_call_result），不塞进 ## Assistant，
 *   模型就不会把「assistant 说调用、然后自己写结果」当成正确的模仿对象。
 */
export function buildPrompt({ messages, tools = [], systemExtra = '', toolDeclMode = 'full' }) {
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
      // 历史调用单独成段：只写 JSON，不写 DSML / DO，避免模型照抄语法
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

  // full：完整 JSON 声明；compact：一行一个工具（体积约剩 1/10，且永不挪进附件）
  const toolLines =
    toolDeclMode === 'compact' ? renderCompactToolDeclarations(tools) : renderToolDeclarations(tools);
  if (toolLines.length) {
    parts.push('', SECTION.tools, ...toolLines);
  }

  // 自带的协议提示词：单独一个 system 块，放在 TOOL_FUNCTIONS 之后、USER 之前
  parts.push('', SECTION.system, SPECIAL_TOKENS_HEADER.trim());

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
    toolNames: collectToolNames(tools),
    stats: {
      chars: prompt.length,
      sections: sections.length,
      systemMessages: systemTexts.length,
      tools: toolLines.length,
      toolDeclMode,
    },
  };
}

/** 从历史里最近的 ## Tool_calls 段倒着找工具名（tool 结果没带 name 时兜底） */
function findLastToolName(sections) {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i].role !== 'toolCalls') continue;
    for (let j = sections[i].lines.length - 1; j >= 0; j -= 1) {
      const line = sections[i].lines[j];
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.name === 'string') return parsed.name;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 把一次工具调用渲染成历史里给模型看的一行 JSON（绝不写 DSML / DO）。
 * 形如：{"name":"exec_shell","args":{"command":"uname -a"}}
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

  return JSON.stringify({ name, args: parsed });
}
