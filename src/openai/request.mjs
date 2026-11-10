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
    // 会话复用映射键：客户端显式给的最稳，没有就用 system+首条 user 的稳定哈希
    conversationId: pickConversationId(body),
  };
}

/** 客户端自带的对话标识（OpenAI 无标准字段，这里兼容常见写法） */
export function pickConversationId(body = {}) {
  for (const candidate of [body.conversation_id, body.session_id, body.metadata?.conversation_id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/** 合并两份命中统计（只累加数量与标签名） */
export function mergeCounts(a = {}, b = {}) {
  const out = { ...a };
  for (const [name, n] of Object.entries(b)) out[name] = (out[name] ?? 0) + n;
  return out;
}

const MAX_IMAGES = 8;

/**
 * 收集「需要上传给网页版」的图片。
 *
 * 关键：只看**最后一条 user 消息**里的图片，不看整个历史。
 *
 * 为什么：prompt 拼接时历史图片本来就不进正文（contentToText 直接丢弃图片块，
 * 只有文本进 prompt），所以历史图片传上去也没人看；
 * 但之前这里扫描的是全部 messages，于是每多一轮对话，历史截图就被重新收集一遍、
 * 重新上传一遍 —— 聊天轮次一多就超过 8 张，直接 400「一条请求最多 8 张图片」，
 * 表现就是「明明一张图都没发，聊久了就报错」。
 *
 * 只取最后一条 user 消息，既符合「图片只在当轮有意义」的语义，
 * 也避免了重复上传旧图带来的额外耗时。
 */
export function collectImages(messages = []) {
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') return i;
    }
    return -1;
  })();
  if (lastUserIndex < 0) return [];

  const message = messages[lastUserIndex];
  if (!Array.isArray(message.content)) return [];

  const images = [];
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    const type = part.type || (part.image_url ? 'image_url' : '');
    if (!['image_url', 'input_image', 'image'].includes(type)) continue;
    const url = part.image_url?.url ?? part.image_url ?? part.url ?? part.data;
    if (typeof url === 'string' && url.trim()) images.push({ url: url.trim() });
  }

  if (images.length > MAX_IMAGES) {
    const summary = images.map((image, i) => {
      const url = String(image.url ?? '');
      const kind = url.startsWith('data:') ? 'data-url' : url.startsWith('http') ? 'http-url' : 'raw';
      return `#${i + 1} ${kind}(${url.length}字符)`;
    });
    throw new ApiError(
      400,
      `一条请求最多 ${MAX_IMAGES} 张图片（当前这条消息里识别到 ${images.length} 张：${summary.join(' | ')}）`,
      { code: 'too_many_images' },
    );
  }
  return images;
}

function resolveThinking(body, model, config) {
  if (body.thinking !== undefined) return Boolean(body.thinking);
  // OpenAI 的 reasoning_effort：DeepSeek 网页只有「深度思考 开/关」，没有 low/medium/high 分档。
  // 约定 none/off = 关闭，其余档位一律视为打开（不伪造多档差异）。
  if (typeof body.reasoning_effort === 'string') {
    const effort = body.reasoning_effort.trim().toLowerCase();
    return effort !== 'none' && effort !== 'off';
  }
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
    conversationId: pickConversationId(body),
    ignored: [],
    thinking: config.deepseek.thinking === 'always',
    search: config.deepseek.search,
  };
}
