import crypto from 'node:crypto';
import fs from 'node:fs';

import { chromium } from 'playwright';

import {
  ApiError,
  AuthExpiredError,
  CaptchaError,
  PromptTooLongError,
  RateLimitError,
  TimeoutError,
  UpstreamError,
} from '../errors.mjs';
import { PowSolver } from '../direct/pow.mjs';
import { applyPatch, createSseParser, createStreamState } from '../direct/stream.mjs';

const COMPLETION_PATH = '/api/v0/chat/completion';
const SESSION_PATH = '/api/v0/chat_session/create';
const CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge';
const UPLOAD_PATH = '/api/v0/file/upload_file';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const FILE_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

/**
 * light 引擎：把真正发请求的动作交给浏览器，但不驱动页面 UI。
 *
 * 和 browser 引擎的区别：
 *   browser：模拟点击、轮询 DOM 取文本（慢、受页面改版影响）
 *   light  ：在页面上下文里用 fetch() 调上游接口，SSE chunk 通过
 *            page.exposeFunction 回传 Node，复用 direct 的 applyPatch 渲染。
 *
 * 因为请求由页面自己发出，TLS/JA3、HTTP/2 帧、请求头顺序、cookie 都由
 * 浏览器网络栈维护；Node 侧只补 PoW（bin/ds-pow）和业务逻辑。
 *
 * 登录态来源（优先级）：
 *   1. LIGHT_PROFILE_DIR  → chromium.launchPersistentContext（可配 LIGHT_STORAGE_STATE 注入）
 *   2. LIGHT_CDP_URL      → connectOverCDP 复用已经登录的浏览器
 *   3. 默认尝试 http://127.0.0.1:9222（本机常见远程调试端口）
 */
export class LightEngine {
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger;
    this.baseUrl = config.deepseek.baseUrl.replace(/\/+$/, '');
    this.pow = new PowSolver({ bin: config.direct.powBin, logger });

    this.browser = null;
    this.context = null;
    this.page = null;
    this.ownsPage = false;
    this.persistent = false;
    this.launching = null;
    this.closed = false;
    this.inflight = 0;
    this.bindings = new WeakSet();
    this.calls = new Map();
    this.callSeq = 0;
    this.fileCache = new Map();
    /** 最近一次 completion 的脱敏请求指纹（只有头名/是否存在，没有值） */
    this.lastTrace = null;
    /** CDP requestWillBeSentExtraInfo 记录的原始头顺序（只有头名） */
    this.lastRequestOrder = null;
    this.lastRequestOrderSource = null;
    /** 最近一次 403/风控/验证码的脱敏证据 */
    this.lastEvidence = null;
    this.identityCache = null;
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  async ensureStarted() {
    if (this.closed) throw new UpstreamError('服务正在关闭');
    if (this.page && !this.page.isClosed()) return;
    if (this.launching) return this.launching;
    this.launching = this.#launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  async #launch() {
    const light = this.config.light || {};
    const profileDir = light.profileDir;
    const cdpUrl = light.cdpUrl || DEFAULT_CDP_URL;

    if (profileDir) {
      await this.#launchPersistent(profileDir, light);
    } else {
      await this.#connectCdp(cdpUrl);
    }

    const page = this.#findPage() || (await this.#openPage());
    this.page = page;
    await this.#bindPage(page);

    const identity = await this.#identity();
    this.identityCache = identity;
    if (!identity.signedIn) {
      throw new AuthExpiredError(
        'light 引擎：浏览器里没有 userToken。请先在同一浏览器（CDP 端口或 LIGHT_PROFILE_DIR）登录 https://chat.deepseek.com',
      );
    }
    this.log.info('light 引擎已就绪', {
      transport: profileDir ? 'persistent-profile' : 'cdp',
      deviceId: Boolean(identity.deviceId),
      hifLeim: Boolean(identity.hifLeim),
      hifDliq: Boolean(identity.hifDliq),
    });
  }

  async #launchPersistent(profileDir, light) {
    fs.mkdirSync(profileDir, { recursive: true });
    const state = light.storageState;
    if (state && !fs.existsSync(state)) {
      throw new UpstreamError(`LIGHT_STORAGE_STATE 指向的文件不存在：${state}`);
    }
    this.log.info('启动持久化 Chromium（light）…', {
      profileDir,
      headless: light.headless,
      storageState: Boolean(state),
    });
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: light.headless,
      executablePath: light.executablePath || undefined,
      storageState: state || undefined,
      viewport: this.config.browser.viewport,
      locale: this.config.browser.locale,
      timezoneId: process.env.TZ || 'Asia/Shanghai',
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    this.persistent = true;
  }

  async #connectCdp(cdpUrl) {
    this.log.info('连接已登录浏览器（light）…', { cdpUrl });
    this.browser = await chromium.connectOverCDP(cdpUrl);
    this.browser.on('disconnected', () => {
      this.log.warn('light：浏览器连接已断开');
      this.page = null;
    });
    this.context = this.browser.contexts()[0] || (await this.browser.newContext());
    // 复用 CDP 时不改窗口大小、不改 UA：保持真实浏览器原样
  }

  #findPage() {
    const pages = this.context?.pages?.() || [];
    return pages.find((p) => !p.isClosed() && /chat\.deepseek\.com/.test(p.url())) || null;
  }

  async #openPage() {
    if (!this.context) throw new UpstreamError('light：没有可用的浏览器上下文');
    const page = await this.context.newPage();
    this.ownsPage = true;
    page.setDefaultTimeout(30_000);
    await page.goto(`${this.baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.light.navigationTimeoutMs,
    });
    return page;
  }

  async #bindPage(page) {
    if (this.bindings.has(page)) return;
    this.bindings.add(page);

    // 页面 SDK 只做「在浏览器里读登录态 + 发 fetch」，不碰 DOM、不点按钮
    await page.evaluate(installLightSdk);
    await page.exposeFunction('__LIGHT_CHUNK__', (callId, text, done) => this.#onChunk(callId, text, done));
    page.on('response', (res) => {
      if (!res.url().includes(COMPLETION_PATH)) return;
      Promise.resolve(res.request().allHeaders())
        .then((headers) => this.#recordTrace(res, headers))
        .catch(() => {});
    });

    // 用 CDP 记录「线上原始头顺序」：requestWillBeSentExtraInfo 的 headers 对象保留发送顺序
    try {
      const cdp = await page.context().newCDPSession(page);
      const urls = new Map();
      cdp.on('Network.requestWillBeSent', (event) => urls.set(event.requestId, event.request.url));
      cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
        const url = urls.get(event.requestId) || '';
        if (!url.includes(COMPLETION_PATH)) return;
        const order = Object.keys(event.headers || {});
        if (order.length) {
          this.lastRequestOrder = order;
          this.lastRequestOrderSource = 'Network.requestWillBeSentExtraInfo';
        }
        urls.delete(event.requestId);
      });
      await cdp.send('Network.enable');
    } catch (err) {
      this.log.debug('light：CDP 头顺序采集不可用（不影响请求）', { message: err.message });
    }
  }

  /** 请求指纹证据：只记录头名与是否存在，绝不记录头值 */
  #recordTrace(res, headers) {
    const cookieHeader = headers.cookie || '';
    const cookieNames = cookieHeader
      ? cookieHeader
          .split(';')
          .map((part) => part.trim().split('=')[0])
          .filter(Boolean)
      : [];
    const presence = {};
    for (const name of [
      'cookie',
      'authorization',
      'accept',
      'accept-encoding',
      'accept-language',
      'sec-fetch-site',
      'sec-fetch-mode',
      'sec-fetch-dest',
      'priority',
      'dnt',
      'origin',
      'referer',
      'x-client-version',
      'x-client-bundle-id',
      'x-device-id',
      'x-device-model',
      'x-ds-pow-response',
      'x-hif-leim',
      'x-hif-dliq',
    ]) {
      presence[name] = Boolean(headers[name]);
    }
    const ua = headers['user-agent'] || '';
    const chromeVersion = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || null;
    this.lastTrace = {
      url: res.url(),
      status: res.status(),
      headerNames: Object.keys(headers),
      headerCount: Object.keys(headers).length,
      rawOrder: this.lastRequestOrder || null,
      rawOrderSource: this.lastRequestOrderSource || null,
      presence,
      cookieNames,
      chromeVersion,
      userAgent: ua,
    };
    this.log.info('light 请求指纹（脱敏）', {
      status: res.status(),
      headerCount: this.lastTrace.headerCount,
      chromeVersion,
      cookie: presence.cookie,
      cookieNames,
      'sec-fetch-site': presence['sec-fetch-site'],
      priority: presence.priority,
      'x-ds-pow-response': presence['x-ds-pow-response'],
      'x-hif-leim': presence['x-hif-leim'],
      'x-hif-dliq': presence['x-hif-dliq'],
    });
  }

  async #identity() {
    const id = await this.page.evaluate(() => window.__LIGHT_SDK__.identity());
    this.identityCache = id;
    return id;
  }

  async warmUp() {
    await this.ensureStarted();
    const identity = await this.#identity();
    this.log.debug('light 预热完成', {
      signedIn: identity.signedIn,
      hifLeim: Boolean(identity.hifLeim),
      hifDliq: Boolean(identity.hifDliq),
    });
  }

  status() {
    return {
      engine: 'light',
      browser: Boolean(this.browser?.isConnected?.() ?? this.context),
      pages: this.page && !this.page.isClosed() ? 1 : 0,
      busy: this.inflight,
      queued: 0,
      token: Boolean(this.identityCache?.signedIn),
      transport: this.persistent ? 'persistent-profile' : 'cdp',
    };
  }

  async close() {
    this.closed = true;
    this.calls.clear();
    if (this.page && this.ownsPage) await this.page.close().catch(() => {});
    this.page = null;
    if (this.persistent) await this.context?.close().catch(() => {});
    // connectOverCDP：close 只断开连接，不会关掉用户正在用的浏览器
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
    this.pow.close();
  }

  /* ------------------------------------------------------------------ *
   * 对话
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
    try {
      const sessionId = await this.#createSession();
      let powHeader = await this.#powHeader(COMPLETION_PATH);
      let powRetried = false;

      const requestBody = {
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: 'default',
        prompt,
        ref_file_ids: refFileIds,
        thinking_enabled: Boolean(thinking),
        search_enabled: Boolean(search),
        action: null,
        preempt: false,
      };

      for (;;) {
        if (signal?.aborted) throw new UpstreamError('客户端已断开', { status: 499, code: 'client_closed' });

        const callId = `c${(this.callSeq += 1)}`;
        const call = this.#openCall(callId, { onDelta, onThinking });
        const callStart = Date.now();
        let timedOut = false;
        const timeoutMs = this.config.runtime.requestTimeoutMs;
        const timer = setTimeout(() => {
          timedOut = true;
          this.#abortCall(callId);
        }, timeoutMs);
        timer.unref?.();

        const onAbort = () => this.#abortCall(callId);
        signal?.addEventListener('abort', onAbort, { once: true });

        let res;
        try {
          res = await this.page.evaluate(
            (payload) =>
              window.__LIGHT_SDK__.stream(
                payload.callId,
                payload.path,
                payload.body,
                payload.headers,
                payload.referrer,
              ),
            {
              callId,
              path: COMPLETION_PATH,
              body: JSON.stringify(requestBody),
              headers: { 'x-ds-pow-response': powHeader },
              referrer: `${this.baseUrl}/a/chat/s/${sessionId}`,
            },
          );
        } catch (err) {
          if (call.error) throw call.error;
          if (signal?.aborted) {
            throw new UpstreamError('客户端已断开，已停止生成', { status: 499, code: 'client_closed' });
          }
          if (timedOut) throw new TimeoutError(`等待 DeepSeek 响应超时（${Math.round(timeoutMs / 1000)}s）`);
          throw new UpstreamError(`light 页面执行失败：${err.message}`, { code: 'light_page_failed' });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.calls.delete(callId);
        }

        if (call.error) throw call.error;
        if (signal?.aborted) {
          throw new UpstreamError('客户端已断开，已停止生成', { status: 499, code: 'client_closed' });
        }
        if (timedOut || res?.aborted) {
          throw new TimeoutError(`等待 DeepSeek 响应超时（${Math.round(timeoutMs / 1000)}s）`);
        }
        if (res?.ok && res?.streamed) {
          if (!call.emittedContent && !call.emittedReasoning) {
            throw new RateLimitError('light：网页接口没有返回内容（多半是消息发得太频繁，被限流）');
          }
          return {
            text: call.emittedContent,
            reasoning: call.emittedReasoning,
            streamed: call.emittedContent,
            streamedReasoning: call.emittedReasoning,
            elapsedMs: Date.now() - startedAt,
            timings: {
              sessionAndPowMs: callStart - startedAt,
              firstTokenMs: call.firstTokenAt ? call.firstTokenAt - startedAt : null,
              totalMs: Date.now() - startedAt,
            },
            usage: call.state.usage,
          };
        }

        // 非 SSE 响应：按直连引擎同样的语义分类
        const contentType = String(res?.contentType || '');
        const text = String(res?.text || '');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* 非 JSON（WAF 页面等） */
        }
        const code = parsed?.code ?? parsed?.data?.biz_code;
        const message = parsed?.msg || parsed?.data?.biz_msg || `HTTP ${res?.status ?? 0}`;

        if ((code === 40301 || /POW/i.test(message)) && !powRetried) {
          powRetried = true;
          this.log.debug('light：PoW 被拒（40301），重新取 challenge 后重试一次');
          powHeader = await this.#powHeader(COMPLETION_PATH);
          continue;
        }

        if (res?.status === 403 || res?.status === 401) {
          this.#recordEvidence({ step: 'completion', status: res.status, contentType, message, text });
          if (res.status === 403 && (/text\/html/i.test(contentType) || /验证|风控|captcha|challenge/i.test(text))) {
            throw new CaptchaError('DeepSeek 返回了风控/验证码页面（light），已停止且不再重试');
          }
          throw new AuthExpiredError('light：登录态被上游拒绝（401/403），请在浏览器里重新登录');
        }
        if (res?.status === 429 || /频繁|rate limit/i.test(message)) {
          this.#recordEvidence({ step: 'completion', status: res?.status ?? 0, contentType, message, text });
          throw new RateLimitError(message);
        }

        this.#recordEvidence({ step: 'completion', status: res?.status ?? 0, contentType, message, text });
        throw new UpstreamError(`light 传输返回错误：${message}`, { code: 'api_error' });
      }
    } finally {
      this.inflight -= 1;
    }
  }

  #openCall(callId, { onDelta, onThinking } = {}) {
    const state = createStreamState();
    const call = {
      state,
      emittedContent: '',
      emittedReasoning: '',
      firstTokenAt: 0,
      error: null,
      parser: null,
      onDelta,
      onThinking,
    };
    call.emit = () => {
      const content = state.fragments
        .filter((f) => f?.type === 'RESPONSE')
        .map((f) => f.content || '')
        .join('');
      if (content.length > call.emittedContent.length && content.startsWith(call.emittedContent)) {
        if (!call.firstTokenAt) call.firstTokenAt = Date.now();
        const delta = content.slice(call.emittedContent.length);
        call.emittedContent = content;
        if (delta) call.onDelta?.(delta);
      }
      const reasoning = state.fragments
        .filter((f) => f?.type === 'THINK')
        .map((f) => f.content || '')
        .join('');
      if (reasoning.length > call.emittedReasoning.length && reasoning.startsWith(call.emittedReasoning)) {
        if (!call.firstTokenAt) call.firstTokenAt = Date.now();
        const delta = reasoning.slice(call.emittedReasoning.length);
        call.emittedReasoning = reasoning;
        if (delta) call.onThinking?.(delta);
      }
    };
    call.parser = createSseParser((payload, event) => {
      if (event === 'hint' && payload && payload.type === 'error') {
        const message = String(payload.content || '网页接口提示错误');
        if (payload.finish_reason === 'rate_limit_reached' || /频繁|休息/.test(message)) {
          throw new RateLimitError(message);
        }
        throw new UpstreamError(message, { code: 'upstream_hint' });
      }
      applyPatch(state, payload);
      call.emit();
    });
    this.calls.set(callId, call);
    return call;
  }

  #onChunk(callId, text, done) {
    const call = this.calls.get(callId);
    if (!call) return;
    try {
      if (done) {
        call.parser.flush();
        call.emit();
        return;
      }
      call.parser.push(text);
      call.emit();
    } catch (err) {
      call.error = err;
      throw new Error('light_stream_stopped');
    }
  }

  #abortCall(callId) {
    this.page
      ?.evaluate((id) => {
        const controller = window.__LIGHT_ABORTS__?.[id];
        if (controller) controller.abort();
      }, callId)
      .catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   * 会话 / PoW
   * ------------------------------------------------------------------ */

  async #createSession() {
    const res = await this.#callJson(SESSION_PATH, '{}', {}, `${this.baseUrl}/`);
    const session = res.json?.data?.biz_data?.chat_session;
    if (!session?.id) {
      this.#throwHttp(res, 'chat_session/create');
    }
    return session.id;
  }

  async #powHeader(targetPath) {
    const res = await this.#callJson(
      CHALLENGE_PATH,
      JSON.stringify({ target_path: targetPath }),
      {},
      `${this.baseUrl}/`,
    );
    const challenge = res.json?.data?.biz_data?.challenge;
    if (!challenge) this.#throwHttp(res, 'create_pow_challenge');

    const solved = await this.pow.solve({
      challenge: challenge.challenge,
      salt: challenge.salt,
      expireAt: challenge.expire_at,
      difficulty: challenge.difficulty,
    });
    this.log.debug('light：PoW 已解', { answer: solved.answer, ms: solved.ms });
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

  /* ------------------------------------------------------------------ *
   * 附件
   * ------------------------------------------------------------------ */

  async uploadImages(images = []) {
    if (!images.length) return [];
    await this.ensureStarted();
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
        await this.#uploadFile({
          buffer,
          mime: image.mime || 'image/png',
          name: image.name || `image-${Date.now()}.png`,
        }),
      );
    }
    return ids;
  }

  async uploadAttachments(files = []) {
    if (!files.length) return [];
    await this.ensureStarted();
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
        await this.#uploadFile({
          buffer,
          mime: file.mime || 'text/plain',
          name: file.name || `context-${Date.now()}.txt`,
        }),
      );
    }
    return ids;
  }

  async #uploadFile({ buffer, mime, name }) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const cached = this.fileCache.get(hash);
    if (cached && cached.expiresAt > Date.now()) return cached.id;

    const powHeader = await this.#powHeader(UPLOAD_PATH);
    const res = await this.page.evaluate(
      (payload) =>
        window.__LIGHT_SDK__.upload(
          payload.path,
          payload.name,
          payload.mime,
          payload.base64,
          payload.headers,
        ),
      {
        path: UPLOAD_PATH,
        name,
        mime,
        base64: buffer.toString('base64'),
        headers: { 'x-ds-pow-response': powHeader },
      },
    );
    const id = res.json?.data?.biz_data?.id;
    if (!id) {
      this.log.warn('light 上传附件失败', { name, status: res.status });
      this.#throwHttp(res, 'file/upload_file');
    }
    this.fileCache.set(hash, { id, expiresAt: Date.now() + FILE_CACHE_TTL_MS });
    this.log.debug('light 附件已上传', { name, bytes: buffer.length });
    return id;
  }

  /* ------------------------------------------------------------------ *
   * 错误与证据
   * ------------------------------------------------------------------ */

  async #callJson(path, body, headers, referrer) {
    const res = await this.page.evaluate(
      (payload) => window.__LIGHT_SDK__.json(payload.path, payload.body, payload.headers, payload.referrer),
      { path, body, headers, referrer },
    );
    if (res.status === 401 || res.status === 403) this.#throwHttp(res, path);
    return res;
  }

  /** 把上游错误映射成仓库里统一的错误类型；403/风控页一律不重试 */
  #throwHttp(res, step) {
    const contentType = String(res?.contentType || '');
    const text = String(res?.text || '');
    const parsed = res?.json || null;
    const message = parsed?.msg || parsed?.data?.biz_msg || `HTTP ${res?.status ?? 0}`;
    this.#recordEvidence({ step, status: res?.status ?? 0, contentType, message, text });

    if (res?.status === 403 && (/text\/html/i.test(contentType) || /验证|风控|captcha|challenge/i.test(text))) {
      throw new CaptchaError('DeepSeek 返回了风控/验证码页面（light），已停止且不再重试');
    }
    if (res?.status === 401 || res?.status === 403) {
      throw new AuthExpiredError('light：登录态被上游拒绝（401/403），请在浏览器里重新登录');
    }
    if (res?.status === 429 || /频繁|rate limit/i.test(message)) throw new RateLimitError(message);
    throw new UpstreamError(`light ${step} 失败：${message}`, { code: 'api_error' });
  }

  /** 只保存「状态/类型/是否有 HTML/是否有验证关键词」，不保存响应正文 */
  #recordEvidence({ step, status, contentType, message, text }) {
    this.lastEvidence = {
      step,
      status,
      contentType,
      looksLikeHtml: /text\/html/i.test(contentType) || /^\s*</.test(text),
      looksLikeCaptcha: /验证|captcha|challenge|风控/i.test(text) || /验证|captcha|风控/i.test(message),
      message,
      at: new Date().toISOString(),
    };
    this.log.warn('light 上游拒绝（脱敏证据）', this.lastEvidence);
  }
}

/* -------------------------------------------------------------------- *
 * 页面上下文 SDK（只在浏览器里跑：读登录态 + fetch，不碰 DOM）
 * -------------------------------------------------------------------- */

function installLightSdk() {
  if (window.__LIGHT_SDK__) return;

  const readUserToken = () => {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : String(parsed?.value || '');
    } catch {
      return '';
    }
  };

  const readCachedString = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : String(parsed?.value || '');
    } catch {
      return '';
    }
  };

  const identity = () => {
    const token = readUserToken();
    let deviceId = '';
    try {
      deviceId =
        localStorage.getItem('deepseek-device-id:chat') ||
        localStorage.getItem('__ds_remote_feature_did') ||
        '';
    } catch {
      /* ignore */
    }
    return {
      signedIn: Boolean(token),
      deviceId,
      hifLeim: readCachedString('hif_leim_cached'),
      hifDliq: readCachedString('hif_dliq_cached'),
      timezoneOffset: -new Date().getTimezoneOffset() * 60,
      locale: navigator.language || 'zh-CN',
    };
  };

  const buildHeaders = (extra) => {
    const id = identity();
    const token = readUserToken();
    const headers = {
      accept: '*/*',
      'content-type': 'application/json',
      dnt: '1',
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'zh_CN',
      'x-client-platform': 'web',
      'x-client-timezone-offset': String(id.timezoneOffset),
      'x-client-version': '2.7.0',
      'x-device-id': id.deviceId,
      'x-device-model': '',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    // hif 签名由页面上的风控 SDK 维护在 localStorage 里；这里按当前值携带
    if (id.hifLeim) headers['x-hif-leim'] = id.hifLeim;
    if (id.hifDliq) headers['x-hif-dliq'] = id.hifDliq;
    return { ...headers, ...(extra || {}) };
  };

  const parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const json = async (path, body, extraHeaders, referrer) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: buildHeaders(extraHeaders),
      body: body || '{}',
      credentials: 'include',
      cache: 'no-store',
      referrer,
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      json: parseJson(text),
      text: text.slice(0, 300),
    };
  };

  const stream = async (callId, path, body, extraHeaders, referrer) => {
    const controller = new AbortController();
    window.__LIGHT_ABORTS__ = window.__LIGHT_ABORTS__ || {};
    window.__LIGHT_ABORTS__[callId] = controller;
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: buildHeaders(extraHeaders),
        body,
        credentials: 'include',
        cache: 'no-store',
        referrer,
        signal: controller.signal,
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('event-stream')) {
        const text = await res.text();
        return { ok: res.ok, status: res.status, contentType, text: text.slice(0, 300), streamed: false };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) await window.__LIGHT_CHUNK__(callId, chunk, false);
      }
      const tail = decoder.decode();
      if (tail) await window.__LIGHT_CHUNK__(callId, tail, false);
      await window.__LIGHT_CHUNK__(callId, '', true);
      return { ok: true, status: res.status, contentType, streamed: true };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        contentType: 'error',
        text: String((err && err.message) || err),
        aborted: controller.signal.aborted,
        streamed: false,
      };
    } finally {
      try {
        delete window.__LIGHT_ABORTS__[callId];
      } catch {
        /* ignore */
      }
    }
  };

  const upload = async (path, name, mime, base64, extraHeaders) => {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), name);

    const headers = buildHeaders(extraHeaders);
    delete headers['content-type'];

    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: form,
      credentials: 'include',
      cache: 'no-store',
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      json: parseJson(text),
      text: text.slice(0, 300),
    };
  };

  window.__LIGHT_SDK__ = { identity, headers: buildHeaders, json, stream, upload };
}
