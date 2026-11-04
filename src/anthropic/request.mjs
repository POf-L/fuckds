import { ApiError } from '../errors.mjs';
import { collectImages, mergeCounts } from '../openai/request.mjs';
import { buildPrompt } from '../prompt/build.mjs';
import { sanitizeMessages, sanitizeTools } from '../prompt/sanitize.mjs';
import { estimateTokens } from '../util.mjs';

/**
 * 把 Anthropic Messages API 的请求体转换成内部统一语义（OpenAI messages）。
 *
 * 两个协议的差异都在这里吃掉：
 *   - system 是顶层字段（字符串或 text 块数组）→ 一条 system 消息
 *   - content 是块数组（text / image / tool_use / tool_result / thinking）
 *   - tool_result 在 Anthropic 里是 user 消息里的块，在 OpenAI 里是独立的 tool 消息
 *   - tools 用 name/description/input_schema，OpenAI 用 function.{name,description,parameters}
 */
export function normalizeMessagesRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, '请求体必须是 JSON 对象', { code: 'invalid_body' });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError(400, '缺少 messages 字段（或为空）', { code: 'invalid_messages', param: 'messages' });
  }

  const model =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.deepseek.defaultModel;

  const messages = [];
  const systemText = systemToText(body.system);
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const [index, message] of body.messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new ApiError(400, `messages[${index}] 不是对象`, {
        code: 'invalid_messages',
        param: `messages[${index}]`,
      });
    }
    if (message.role === 'user') {
      messages.push(...userMessages(message.content, index));
      continue;
    }
    if (message.role === 'assistant') {
      messages.push(assistantMessage(message.content, index));
      continue;
    }
    // 有的客户端会把 system 塞进 messages 里（虽然官方要求放顶层），兼容一下
    if (message.role === 'system' || message.role === 'developer') {
      const text = systemToText(message.content);
      if (text) messages.push({ role: 'system', content: text });
      continue;
    }
    throw new ApiError(400, `messages[${index}].role 不支持: ${JSON.stringify(message.role)}`, {
      code: 'invalid_role',
      param: `messages[${index}].role`,
    });
  }

  const stripped = { tools: 0, toolChoice: false };
  let tools;
  if (config.sanitize?.stripClientTools) {
    // 实验模式：故意丢弃工具定义（纯聊天 / 省 token）
    stripped.tools = Array.isArray(body.tools) ? body.tools.length : 0;
    stripped.toolChoice = body.tool_choice !== undefined;
    tools = [];
  } else {
    tools = normalizeTools(body.tools);
    // tool_choice:{type:"none"} = 这轮别调工具，按语义不渲染
    if (body.tool_choice?.type === 'none' && tools.length) {
      stripped.tools = tools.length;
      tools = [];
    }
  }

  // 归一化阶段清掉 XML 协议标签：system / 对话历史 / tool_result / 工具定义
  const enabled = config.sanitize?.markup !== false;
  const cleaned = sanitizeMessages(messages, { enabled });
  const cleanedTools = sanitizeTools(tools, { enabled });

  return {
    model,
    messages: cleaned.messages,
    images: collectImages(messages),
    tools: cleanedTools.tools,
    sanitize: {
      markup: {
        count: cleaned.hits.count + cleanedTools.hits.count,
        byName: mergeCounts(cleaned.hits.byName, cleanedTools.hits.byName),
      },
      stripped,
    },
    stream: Boolean(body.stream),
    streamIncludeUsage: false,
    // 会话复用映射键（Anthropic 也没有标准字段；metadata.user_id 是终端用户，不是对话）
    conversationId:
      [body.conversation_id, body.session_id, body.metadata?.conversation_id].find(
        (v) => typeof v === 'string' && v.trim(),
      )?.trim() || null,
    // 网页版不能调采样参数，这些字段接受但忽略，保持客户端兼容
    ignored: [
      'temperature',
      'top_p',
      'top_k',
      'max_tokens',
      'stop_sequences',
      'metadata',
      'tool_choice',
    ].filter((key) => body[key] !== undefined),
    thinking: resolveThinking(body, model, config),
    search: config.deepseek.search,
  };
}

/** count_tokens 接口：按拼出来的 prompt 估算，和实际请求用的是同一套拼装逻辑 */
export function countMessagesTokens(body, config) {
  const request = normalizeMessagesRequest(body, config);
  const built = buildPrompt({ messages: request.messages, tools: request.tools });
  return estimateTokens(built.prompt);
}

function blocksOf(content, index) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === 'object');
  if (content === undefined || content === null) return [];
  throw new ApiError(400, `messages[${index}].content 类型不支持`, { code: 'invalid_content' });
}

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system.trim();
  if (Array.isArray(system)) {
    return system
      .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text ?? '' : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

/** user 消息里的块：text/image 合成一条 user 消息，tool_result 拆成独立的 tool 消息 */
function userMessages(content, index) {
  const out = [];
  let parts = [];

  const flush = () => {
    if (!parts.length) return;
    out.push({
      role: 'user',
      content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
    });
    parts = [];
  };

  for (const block of blocksOf(content, index)) {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text) parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: imageUrlOf(block, index) } });
      continue;
    }
    if (block.type === 'tool_result') {
      flush();
      out.push({
        role: 'tool',
        tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
        content: toolResultText(block),
      });
      continue;
    }
    // thinking / document / server_tool_use 等块忽略：网页版用不到
  }

  flush();
  return out;
}

function assistantMessage(content, index) {
  const texts = [];
  const toolCalls = [];

  for (const block of blocksOf(content, index)) {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text) texts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      if (typeof block.name !== 'string' || !block.name.trim()) {
        throw new ApiError(400, `messages[${index}] 的 tool_use 块缺少 name`, { code: 'invalid_tools' });
      }
      const call = {
        type: 'function',
        function: { name: block.name.trim(), arguments: JSON.stringify(block.input ?? {}) },
      };
      if (typeof block.id === 'string' && block.id) call.id = block.id;
      toolCalls.push(call);
    }
  }

  const message = { role: 'assistant', content: texts.join('\n') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

function imageUrlOf(block, index) {
  const source = block.source;
  if (!source || typeof source !== 'object') {
    throw new ApiError(400, `messages[${index}] 的图片缺少 source`, { code: 'invalid_image' });
  }
  if (source.type === 'base64') {
    if (typeof source.data !== 'string' || !source.data) {
      throw new ApiError(400, `messages[${index}] 的图片缺少 base64 data`, { code: 'invalid_image' });
    }
    return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  }
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !source.url.trim()) {
      throw new ApiError(400, `messages[${index}] 的图片缺少 url`, { code: 'invalid_image' });
    }
    return source.url.trim();
  }
  throw new ApiError(400, `不支持的图片 source.type: ${source.type}`, { code: 'invalid_image' });
}

function toolResultText(block) {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : ''))
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool, index) => {
    const fn = tool?.function ?? tool;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) {
      throw new ApiError(400, `tools[${index}] 缺少 name`, {
        code: 'invalid_tools',
        param: `tools[${index}]`,
      });
    }
    const out = { type: 'function', function: { name: fn.name.trim() } };
    if (fn.description) out.function.description = String(fn.description);
    const parameters = fn.parameters ?? fn.input_schema;
    if (parameters && typeof parameters === 'object') out.function.parameters = parameters;
    return out;
  });
}

function resolveThinking(body, model, config) {
  const thinking = body.thinking;
  if (thinking && typeof thinking === 'object') {
    if (thinking.type === 'enabled') return true;
    if (thinking.type === 'disabled') return false;
  }
  if (typeof thinking === 'boolean') return thinking;
  if (config.deepseek.thinking === 'always') return true;
  if (config.deepseek.thinking === 'never') return false;

  const alias = config.deepseek.modelAliases?.[model];
  if (alias && alias.thinking !== undefined) return alias.thinking;

  return /reason|r1|think/i.test(model);
}