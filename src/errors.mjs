/** 凭据失效时给客户端/用户的可执行动作（不要只丢一个 INVALID_TOKEN） */
export const AUTH_NEXT_ACTION = Object.freeze({
  action: 're-login',
  command: 'npm run auth:hybrid',
  panel: '/admin → 账号 → 协议通道账号 → 打开登录窗口',
  doc: '使用手册 §6',
});

/**
 * 上游要求人机挑战（业务码 40303 / CHALLENGE_REQUIRED）时给客户端的可执行动作。
 *
 * 注意：这个命令只复用「已登录的同一个浏览器实例」，不会新开第二个实例。
 */
export const CHALLENGE_NEXT_ACTION = Object.freeze({
  action: 'complete-challenge',
  command: 'npm run recover:challenge',
  doc: '使用手册 §6.1',
  note: '在已登录的同一个浏览器实例里完成人机挑战；网关不会自动新开浏览器',
});

const AUTH_GUIDANCE = '请重新登录：/admin 面板「账号」页，或 npm run auth:hybrid';

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
    const nextAction = this.nextAction || authGuidanceOf(this);
    return {
      error: {
        message: authMessage(this, this.message),
        type: this.type,
        param: this.param,
        code: this.code,
        ...(nextAction ? { nextAction } : {}),
        // 显式 false，避免客户端把「需要人工挑战」当成可重试的上游 5xx。
        ...(this.retryable === false ? { retryable: false } : {}),
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
    message = 'DeepSeek 登录态无效或已过期。请到 /admin 面板「账号」页重新登录，或运行 npm run auth:hybrid（使用手册 §6）',
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

/**
 * 上游要求完成人机挑战：`{ status: 200, code: 40303, msg: 'CHALLENGE_REQUIRED' }`。
 *
 * 为什么是 429 而不是 503：
 * - 503 是典型「可重试 5xx」，上一轮真实测试里网关把 40303 包成 502，
 *   客户端因此连续重试，把 1 次失败放大成 22 条补全请求；
 * - 429 是 4xx 语义，且是唯一能合法携带标准 `Retry-After` 的状态码，
 *   配合 `code=challenge_required` / `retryable=false` / `nextAction`，
 *   让客户端「停下来等人」，而不是继续打上游。
 * - 网关侧还会对同一会话做 60s 硬闸，即使客户端仍重试也不会再触达上游。
 */
export class ChallengeRequiredError extends UpstreamError {
  constructor(
    message = 'DeepSeek 要求完成人机挑战（CHALLENGE_REQUIRED/40303），自动化已停止。请运行 `npm run recover:challenge` 在已登录浏览器完成挑战后重试',
    { retryAfterMs = 60_000 } = {},
  ) {
    super(message, { status: 429, code: 'challenge_required' });
    this.name = 'ChallengeRequiredError';
    this.retryAfterMs = retryAfterMs;
    this.retryable = false;
    this.nextAction = CHALLENGE_NEXT_ACTION;
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
