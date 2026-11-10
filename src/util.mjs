import { ApiError } from './errors.mjs';

const TEXT_PART_TYPES = new Set(['text', 'input_text']);
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);

/**
 * 从 OpenAI content（string 或 parts 数组）里取文本。
 * 网页版输入框只能塞纯文本，图片/音频直接报错，避免静默丢内容。
 */
export function contentToText(content, role = 'user') {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new ApiError(400, `messages 中 ${role} 的 content 类型不支持: ${typeof content}`, {
      code: 'invalid_content',
    });
  }
  const chunks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = part.type || (part.text !== undefined ? 'text' : '');
    if (TEXT_PART_TYPES.has(type) || typeof part.text === 'string') {
      if (typeof part.text === 'string') chunks.push(part.text);
      continue;
    }
    if (IMAGE_PART_TYPES.has(type)) {
      // 图片由 normalizeChatRequest 单独收集，这里只取文本
      continue;
    }
    throw new ApiError(400, `不支持的 content part 类型: ${type}`, { code: 'unsupported_content' });
  }
  return chunks.join('\n');
}

/**
 * 极粗略的 token 估算：中文按 1 字 1 token，其余按 4 字符 1 token。
 *
 * 原实现对每个字符跑一次正则，超长 prompt（10 万字起）下是可观的
 * 常数开销；改成码点区间比较，并按码点（而非 UTF-16 单元）计数，
 * 表情等增补字符不再被算成两个。openai/response.mjs 原来还有一份
 * 逻辑相同但阈值不同的私有实现，现统一到这里，两协议口径一致。
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

/**
 * 解析 .env 文本：config.mjs（启动加载）和 admin/routes.mjs（后台读配置）
 * 原来各写了一份，且对引号/注释的处理要保持一致，抽到这里。
 * 返回键值对象；不处理 export 前缀以外的 shell 语法，和原来保持一致。
 */
export function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function withTimeout(promise, ms, message = 'operation timed out') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
