import crypto from 'node:crypto';

import { ApiError, AuthExpiredError, PromptTooLongError, RateLimitError, TimeoutError, UpstreamError } from '../errors.mjs';
import { sleep } from '../util.mjs';
import { AccountPool } from './account-pool.mjs';
import { AccountScheduler } from './scheduler.mjs';
import {
  buildBrowserHeaders,
  buildUploadHeaders,
  padPowDuration,
  runColdStartSequence,
  typingDelay,
} from './fingerprint.mjs';
import { PowSolver } from './pow.mjs';
import { applyPatch, createSseParser, createStreamState } from './stream.mjs';

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
 * 上游「账号被禁言」：实测 2026-11-05 登录态有效但网页接口返回
 * HTTP 502 / message="user is muted"。这是账号级风控，不是凭据失效：
 * 重新登录 / 重开浏览器都不会恢复，反而会浪费登录态，所以按限流冷却处理。
 *
 * 默认 15 分钟（实测 00:30 禁言后，00:45 仍禁言；10 分钟会过早探测）。
 * 运行期可用 MUTED_COOLDOWN_MS 覆盖。
 */
export const MUTED_COOLDOWN_MS = 15 * 60_000;

export function isMutedMessage(message) {
  return /user\s+is\s+muted|账号.{0,8}禁言|账户.{0,8}禁言/i.test(String(message || ''));
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

    this.pool = new AccountPool({
      tokens: this.tokens,
      dataDir: config.dataDir,
      logger,
      deviceIds: config.deepseek.deviceIds || {},
    });
    this.pow = new PowSolver({ bin: config.direct.powBin, logger });
    // 账号级调度：单账号 FIFO + 单飞，不同账号并行；单账号最小请求间隔见 ACCOUNT_MIN_GAP_MS
    this.scheduler = new AccountScheduler({
      pool: this.pool,
      logger,
      minGapMs: config.runtime.accountMinGapMs,
      // 工具轮独立间隔：本次请求带 tools 时排队用这个值（默认 15000ms）
      toolMinGapMs: config.runtime.toolMinGapMs,
    });
    this.fileCache = new Map();
    this.inflight = 0;
    this.closed = false;
    this.coldStarted = false;
    // 会话复用统计（/healthz 与报告用；只输出会话 id 的哈希前缀）
    this.sessionsCreated = 0;
    this.sessionsReused = 0;
    this.sessionsRebuilt = 0;
    this.lastSession = null;
    // 上游 /api/v0/* 调用计数与最近一次补全的请求头名（只记名字，不记值）
    this.apiCalls = { createSession: 0, powChallenge: 0, completion: 0, uploadFile: 0 };
    this.lastHeaderNames = null;
    this.lastParentUsedHash = null;
  }

  /* ------------------------------------------------------------------ */

  async ensureStarted() {
    if (!this.tokens.length) {
      throw new AuthExpiredError(
        '还没有配置 DeepSeek 的 userToken：执行 `npm run auth -- <userToken>`，或设置 DEEPSEEK_USER_TOKEN',
      );
    }
  }

  /** 预热：第一个账号提前解好 PoW，并跑一次冷启动序列（不再预建会话） */
  async warmUp() {
    await this.ensureStarted();
    const account = this.pool.accounts[0];
    if (!account) return;
    this.#prefetchPow(account);
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
    const scheduled = this.scheduler.stats();
    const accounts = this.pool.status().map((account, index) => {
      const s = scheduled[index] || {};
      // scheduler.available 只代表“没在冷却”；能否派发还要看凭据状态
      const dispatchable = s.available !== false && account.dispatchable;
      return { ...account, ...s, available: dispatchable, dispatchable };
    });
    const states = accounts.map((a) => a.credentialState);
    const dispatchableCount = accounts.filter((a) => a.dispatchable).length;
    return {
      engine: 'direct',
      browser: false,
      pages: 0,
      busy: this.inflight,
      queued: scheduled.reduce((sum, item) => sum + item.queued, 0),
      token: this.tokens.length > 0,
      credentialState: accounts.length === 0 ? 'unknown' : dispatchableCount > 0 ? (states.includes('stale') ? 'stale' : 'valid') : states[0],
      nextAction: dispatchableCount > 0 ? null : accounts.length === 0 || states.some((s) => s === 'invalid' || s === 'anonymous') ? 're-login' : 'wait-cooldown',
      // 每个账号的 in-flight / 队列长度 / 冷却状态（只给哈希前缀）
      accounts,
      scheduler: scheduled,
      ...this.sessionStatus(),
    };
  }

  /**
   * 预测这次请求会落在哪个账号（用于网页会话的「按账号命名空间」）。
   * 只读，不消耗轮询游标，也不发任何请求。
   */
  planAccount(preferredFingerprint = null) {
    const now = Date.now();
    const preferred = preferredFingerprint
      ? this.pool.accounts.find((account) => account.fingerprint === preferredFingerprint)
      : null;
    if (preferred) {
      return {
        fingerprint: preferred.fingerprint,
        index: preferred.index + 1,
        sticky: true,
        available: preferred.cooldownUntil <= now,
        cooldownMs: Math.max(0, preferred.cooldownUntil - now),
      };
    }
    const picked = this.pool.peek(now, (account) => this.scheduler.load(account));
    if (!picked) return null;
    return {
      fingerprint: picked.fingerprint,
      index: picked.index + 1,
      sticky: false,
      available: true,
      cooldownMs: 0,
    };
  }

  /** 本引擎（单账号）的可用性/负载快照，供上层多账号路由使用（只读） */
  describeAccount() {
    const account = this.pool.accounts[0];
    if (!account) return { available: false, cooldownMs: 0, load: 0, fingerprint: null };
    const now = Date.now();
    return {
      fingerprint: account.fingerprint,
      available: account.cooldownUntil <= now,
      cooldownMs: Math.max(0, account.cooldownUntil - now),
      load: this.scheduler.load(account),
    };
  }

  /** 会话复用的对外状态（绝不输出原始 chat_session_id / parent_message_id） */
  sessionStatus() {
    return {
      sessionReused: Boolean(this.lastSession?.reused),
      webSessionHash: this.lastSession?.webSessionHash ?? null,
      parentHash: this.lastSession?.parentHash ?? null,
      sessionCreates: this.sessionsCreated,
      sessionReuses: this.sessionsReused,
      sessionRebuilds: this.sessionsRebuilt,
      lastSessionReason: this.lastSession?.reason ?? null,
      apiCalls: { ...this.apiCalls },
      lastHeaderNames: this.lastHeaderNames,
      // 本轮实际使用的 parent_message_id 哈希（用来核对 parent 链是否连续）
      parentUsedHash: this.lastParentUsedHash,
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

  async chat({
    prompt,
    thinking = false,
    search = false,
    refFileIds = [],
    // 工具轮标记：由 chat-runner 透传本次请求的 tools；带 tools 时排队用 toolMinGapMs
    tools = [],
    signal,
    onDelta,
    onThinking,
    meta = {},
    session = null,
  }) {
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
        // 复用会话时优先用会话所属账号；账号被换掉会让 parent 链失效，只能重建
        const account = this.#pickAccount(now, session?.accountFingerprint);
        if (!account) {
          const wait = this.pool.nextAvailableAt() - now;
          if (wait > maxCooldownWaitMs) {
            // 所有号都是登录态失效停用的：报登录态错误，别让调用方误以为是限流
            if (this.pool.allAuthFailed()) throw new AuthExpiredError();
            throw new RateLimitError(
              `所有账号都在限流冷却中，约 ${Math.ceil(wait / 1000)}s 后恢复（可往号池加 token）`,
              { retryAfterMs: wait },
            );
          }
          await sleep(Math.max(0, wait), signal).catch(() => {});
          continue;
        }

        try {
          // 工具轮（带 tools）与长上下文轮（带 ref_file_ids）都按更保守的工具轮间隔排队
          const toolRound = (Array.isArray(tools) && tools.length > 0)
            || (Array.isArray(refFileIds) && refFileIds.length > 0);
          const result = await this.scheduler.run(
            account,
            () => this.#run({
              account, prompt, thinking, search, refFileIds, signal, onDelta, onThinking, startedAt, meta, session,
            }),
            {
              signal,
              minGapMs: toolRound ? this.scheduler.toolMinGapMs : undefined,
            },
          );
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
            // 上游给的 retryAfterMs（禁言 10 分钟）必须生效，否则会每分钟重试一次、加重风控
            retryAfterMs = Math.max(err.retryAfterMs ?? 0, rateLimitBackoffMs, accountCooldownMs);
            this.pool.markLimited(account, retryAfterMs);
          } else if (err instanceof AuthExpiredError) {
            retryAfterMs = AUTH_INVALID_COOLDOWN_MS;
            const authErrorCode = err.code
              || (String(err.message || '').includes('INVALID_TOKEN') ? 'INVALID_TOKEN' : 'auth_failed');
            this.pool.markUnavailable(account, retryAfterMs, '登录态失效', { authFailed: true, authErrorCode });
          } else if (this.pool.size > 1) {
            // 上游报错/人机验证：有别的号就轮换，没有别的号就别把自己锁死
            retryAfterMs = Math.max(1000, accountCooldownMs);
            this.pool.markUnavailable(account, retryAfterMs, err.message || '账号不可用');
          } else {
            throw err;
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

  async #run({
    account,
    prompt,
    thinking,
    search,
    refFileIds = [],
    signal,
    onDelta,
    onThinking,
    startedAt,
    session = null,
  }) {
    const powStart = Date.now();
    // powHeader 必须是 let：40301 重试时要把它置空，逼下一轮重新 fetch+solve，
    // 否则会一直拿同一个失效 header 重试（历史 bug：日志里连续 3 次 INVALID_POW_RESPONSE）。
    let powHeader;

    /* --- 会话：能复用就复用；否则只建这一次（不再预建下一个会话） --- */
    let chatSessionId = session?.chatSessionId || null;
    let parentMessageId = session?.parentMessageId || null;
    let activePrompt = prompt;
    let activeFileIds = refFileIds;
    let sessionReused = Boolean(chatSessionId);
    let sessionCreated = false;
    let sessionRebuilt = false;

    /** 这个请求里第一次真正需要新会话时才会调用；会话复用路径下 create 次数 = 1 */
    const ensureSession = async () => {
      if (chatSessionId) return;
      chatSessionId = await this.#createSession(account, signal);
      this.sessionsCreated += 1;
      sessionCreated = true;
    };

    /** 会话失效 / 账号漂移时，调用方提供的「全量 prompt」用于重建（只重建一次） */
    const rebuild = async (reason) => {
      if (sessionRebuilt) return false;
      if (typeof session?.rebuild !== 'function') {
        throw new UpstreamError('会话需要重建，但调用方没有提供全量 prompt', { code: 'session_rebuild_unavailable' });
      }
      const full = await session.rebuild({ signal });
      sessionRebuilt = true;
      this.sessionsRebuilt += 1;
      activePrompt = full.prompt;
      activeFileIds = full.refFileIds ?? [];
      parentMessageId = null;
      chatSessionId = null;
      sessionReused = false;
      await ensureSession();
      this.log.warn('复用会话不可用，已用全量 prompt 重建一次', {
        reason,
        session: hashPrefix(session?.chatSessionId),
        account: account.index + 1,
      });
      return true;
    };

    // 账号被换掉时，原会话的 parent 链在新 token 下无效：先用全量 prompt 重建
    let rebuildReason = null;
    if (chatSessionId && session?.accountFingerprint && session.accountFingerprint !== account.fingerprint) {
      rebuildReason = 'account-changed';
    }

    if (rebuildReason) {
      await rebuild(rebuildReason);
    } else {
      await ensureSession();
      if (sessionReused) this.sessionsReused += 1;
    }

    const initialPowHeader = await this.#powHeader(account);
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
        const requestHeaders = {
          ...this.#headers(account),
          'x-ds-pow-response': header,
          // 线上补全请求的 Referer 是具体会话页（/a/chat/s/<session>），不是站点根路径
          // 复用时同一个会话 id → Referer 恒定，不会出现「每次都是新会话」的痕迹
          referer: `${this.baseUrl}/a/chat/s/${chatSessionId}`,
        };
        // 只记录头名（报告里做「新建 vs 复用」的头级对比，不落任何值）
        this.lastHeaderNames = Object.keys(requestHeaders).sort();
        this.lastParentUsedHash = hashPrefix(parentMessageId);
        this.apiCalls.completion += 1;
        const res = await fetch(`${this.baseUrl}${COMPLETION_PATH}`, {
          method: 'POST',
          signal: controller.signal,
          headers: requestHeaders,
          body: JSON.stringify({
            chat_session_id: chatSessionId,
            // 复用会话：挂在上一轮 assistant 消息下面；新会话 / 重建时为 null
            parent_message_id: parentMessageId,
            model_type: 'default',
            prompt: activePrompt,
            ref_file_ids: activeFileIds,
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
          if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
          // 禁言是账号级风控：既不重试（重试只会加重风控），也不当成凭据失效
          if (isMutedMessage(message)) {
            throw new RateLimitError(
              `DeepSeek 上游提示账号被禁言（${message}）：这是账号级风控，不是登录态失效，重新登录/重开浏览器无效`,
              { retryAfterMs: this.config.runtime.mutedCooldownMs },
            );
          }
          if (res.status === 429 || /频繁|rate/i.test(message)) throw new RateLimitError(message);

          // 复用的会话被上游判为失效（会话不存在 / 不属于当前账号 / 已过期）：
          // 用全量 prompt 重建一次；重试需要新的 PoW（旧的那次已经被这次失败消耗）。
          // 说明：上游对「会话不存在/不属于该账号」有时只回一个没有 msg/code 的 4xx
          // （实测 422 body 里的信息不足以判定），所以复用路径上把这些状态也当作会话失效。
          // 只会重建一次；若重建后仍失败，会按普通上游错误显式抛出，不静默吞掉。
          const statusSuggestsSession = res.status === 400 || res.status === 404
            || res.status === 410 || res.status === 422;
          if (sessionReused && !sessionRebuilt
            && (looksLikeInvalidSession(message, code, res.status) || statusSuggestsSession)) {
            const reason = `invalid-session: HTTP ${res.status} ${String(message).slice(0, 100)}`;
            powHeader = null;
            await rebuild(reason);
            continue;
          }

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

        const emit = () => {
          const content = state.fragments
            .filter((f) => f?.type === 'RESPONSE')
            .map((f) => f.content || '')
            .join('');
          if (content.length > emittedContent.length && content.startsWith(emittedContent)) {
            if (!firstTokenAt) firstTokenAt = Date.now();
            onDelta?.(content.slice(emittedContent.length));
            emittedContent = content;
          }
          const reasoning = state.fragments
            .filter((f) => f?.type === 'THINK')
            .map((f) => f.content || '')
            .join('');
          if (reasoning.length > emittedReasoning.length && reasoning.startsWith(emittedReasoning)) {
            if (!firstTokenAt) firstTokenAt = Date.now();
            onThinking?.(reasoning.slice(emittedReasoning.length));
            emittedReasoning = reasoning;
          }
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

        // 会话链信息：调用方据此把「本轮 assistant message id」作为下一轮的 parent
        this.lastSession = {
          webSessionHash: hashPrefix(chatSessionId),
          parentHash: hashPrefix(state.messageId),
          reused: Boolean(sessionReused),
          created: Boolean(sessionCreated),
          rebuilt: Boolean(sessionRebuilt),
          reason: sessionRebuilt ? 'rebuild' : sessionReused ? 'append' : 'new',
        };

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
          // 会话复用：返回会话与消息 id（只给内部用，日志/接口只输出哈希前缀）
          chatSessionId,
          messageId: state.messageId || null,
          accountFingerprint: account.fingerprint || null,
          sessionReused,
          sessionCreated,
          sessionRebuilt,
          sessionRebuildReason: sessionRebuilt ? 'rebuild' : null,
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
    const picked = this.pool.pick(Date.now(), (account) => this.scheduler.load(account))
      || this.pool.accounts[0];
    if (!picked) throw new AuthExpiredError();
    return picked;
  }

  async #uploadFile(account, file) {
    // 上传也是打同一个账号的上游：必须进同一队列，不能和补全请求重叠。
    // 附件属于长任务链路，按工具轮间隔排队（普通对话的图片上传同样更保守，无害）。
    return this.scheduler.run(account, () => this.#uploadFileNow(account, file), {
      minGapMs: this.scheduler.toolMinGapMs,
    });
  }

  async #uploadFileNow(account, file) {
    const { buffer, mime, name } = file;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const cached = this.fileCache.get(hash);
    if (cached && cached.expiresAt > Date.now()) return cached.id;

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
    this.apiCalls.uploadFile += 1;
    const res = await fetch(`${this.baseUrl}${UPLOAD_PATH}`, {
      method: 'POST',
      headers: { ...uploadHeaders, 'x-ds-pow-response': powHeader },
      body: form,
    });
    const body = await readJsonSafely(res);
    const id = body?.data?.biz_data?.id;
    if (!id) {
      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      const message = body?.msg || body?.data?.biz_msg || `HTTP ${res.status}`;
      if (isMutedMessage(message)) {
        throw new RateLimitError(`上游提示账号被禁言（${message}）：账号级风控，稍后重试`, {
          retryAfterMs: this.config.runtime.mutedCooldownMs,
        });
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
      extra: this.config.deepseek.protocolExtras || {},
    });
  }

  /** 复用会话时优先选会话所属账号；拿不到（被停用/换 token）就走正常轮询并触发重建 */
  #pickAccount(now, preferredFingerprint) {
    if (preferredFingerprint) {
      const preferred = this.pool.accounts.find((a) => a.fingerprint === preferredFingerprint);
      if (preferred) {
        if (preferred.cooldownUntil > now) return null;
        preferred.lastUsedAt = now;
        preferred.requests += 1;
        return preferred;
      }
    }
    return this.pool.pick(now, (account) => this.scheduler.load(account));
  }

  async #createSession(account, signal) {
    this.apiCalls.createSession += 1;
    const res = await fetch(`${this.baseUrl}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: this.#headers(account),
      body: '{}',
      signal,
    });
    const body = await readJsonSafely(res);
    const session = body?.data?.biz_data?.chat_session;
    if (!session?.id) {
      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      const message = body?.msg || body?.data?.biz_msg || `HTTP ${res.status}`;
      if (isMutedMessage(message)) {
        throw new RateLimitError(`上游提示账号被禁言（${message}）：账号级风控，稍后重试`, {
          retryAfterMs: this.config.runtime.mutedCooldownMs,
        });
      }
      if (res.status === 429 || /频繁/.test(message)) throw new RateLimitError(message);
      throw new UpstreamError(`创建会话失败：${message}`, { code: 'session_failed' });
    }
    return session.id;
  }

  async #fetchChallenge(account, targetPath = COMPLETION_PATH) {
    this.apiCalls.powChallenge += 1;
    const res = await fetch(`${this.baseUrl}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: this.#headers(account),
      body: JSON.stringify({ target_path: targetPath }),
    });
    const body = await readJsonSafely(res);
    const challenge = body?.data?.biz_data?.challenge;
    if (!challenge) {
      if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
      throw new UpstreamError(
        `获取 PoW 挑战失败：${body?.msg || body?.data?.biz_msg || `HTTP ${res.status}`}`,
        { code: 'pow_challenge_failed' },
      );
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

/**
 * 上游错误是否指向「复用的会话不可用」。
 * 只在复用路径里判定；401/403/429 已在调用前单独处理，不会走到这里。
 */
export function looksLikeInvalidSession(message, code, status) {
  const text = `${message || ''} ${code || ''}`;
  if (status === 404 || status === 410) return true;
  return [
    /session.{0,24}(not.{0,8}(exist|found)|invalid|expired|deleted|unavailable)/i,
    /(会话|对话).{0,12}(不存在|无效|失效|已过期|已删除|找不到)/,
    /chat_session_id.{0,24}(invalid|not.{0,8}(exist|found)|error)/i,
  ].some((re) => re.test(text));
}

/** 会话 id / 消息 id 的哈希前缀（日志与 /healthz 只暴露这个） */
export function hashPrefix(id, len = 12) {
  if (!id) return null;
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, len);
}

async function readJsonSafely(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}