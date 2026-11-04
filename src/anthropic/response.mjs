import crypto from 'node:crypto';

import { AUTH_NEXT_ACTION } from '../errors.mjs';
import { estimateTokens } from '../util.mjs';

export const newMessageId = () => `msg_${crypto.randomBytes(12).toString('hex')}`;

/** 生成 tool_use 块 id；流式和非流式都用同一套规则，客户端回传后能对上 */
export const toolUseId = (messageId, index) => `toolu_${String(messageId).slice(-12)}_${index}`;

/**
 * 估算 Anthropic usage。output_tokens 必须包含 thinking token：
 * Anthropic 官方把 thinking 也算进 output_tokens，少算会让客户端显示的 tok/s 偏低。
 */
export function estimateMessageUsage(promptText, outputText, reasoningText = '') {
  return {
    input_tokens: estimateTokens(promptText || ''),
    output_tokens: estimateTokens(outputText || '') + estimateTokens(reasoningText || ''),
  };
}

/**
 * 非流式的 Anthropic message 响应。
 * content 是块数组：thinking（有思考内容时）→ text → tool_use。
 */
export function buildMessageResponse({ id, model, content, reasoning, toolCalls, stopReason, usage }) {
  const blocks = [];

  if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning, signature: '' });
  if (content) blocks.push({ type: 'text', text: content });

  for (const [index, call] of (toolCalls ?? []).entries()) {
    blocks.push({
      type: 'tool_use',
      id: call.id ?? toolUseId(id, index),
      name: call.name,
      input: parseInput(call.arguments),
    });
  }

  // Anthropic 要求 content 至少有一个块
  if (!blocks.length) blocks.push({ type: 'text', text: '' });

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

/** 工具参数在 Anthropic 里是对象，不是 JSON 字符串 */
export function parseInput(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string' || !args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { input: parsed };
  } catch {
    return { input: args };
  }
}

/** Anthropic 风格的错误体：{ type: 'error', error: { type, message } } */
export function anthropicErrorPayload(err) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const type =
    status === 400
      ? 'invalid_request_error'
      : status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 404
            ? 'not_found_error'
            : status === 413
              ? 'request_too_large'
              : status === 429
                ? 'rate_limit_error'
                : status >= 500
                  ? 'api_error'
                  : 'invalid_request_error';
  const isAuth = err?.code === 'deepseek_auth_required';
  const message = isAuth && !String(err?.message || '').includes('auth:hybrid')
    ? `${err?.message || '登录态失效'}。请重新登录：npm run auth:hybrid（使用手册 §6）`
    : err?.message || 'internal error';
  return {
    type: 'error',
    error: { type, message, ...(isAuth ? { nextAction: AUTH_NEXT_ACTION } : {}) },
  };
}
