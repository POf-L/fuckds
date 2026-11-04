/** 凭据失效时给客户端/用户的可执行动作（不要只丢一个 INVALID_TOKEN） */
export const AUTH_NEXT_ACTION = Object.freeze({
  action: 're-login',
  command: 'npm run auth:hybrid',
  doc: '使用手册 §6',
});

const AUTH_GUIDANCE = '请重新登录：npm run auth:hybrid';

function authGuidanceOf(err) {
  return err?.code === 'deepseek_auth_required' ? AUTH_NEXT_ACTION : null;
}

function authMessage(err, message) {
  if (!authGuidanceOf(err)) return message;
  return message.includes('auth:hybrid') ? message : `${message}。${AUTH_GUIDANCE}（使用手册 §6）`;
}

/** OpenAI 兼容的错误对象 */
export class ApiError extends Error {
  constructor(status, message, { type = 'invalid_request_error', code = null, param = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }

  toJSON() {
    const nextAction = authGuidanceOf(this);
    return {
      error: {
        message: authMessage(this, this.message),
        type: this.type,
        param: this.param,
        code: this.code,
        ...(nextAction ? { nextAction } : {}),
      },
    };
  }
}

export const badRequest = (message, code = 'invalid_request') => new ApiError(400, message, { code });
export const unauthorized = (message = '缺少或错误的 API Key') =>
  new ApiError(401, message, { type: 'authentication_error', code: 'invalid_api_key' });
export const notFound = (message = 'Not found') => new ApiError(404, message, { code: 'not_found' });

/** 浏览器/网页侧的问题（登录失效、验证码、页面改版……） */
export class UpstreamError extends ApiError {
  constructor(message, { status = 502, code = 'deepseek_web_error' } = {}) {
    super(status, message, { type: 'upstream_error', code });
    this.name = 'UpstreamError';
  }
}

export class AuthExpiredError extends UpstreamError {
  constructor(
    message = 'DeepSeek 登录态无效或已过期。请重新登录：npm run auth:hybrid（使用手册 §6）',
  ) {
    // 凭据失效必须是 401：客户端要能据此重新登录，而不是当成上游 5xx 无脑重试。
    // code 保持 deepseek_auth_required，方便日志/监控按 code 聚合。
    super(message, { status: 401, code: 'deepseek_auth_required' });
    this.name = 'AuthExpiredError';
  }
}

export class CaptchaError extends UpstreamError {
  constructor(message = 'DeepSeek 弹出了人机验证 / 验证码，自动化无法继续。请换网络或稍后重试') {
    super(message, { status: 503, code: 'deepseek_captcha' });
    this.name = 'CaptchaError';
  }
}

export class RateLimitError extends UpstreamError {
  constructor(
    message = 'DeepSeek 网页提示发送过于频繁（同一账号短时间内消息太多），请稍后重试',
    { retryAfterMs = 60_000 } = {},
  ) {
    super(message, { status: 429, code: 'deepseek_rate_limited' });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class PromptTooLongError extends ApiError {
  constructor(message = '拼接后的 prompt 超出 DeepSeek 网页输入上限，请减少上下文') {
    super(413, message, { type: 'invalid_request_error', code: 'context_length_exceeded' });
    this.name = 'PromptTooLongError';
  }
}

export class TimeoutError extends ApiError {
  constructor(message = '等待 DeepSeek 响应超时') {
    super(504, message, { type: 'upstream_error', code: 'upstream_timeout' });
    this.name = 'TimeoutError';
  }
}
