import { ApiError } from '../errors.mjs';
import { sanitizeMessages, sanitizeTools } from '../prompt/sanitize.mjs';

const SUPPORTED_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

/**
 * 校验并规范化 /v1/chat/completions 的请求体。
 */
export function normalizeChatRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, '请求体必须是 JSON 对象', { code: 'invalid_body' });
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, '缺少 messages 字段（或为空）', { code: 'invalid_messages', param: 'messages' });
  }

  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== 'object' || !SUPPORTED_ROLES.has(m.role)) {
      throw new ApiError(400, `messages[${i}].role 不支持: ${JSON.stringify(m?.role)}`, {
        code: 'invalid_role',
        param: `messages[${i}].role`,
      });
    }
  }

  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.deepseek.defaultModel;

  const incomingTools = Array.isArray(body.tools) ? body.tools : [];
  const stripped = { tools: 0, toolChoice: false };
  let tools = incomingTools;

  if (config.sanitize?.stripClientTools) {
    // 实验模式：故意丢弃工具定义（纯聊天 / 省 token）
    stripped.tools = incomingTools.length;
    stripped.toolChoice = body.tool_choice !== undefined;
    tools = [];
  } else {
    for (const [i, tool] of incomingTools.entries()) {
      const fn = tool?.function ?? tool;
      if (!fn || typeof fn.name !== 'string') {
        throw new ApiError(400, `tools[${i}] 缺少 function.name`, {
          code: 'invalid_tools',
          param: `tools[${i}]`,
        });
      }
    }
    // tool_choice="none" 是客户端明确要求「这轮别调工具」，按语义不渲染
    if (body.tool_choice === 'none' && tools.length) {
      stripped.tools = tools.length;
      tools = [];
    }
  }

  // 在归一化阶段清掉 XML 协议标签：所有会进 prompt 的文本都过一遍
  const sanitizeEnabled = config.sanitize?.markup !== false;
  const cleaned = sanitizeMessages(messages, { enabled: sanitizeEnabled });
  const cleanedTools = sanitizeTools(tools, { enabled: sanitizeEnabled });
  const sanitize = {
    markup: {
      count: cleaned.hits.count + cleanedTools.hits.count,
      byName: mergeCounts(cleaned.hits.byName, cleanedTools.hits.byName),
    },
    stripped,
  };

  const stream = Boolean(body.stream);
  const streamIncludeUsage = Boolean(body.stream_options?.include_usage);

  return {
    model,
    messages: cleaned.messages,
    images: collectImages(messages),
    tools: cleanedTools.tools,
    sanitize,
    stream,
    streamIncludeUsage,
    // 网页版不能调采样参数，这些字段接受但忽略，保持客户端兼容
    ignored: ['temperature', 'top_p', 'max_tokens', 'stop', 'presence_penalty', 'frequency_penalty'].filter(
      (k) => body[k] !== undefined,
    ),
    thinking: resolveThinking(body, model, config),
    search: body.search === undefined ? config.deepseek.search : Boolean(body.search),
  };
}

/** 合并两份命中统计（只累加数量与标签名） */
export function mergeCounts(a = {}, b = {}) {
  const out = { ...a };
  for (const [name, n] of Object.entries(b)) out[name] = (out[name] ?? 0) + n;
  return out;
}

const MAX_IMAGES = 8;

/** 从 messages 里收集图片（只认 user 的 image_url 部分） */
export function collectImages(messages = []) {
  const images = [];
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const type = part.type || (part.image_url ? 'image_url' : '');
      if (!['image_url', 'input_image', 'image'].includes(type)) continue;
      const url = part.image_url?.url ?? part.image_url ?? part.url ?? part.data;
      if (typeof url === 'string' && url.trim()) images.push({ url: url.trim() });
    }
  }
  if (images.length > MAX_IMAGES) {
    throw new ApiError(400, `一条请求最多 ${MAX_IMAGES} 张图片`, { code: 'too_many_images' });
  }
  return images;
}

function resolveThinking(body, model, config) {
  if (body.thinking !== undefined) return Boolean(body.thinking);
  if (config.deepseek.thinking === 'always') return true;
  if (config.deepseek.thinking === 'never') return false;

  const alias = config.deepseek.modelAliases[model];
  if (alias && alias.thinking !== undefined) return alias.thinking;

  return /reason|r1|think/i.test(model);
}

export function normalizeCompletionRequest(body, config) {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, '请求体必须是 JSON 对象', { code: 'invalid_body' });
  }
  const rawPrompt = typeof body.prompt === 'string' ? body.prompt : Array.isArray(body.prompt) ? body.prompt.join('\n') : '';
  if (!rawPrompt) throw new ApiError(400, '缺少 prompt 字段', { code: 'invalid_prompt', param: 'prompt' });

  const cleaned = sanitizeMessages([{ role: 'user', content: rawPrompt }], {
    enabled: config.sanitize?.markup !== false,
  });

  return {
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.deepseek.defaultModel,
    messages: cleaned.messages,
    tools: [],
    sanitize: { markup: cleaned.hits, stripped: { tools: 0, toolChoice: false } },
    stream: Boolean(body.stream),
    streamIncludeUsage: false,
    ignored: [],
    thinking: config.deepseek.thinking === 'always',
    search: config.deepseek.search,
  };
}
