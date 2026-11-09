import { ApiError } from '../errors.mjs';

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

  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const [i, tool] of tools.entries()) {
    const fn = tool?.function ?? tool;
    if (!fn || typeof fn.name !== 'string') {
      throw new ApiError(400, `tools[${i}] 缺少 function.name`, {
        code: 'invalid_tools',
        param: `tools[${i}]`,
      });
    }
  }

  const stream = Boolean(body.stream);
  const streamIncludeUsage = Boolean(body.stream_options?.include_usage);

  return {
    model,
    messages,
    images: collectImages(messages),
    tools,
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
  const prompt = typeof body.prompt === 'string' ? body.prompt : Array.isArray(body.prompt) ? body.prompt.join('\n') : '';
  if (!prompt) throw new ApiError(400, '缺少 prompt 字段', { code: 'invalid_prompt', param: 'prompt' });

  return {
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.deepseek.defaultModel,
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    stream: Boolean(body.stream),
    streamIncludeUsage: false,
    ignored: [],
    thinking: config.deepseek.thinking === 'always',
    search: config.deepseek.search,
  };
}
