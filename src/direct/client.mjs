import crypto from 'node:crypto';

import { ApiError, AuthExpiredError, PromptTooLongError, RateLimitError, TimeoutError, UpstreamError } from '../errors.mjs';
import { sleep } from '../util.mjs';
import { AccountPool } from './account-pool.mjs';
import {
  buildBrowserHeaders,
  buildUploadHeaders,
  padPowDuration,
  runColdStartSequence,
  typingDelay,
} from './fingerprint.mjs';
import { PowSolver } from './pow.mjs';
import { applyPatch, createSseParser, createStreamState, createTextTracker } from './stream.mjs';

const COMPLETION_PATH = '/api/v0/chat/completion';
const UPLOAD_PATH = '/api/v0/file/upload_file';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const FILE_CACHE_TTL_MS = 30 * 60_000;
const API_ERROR_MAX_RETRIES = 3;
const API_ERROR_RETRY_DELAY_MS = 500;

/**
 * 登录态失效的账号停用多久（毫秒）。
 *
 * token 失效不会自己恢复，换 token / 重启进程之前都不该再选它；
 * 这里用一个有限的大值（而不是 Infinity），保证 /healthz 的 cooldownMs 能正常序列化。
 */
export const AUTH_INVALID_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * DeepSeek 的登录态失效不走 HTTP 401，而是 HTTP 200 + 业务错误：
 *
 *   {"code":40003,"msg":"INVALID_TOKEN","data":null}
 *
 * 只按 res.status 判定的话，这类响应会落进通用的 UpstreamError，
 * 对外表现为「登录失效被说成限流」/「单 token 时完全不标记」两种错误语义。
 *
 * 这里只认 **msg 精确等于这几个值**（不做宽松正则）：
 * 「Authorization Failed (invalid token)」这类文案分不清是真失效还是风控临时拦截，
 * 用它触发 24h 停用会把好号误锁一天（authFailed 一旦置位就不会自愈，必须换 token 才恢复）。
 */
const AUTH_INVALID_MESSAGES = new Set([
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'USER_NOT_FOUND',
  'NOT_LOGGED_IN',
]);

/** 上游 msg / biz_msg 是否是明确的「登录态失效」 */
export function isAuthInvalidMessage(message) {
  if (!message) return false;
  return AUTH_INVALID_MESSAGES.has(String(message).trim().toUpperCase());
}

/**
 * 判断错误是否属于「这个账号此刻不能用」，可以在同一个请求里换号重试。
 *
 * 客户端断开（499）、超时、参数类错误都跟账号无关，直接抛给调用方；
 * 限流、登录态失效、上游报错则先停用当前号再试下一个。
 */
export function isAccountScopedFailure(err) {
  if (err instanceof RateLimitError || err instanceof AuthExpiredError) return true;
  if (err instanceof UpstreamError) {
    return !(err.status === 499 || err.code === 'client_closed');
  }
  return false;
}

/**
 * PoW header 缓存的安全余量（毫秒）。
 *
 * create_pow_challenge 返回的 challenge 带 expire_at：过期后服务端会拒收
 * （INVALID_POW_RESPONSE / 40301）。预解好的 header 可能因为「解完很久才用到」
 * 而接近/超过有效期，所以取用时必须留出余量，不足就重新取 challenge + 重新解。
 * 5s 足够覆盖取 header 到真正发出补全请求之间的行为时序伪装延迟。
 */
export const POW_EXPIRY_SAFETY_MS = 5_000;

/**
 * 判断 challenge 的 expire_at 是否仍可用（未过期且还有 safetyMs 余量）。
 *
 * 服务端给的是 unix 秒；若数值明显像毫秒（> 1e12）也兼容。字段缺失（falsy）时
 * 保守地认为可用，保持与旧行为一致。
 */
export function powNotExpired(expireAt, now = Date.now(), safetyMs = POW_EXPIRY_SAFETY_MS) {
  if (!expireAt) return true;
  const expireMs = expireAt > 1e12 ? expireAt : expireAt * 1000;
  return expireMs - now > safetyMs;
}

/**
 * 直连引擎：不走浏览器，直接调 chat.deepseek.com 的内部接口。
 *
 *   POST /api/v0/chat_session/create       → 每次请求一个新会话
 *   POST /api/v0/chat/create_pow_challenge → 拿 PoW 挑战
 *   POST /api/v0/chat/completion           → SSE 流式补全
 *
 * 多账号：DeepSeek 按「窗口内消息条数」限流（不是按间隔），撞了就换池里的下一个账号。
 * PoW 用 Go 求解（bin/ds-pow），14.4 万次搜索约 20–30ms。
 */
export class DirectEngine {
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger;
    this.baseUrl = config.deepseek.baseUrl.replace(/\/+$/, '');
    this.tokens = config.deepseek.tokens?.length
      ? config.deepseek.tokens
      : [config.deepseek.token].filter(Boolean);

    this.pool = new AccountPool({ tokens: this.tokens, dataDir: config.dataDir, logger });
    this.pow = new PowSolver({ bin: config.direct.powBin, logger });
    this.fileCache = new Map();
    this.inflight = 0;
    this.closed = false;
    this.coldStarted = false;
  }

  /* ------------------------------------------------------------------ */

  async ensureStarted() {
    if (!this.tokens.length) {
      throw new AuthExpiredError(
        '还没有配置 DeepSeek 的 userToken：执行 `npm run auth -- <userToken>`，或设置 DEEPSEEK_USER_TOKEN',
      );
    }
  }

  /** 预热：第一个账号提前解好 PoW、建好会话，并跑一次冷启动序列 */
  async warmUp() {
    await this.ensureStarted();
    const account = this.pool.accounts[0];
    if (!account) return;
    this.#prefetchPow(account);
    this.#prewarmSession(account);
    await account.powNext?.catch((err) => this.log.warn('PoW 预热失败:', err.message));

    // 冷启动：让账号在服务端有一份「网页打开过」的痕迹，
    // 而不是凭空开始发 API 请求。失败不影响主流程。
    if (this.config.deepseek.coldStart !== false) {
      this.#coldStart(account).catch((err) => this.log.warn('冷启动序列失败（忽略）:', err.message));
    }
  }

  async #coldStart(account) {
    if (this.coldStarted || this.closed) return;
    this.coldStarted = true;
    const { did } = await runColdStartSequence({
      baseUrl: this.baseUrl,
      headers: this.#headers(account),
      deviceId: account.deviceId,
      log: this.log,
    });
    account.did = did;
    this.log.debug(`账号 #${account.index + 1} 冷启动完成`, { did });
  }

  status() {
    return {
      engine: 'direct',
      browser: false,
      pages: 0,
      busy: this.inflight,
      queued: 0,
      token: this.tokens.length > 0,
      accounts: this.pool.status(),
    };
  }

  async close() {
    this.closed = true;
    this.pool.close();
    this.pow.close();
  }

  /* ------------------------------------------------------------------ *
   * 请求
   * ------------------------------------------------------------------ */

  async chat({ prompt, thinking = false, search = false, refFileIds = [], signal, onDelta, onThinking, meta = {} }) {
    if (prompt.length > this.config.runtime.maxPromptChars) {
      throw new PromptTooLongError(
        `拼接后的 prompt 有 ${prompt.length} 字符，超过上限 ${this.config.runtime.maxPromptChars}`,
      );
    }
    await this.ensureStarted();

    this.inflight += 1;
    const startedAt = Date.now();
    const { accountCooldownMs, rateLimitBackoffMs, maxCooldownWaitMs } = this.config.runtime;

    try {
      const maxAttempts = Math.max(1, this.pool.size) + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (signal?.aborted) throw new UpstreamError('客户端已断开', { status: 499, code: 'client_closed' });

        const now = Date.now();
        const account = this.pool.pick(now);
        if (!account) {
          const wait = this.pool.nextAvailableAt() - now;
          if (wait > maxCooldownWaitMs) {
            // 所有号都是登录态失效停用的：报登录态错误，别让调用方误以为是限流。
            //
            // 以前只查 allAuthFailed()，但 INVALID_TOKEN 走的是普通 markUnavailable、
            // 不会置 authFailed，于是「所有 token 都废了」被误报成 429 限流，
            // 客户端会按 Retry-After 一直白等。改成看 lastFailureKind 才能识别。
            if (this.pool.allAuthUnavailable()) throw new AuthExpiredError();
            throw new RateLimitError(
              `所有账号都在限流冷却中，约 ${Math.ceil(wait / 1000)}s 后恢复（可往号池加 token）`,
              { retryAfterMs: wait },
            );
          }
          await sleep(Math.max(0, wait), signal).catch(() => {});
          continue;
        }

        try {
          const result = await this.#run({
            account, prompt, thinking, search, refFileIds, signal, onDelta, onThinking, startedAt, meta,
          });
          this.pool.markHealthy(account);
          return result;
        } catch (err) {
          if (signal?.aborted) throw err;
          // 客户端断开 / 超时 / 参数问题：跟账号无关，直接抛
          if (!isAccountScopedFailure(err)) throw err;

          // 账号级失败：先停用当前号，再在同一个请求里换号重试。
          // 不能把失败抛回客户端等它重发——那样下一次轮询又会先撞回这个坏号。
          // 但如果这一轮已经把部分正文/思考流给客户端了，就不能换号重放（会重复），只能抛。
          const partialOutput = Boolean(err.partialOutput);
          let retryAfterMs;
          if (err instanceof RateLimitError) {
            retryAfterMs = Math.max(rateLimitBackoffMs, accountCooldownMs);
            this.pool.markLimited(account, retryAfterMs);
          } else if (err instanceof AuthExpiredError) {
            retryAfterMs = AUTH_INVALID_COOLDOWN_MS;
            this.pool.markUnavailable(account, retryAfterMs, '登录态失效', {
              authFailed: true,
              kind: 'auth',
            });
          } else {
            // 上游报错 / 人机验证 / 登录态问题：先标记这个号，免得下次请求又从它开始重撞一遍。
            //
            // 以前这里分叉：pool.size > 1 才标记，单 token 直接 throw 什么都不记 ——
            // 实测单 token 时 cooldownMs=0、errorCount=0、lastError=null、连一条 WARN 都没有，
            // 每次请求都真打一次上游，白付一次 session + PoW。
            //
            // 标记但不「锁死」：用一个很短的冷却（最多 1s），这样唯一的号不会被困住，
            // 又能把 lastError / errorCount 留下来，让调用方在 /healthz 和日志里看得见。
            retryAfterMs = Math.min(1000, Math.max(0, accountCooldownMs));
            this.pool.markUnavailable(account, retryAfterMs, err.message || '账号不可用');
            if (this.pool.size === 1) throw err;
          }

          if (partialOutput) throw err;
          if (attempt >= maxAttempts) throw err;
          // 池里还有别的号：立刻换，不等待
          if (this.pool.hasAvailable()) continue;

          // 其它号都在冷却：短时间内能恢复就等一下，否则直接抛
          const wait = this.pool.nextAvailableAt() - Date.now();
          if (this.pool.size > 1 && wait <= maxCooldownWaitMs) {
            await sleep(Math.max(0, wait), signal).catch(() => {});
            continue;
          }
          if (this.pool.size > 1) {
            if (this.pool.allAuthFailed()) throw new AuthExpiredError();
            if (err instanceof RateLimitError) {
              throw new RateLimitError('号池里的账号都被限流了，稍后重试或再加 token', {
                retryAfterMs: Math.max(1000, wait),
              });
            }
            throw err;
          }
          if (err instanceof RateLimitError) {
            throw new RateLimitError(err.message, { retryAfterMs: Math.max(1000, retryAfterMs) });
          }
          throw err;
        }
      }
      throw new RateLimitError('暂时没有可用账号');
    } finally {
      this.inflight -= 1;
    }
  }

  async #run({ account, prompt, thinking, search, refFileIds = [], signal, onDelta, onThinking, startedAt }) {
    const powStart = Date.now();
    // powHeader 必须是 let：40301 重试时要把它置空，逼下一轮重新 fetch+solve，
    // 否则会一直拿同一个失效 header 重试（历史 bug：日志里连续 3 次 INVALID_POW_RESPONSE）。
    let powHeader;
    const [sessionId, initialPowHeader] = await Promise.all([
      this.#takeSession(account, signal),
      this.#powHeader(account),
    ]);
    powHeader = initialPowHeader;
    const powMs = Date.now() - powStart;
    this.#prefetchPow(account);

    // 行为时序伪装：真浏览器不会「PoW 一解完就立刻发」。
    // 1) PoW 在 JS 里本就比 Go 慢，补足到合理区间；
    // 2) 发送前再加一点「输入停顿」。
    if (this.config.deepseek.humanTiming !== false) {
      const powPad = padPowDuration(powStart);
      if (powPad > 0) await sleep(powPad, signal);
      await sleep(typingDelay(), signal);
    }

    let powRetried = false;
    let apiRetries = 0;
    /** 空流重试次数：限流时接口经常只回一个空的 event: ready，先短等重试几次再判定为限流 */
    let emptyRetries = 0;
    for (;;) {

      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      // 总超时兜底：上游流迟迟不结束时（比如模型编造 RESULT 后无限续写），
      // 没有这个看门狗 for await 会一直挂着。客户端主动断开的语义不在这里处理。
      const timeoutMs = this.config.runtime.requestTimeoutMs;
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(new TimeoutError(`等待 DeepSeek 响应超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      timeoutTimer.unref?.();

      try {
        let header = powHeader;
        if (!header) {
          // 走到这里说明是 40301 重试：现场取一个新的 PoW。
          header = await this.#powHeader(account);
          // 重试消耗掉了之前预解的那个，顺手再预解一个给后续请求。
          this.#prefetchPow(account);
        }
        const res = await fetch(`${this.baseUrl}${COMPLETION_PATH}`, {
          method: 'POST',
          signal: controller.signal,
          headers: { ...this.#headers(account), 'x-ds-pow-response': header },
          body: JSON.stringify({
            chat_session_id: sessionId,
            parent_message_id: null,
            model_type: 'default',
            prompt,
            ref_file_ids: refFileIds,
            thinking_enabled: Boolean(thinking),
            search_enabled: Boolean(search),
            action: null,
            preempt: false,
          }),
        });

        const contentType = String(res.headers.get('content-type') || '');
        if (!contentType.includes('event-stream')) {
          const body = await readJsonSafely(res);
          const code = body?.code ?? body?.data?.biz_code;
          const message = body?.msg || body?.data?.biz_msg || `HTTP ${res.status}`;

          if ((code === 40301 || /POW/i.test(message)) && !powRetried) {
            // PoW 一次性 / 有过期时间：失败后必须换一个新的，不能复用旧 header。
            powRetried = true;
            powHeader = null;
            this.log.debug(`账号 #${account.index + 1} PoW 被拒（${message}），重新获取后重试一次`);
            continue;
          }
          if (res.status === 401 || res.status === 403 || isAuthInvalidMessage(message)) {
            throw new AuthExpiredError(message);
          }
          if (res.status === 429 || /频繁|rate/i.test(message)) throw new RateLimitError(message);

          // 网页接口返回错误：重试最多 3 次再抛错
          apiRetries += 1;
          if (apiRetries <= API_ERROR_MAX_RETRIES) {
            this.log.warn(
              `网页接口返回错误（第 ${apiRetries}/${API_ERROR_MAX_RETRIES} 次重试）：${message}`,
              { status: res.status, code },
            );
            if (API_ERROR_RETRY_DELAY_MS > 0) {
              await sleep(API_ERROR_RETRY_DELAY_MS, signal).catch(() => {});
            }
            continue;
          }
          throw new UpstreamError(`网页接口返回错误：${message}`, { code: 'api_error' });
        }

        const state = createStreamState();
        let emittedContent = '';
        let emittedReasoning = '';
        let firstTokenAt = 0;
        // 增量追踪器：正常追加时只 join 新增量，不拼全文（见 stream.mjs）。
        // 追踪器返回 null（片段被改写/回退）时回退到全文 join + 前缀校验。
        const contentTracker = createTextTracker();
        const reasoningTracker = createTextTracker();

        const emitOne = (tracker, type, emitted, onEmit) => {
          const delta = tracker(state.fragments, type);
          if (delta) {
            if (!firstTokenAt) firstTokenAt = Date.now();
            onEmit?.(delta);
            return emitted + delta;
          }
          if (delta === null) {
            const full = state.fragments
              .filter((f) => f?.type === type)
              .map((f) => f.content || '')
              .join('');
            if (full.length > emitted.length && full.startsWith(emitted)) {
              if (!firstTokenAt) firstTokenAt = Date.now();
              onEmit?.(full.slice(emitted.length));
              return full;
            }
          }
          return emitted;
        };

        const emit = () => {
          emittedContent = emitOne(contentTracker, 'RESPONSE', emittedContent, onDelta);
          emittedReasoning = emitOne(reasoningTracker, 'THINK', emittedReasoning, onThinking);
        };

        const parser = createSseParser((payload, event) => {
          // 限流 / 风控提示走 event: hint
          if (event === 'hint' && payload && payload.type === 'error') {
            const message = String(payload.content || '网页接口提示错误');
            if (payload.finish_reason === 'rate_limit_reached' || /频繁|休息/.test(message)) {
              throw new RateLimitError(message);
            }
            throw new UpstreamError(message, { code: 'upstream_hint' });
          }
          applyPatch(state, payload);
          emit();
        });

        const decoder = new TextDecoder();
        try {
          for await (const chunk of res.body) {
            if (signal?.aborted) {
              controller.abort();
              throw new UpstreamError('客户端已断开，已停止生成', { status: 499, code: 'client_closed' });
            }
            parser.push(decoder.decode(chunk, { stream: true }));
          }
        } catch (err) {
          if (signal?.aborted) {
            throw new UpstreamError('客户端已断开，已停止生成', { status: 499, code: 'client_closed' });
          }
          if (timedOut || err instanceof TimeoutError) {
            throw new TimeoutError(`等待 DeepSeek 响应超时（${Math.round(timeoutMs / 1000)}s）`);
          }
          // 已经流出一部分正文/思考：换号重放会让客户端看到重复内容，外层据此不再重试
          if (err && typeof err === 'object' && (emittedContent || emittedReasoning)) {
            err.partialOutput = true;
          }
          throw err;
        }
        parser.flush();
        emit();

        if (!emittedContent && !emittedReasoning) {
          // 被限流时接口常常只回一个空的 event: ready。先短等重试几次：
          // 不少空流只是瞬时抖动，直接抛 429 会让 agent 的工具调用轮次「丢流」失败。
          if (emptyRetries < 2) {
            emptyRetries += 1;
            powHeader = null; // PoW 是一次性的，重试前必须换新的
            const waitMs = 700 * emptyRetries;
            this.log.warn(
              `账号 #${account.index + 1} 收到空流，${waitMs}ms 后重试（${emptyRetries}/2）`,
            );
            await sleep(waitMs, signal).catch(() => {});
            continue;
          }
          throw new RateLimitError('网页接口没有返回内容（多半是消息发得太频繁，被限流）');
        }

        return {
          text: emittedContent,
          reasoning: emittedReasoning,
          streamed: emittedContent,
          streamedReasoning: emittedReasoning,
          elapsedMs: Date.now() - startedAt,
          timings: {
            account: account.index + 1,
            sessionAndPowMs: powMs,
            firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
            totalMs: Date.now() - startedAt,
          },
          usage: state.usage,
        };
      } finally {
        clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * 把图片传成 DeepSeek 的附件，返回 file id 列表（塞进 ref_file_ids）。
   * 按内容 hash 缓存 30 分钟，同一张图重复问不会重复上传。
   */
  async uploadImages(images = []) {
    if (!images.length) return [];
    await this.ensureStarted();
    const account = this.#uploadAccount();

    const ids = [];
    for (const image of images) {
      const buffer = image?.buffer;
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new ApiError(400, '图片内容为空', { code: 'invalid_image' });
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new ApiError(400, `图片过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 10MB`, {
          code: 'image_too_large',
        });
      }
      ids.push(
        await this.#uploadFile(account, {
          buffer,
          mime: image.mime || 'image/png',
          name: image.name || `image-${Date.now()}.png`,
        }),
      );
    }
    return ids;
  }

  /**
   * 通用附件上传：超长上下文拆出来的 .txt 走这里。
   * 和图片共用一套 hash 缓存，同样内容 30 分钟内不重复上传。
   */
  async uploadAttachments(files = []) {
    if (!files.length) return [];
    await this.ensureStarted();
    const account = this.#uploadAccount();

    const ids = [];
    for (const file of files) {
      const buffer = file?.buffer;
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new ApiError(400, '附件内容为空', { code: 'invalid_attachment' });
      }
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        throw new ApiError(400, `附件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 20MB`, {
          code: 'attachment_too_large',
        });
      }
      ids.push(
        await this.#uploadFile(account, {
          buffer,
          mime: file.mime || 'text/plain',
          name: file.name || `context-${Date.now()}.txt`,
        }),
      );
    }
    return ids;
  }

  #uploadAccount() {
    const account = this.pool.pick() || this.pool.accounts[0];
    if (!account) throw new AuthExpiredError();
    return account;
  }

  async #uploadFile(account, file) {
    const { buffer, mime, name } = file;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const cached = this.fileCache.get(hash);
    if (cached && cached.expiresAt > Date.now()) return cached.id;
    // 原来只在命中时检查过期：长期运行的进程里过期条目永远不删，
    // Map 会随上传次数无限增长。这里在写入前顺手清掉过期项并设上限。
    if (cached) this.fileCache.delete(hash);
    if (this.fileCache.size >= 512) {
      const now = Date.now();
      for (const [key, entry] of this.fileCache) {
        if (entry.expiresAt <= now) this.fileCache.delete(key);
      }
      if (this.fileCache.size >= 512) this.fileCache.delete(this.fileCache.keys().next().value);
    }

    const powHeader = await this.#powHeaderFor(account, UPLOAD_PATH);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), name);

    // 注意：multipart 不能手动带 content-type，否则 boundary 丢失
    const uploadHeaders = buildUploadHeaders({
      baseUrl: this.baseUrl,
      token: account.token,
      deviceId: account.deviceId,
      profileName: this.config.deepseek.deviceProfile || 'chrome-win',
      locale: 'zh_CN',
      timezoneOffsetSec: -new Date().getTimezoneOffset() * 60,
    });
    const res = await fetch(`${this.baseUrl}${UPLOAD_PATH}`, {
      method: 'POST',
      headers: { ...uploadHeaders, 'x-ds-pow-response': powHeader },
      body: form,
    });
    const body = await readJsonSafely(res);
    const id = body?.data?.biz_data?.id;
    if (!id) {
      const message = body?.msg || body?.data?.biz_msg || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403 || isAuthInvalidMessage(message)) {
        throw new AuthExpiredError(message);
      }
      if (res.status === 429 || /频繁/.test(message)) throw new RateLimitError(message);
      this.log.warn('上传附件失败', { name, message, status: res.status });
      throw new UpstreamError(`上传附件失败：${message}`, { code: 'attachment_upload_failed' });
    }

    this.fileCache.set(hash, { id, expiresAt: Date.now() + FILE_CACHE_TTL_MS });
    this.log.debug('附件已上传', { name, bytes: buffer.length });
    return id;
  }

  /* ------------------------------------------------------------------ *
   * 每账号的 PoW / 会话缓存
   * ------------------------------------------------------------------ */

  #headers(account) {
    return buildBrowserHeaders({
      baseUrl: this.baseUrl,
      token: account.token,
      deviceId: account.deviceId,
      profileName: this.config.deepseek.deviceProfile || 'chrome-win',
      locale: 'zh_CN',
      timezoneOffsetSec: -new Date().getTimezoneOffset() * 60,
    });
  }

  async #takeSession(account, signal) {
    const pooled = account.sessionPool.pop();
    const id = pooled || (await this.#createSession(account, signal));
    this.#prewarmSession(account); // 本轮生成期间就把下一轮会话建好
    return id;
  }

  #prewarmSession(account) {
    if (this.closed || account.sessionPool.length) return;
    setTimeout(() => {
      if (this.closed || account.sessionPool.length) return;
      this.#createSession(account)
        .then((id) => account.sessionPool.push(id))
        .catch(() => {});
    }, 0).unref?.();
  }

  async #createSession(account, signal) {
    const res = await fetch(`${this.baseUrl}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: this.#headers(account),
      body: '{}',
      signal,
    });
    const body = await readJsonSafely(res);
    const session = body?.data?.biz_data?.chat_session;
    if (!session?.id) {
      const message = body?.msg || body?.data?.biz_msg || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403 || isAuthInvalidMessage(message)) {
        throw new AuthExpiredError(message);
      }
      if (res.status === 429 || /频繁/.test(message)) throw new RateLimitError(message);
      throw new UpstreamError(`创建会话失败：${message}`, { code: 'session_failed' });
    }
    return session.id;
  }

  async #fetchChallenge(account, targetPath = COMPLETION_PATH) {
    const res = await fetch(`${this.baseUrl}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: this.#headers(account),
      body: JSON.stringify({ target_path: targetPath }),
    });
    const body = await readJsonSafely(res);
    const challenge = body?.data?.biz_data?.challenge;
    if (!challenge) {
      const message = body?.msg || body?.data?.biz_msg || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403 || isAuthInvalidMessage(message)) {
        throw new AuthExpiredError(message);
      }
      throw new UpstreamError(`获取 PoW 挑战失败：${message}`, { code: 'pow_challenge_failed' });
    }
    return challenge;
  }

  /**
   * PoW 是一次性的：取走就得重新解，所以在后台一直预解下一个。
   *
   * 预解结果带 expireAt：如果取用时剩余有效期不足 POW_EXPIRY_SAFETY_MS，
   * 说明 challenge 已过期/即将过期，服务端会拒收，直接丢弃并重新 fetch+solve。
   */
  async #powHeader(account) {
    const solved = await this.#takePow(account);
    if (powNotExpired(solved.expireAt)) return solved.header;
    this.log.debug(
      `账号 #${account.index + 1} 预解的 PoW 已过期（expire_at=${solved.expireAt}），重新获取`,
    );
    return (await this.#solveNew(account)).header;
  }

  /** 取走预解的 PoW；没有预解就现场解一个（两者都返回 { header, expireAt }）。 */
  #takePow(account) {
    if (account.powNext) {
      const pending = account.powNext;
      account.powNext = null;
      return pending;
    }
    return this.#solveNew(account);
  }

  #prefetchPow(account) {
    if (this.closed || account.powNext) return;
    account.powNext = this.#solveNew(account);
    account.powNext.catch(() => {
      account.powNext = null;
    });
  }

  async #powHeaderFor(account, targetPath) {
    const challenge = await this.#fetchChallenge(account, targetPath);
    const solved = await this.pow.solve({
      challenge: challenge.challenge,
      salt: challenge.salt,
      expireAt: challenge.expire_at,
      difficulty: challenge.difficulty,
    });
    return Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: solved.answer,
        signature: challenge.signature,
        target_path: challenge.target_path || targetPath,
      }),
    ).toString('base64');
  }

  async #solveNew(account) {
    const challenge = await this.#fetchChallenge(account);
    const solved = await this.pow.solve({
      challenge: challenge.challenge,
      salt: challenge.salt,
      expireAt: challenge.expire_at,
      difficulty: challenge.difficulty,
    });

    const header = Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: solved.answer,
        signature: challenge.signature,
        target_path: challenge.target_path || COMPLETION_PATH,
      }),
    ).toString('base64');

    this.log.debug(`账号 #${account.index + 1} PoW 已解`, { answer: solved.answer, ms: solved.ms });
    // expire_at 用于取用时判断是否已过期（见 #powHeader）；服务端字段缺失时为 undefined。
    return { header, expireAt: challenge.expire_at };
  }
}

async function readJsonSafely(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}