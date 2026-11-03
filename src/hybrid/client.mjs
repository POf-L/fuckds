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
import { applyPatch, contentOf, createSseParser, createStreamState, reasoningOf } from '../direct/stream.mjs';
import { parseCompletionBodies } from '../browser/stream-capture.mjs';
import { Semaphore } from '../browser/semaphore.mjs';
import { sleep } from '../util.mjs';
import { COMPLETION_PATH, createHybridStreamCapture } from './stream-capture.mjs';

const NEW_CHAT_LABELS = ['开启新对话', '新对话', 'New chat', 'Start new chat'];
/** 发送按钮在「生成中」会换成停止图标；用 path 前缀识别（与 browser 引擎一致） */
const STOP_ICON_PREFIX = 'M2 4.88';
/** 页面上一个补全请求都没出现时，最多等多久就判定「没发出去」 */
const NO_RESPONSE_GRACE_MS = 15_000;
const MUTED_HEADER_NAMES = [
  'cookie',
  'authorization',
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'origin',
  'referer',
  'priority',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'x-client-version',
  'x-client-bundle-id',
  'x-device-id',
  'x-device-model',
  'x-ds-pow-response',
  'x-hif-leim',
  'x-hif-dliq',
];

/**
 * hybrid 引擎：用「真实交互」让页面自己发请求，但回复仍取自页面原生的
 * /api/v0/chat/completion SSE，不做 DOM 文本轮询。
 *
 * 和另外两个引擎的区别：
 *   browser：填输入框 + DOM 轮询（慢、受页面改版影响，但输入/点击也是真实事件）
 *   light  ：在页面上下文里 fetch()，完全不碰 DOM
 *   hybrid ：CDP Input.dispatchKeyEvent 逐字输入（keydown/keyup/input 都真实产生）、
 *            Input.dispatchMouseEvent 点击发送按钮，再抓页面自己发出的补全流。
 *
 * 也就是说：请求的「发起动作」和普通用户完全一样，Node 只负责抓流、解析补丁、
 * 错误分类。流式用 CDP Network.streamResourceContent 拿真增量 chunk，到达即推送；
 * 内容与帧序来自页面原生 SSE，而不是 DOM 渲染结果。
 *
 * 登录态来源：
 *   1. 默认 HYBRID_PROFILE_DIR → chromium.launchPersistentContext（独立 profile，可配 HYBRID_STORAGE_STATE）
 *   2. 显式 HYBRID_CDP_URL     → connectOverCDP 复用已经登录的浏览器（不设就完全不碰 9222）
 * 登录态保存在 profile 目录，空闲关浏览器不影响下次冷启动。
 *
 * 边界：单账号低频；只发一条消息；不输出 token/cookie/签名；遇到 403/风控/验证码立即停止。
 */
export class HybridEngine {
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger;
    this.baseUrl = config.deepseek.baseUrl.replace(/\/+$/, '');

    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdp = null;
    this.ownsPage = false;
    this.persistent = false;
    this.launching = null;
    this.closed = false;
    this.contextClosed = false;
    this.everStarted = false;
    this.inflight = 0;
    this.bindings = new WeakSet();
    this.lastSendAt = 0;
    this.requestUrls = new Map();
    /** 最近一次 completion 请求的脱敏指纹（只有头名/是否存在，没有值） */
    this.lastTrace = null;
    /** CDP 记录的 initiator（只有类型与脚本 URL，不含查询串） */
    this.lastInitiator = null;
    /** 原始头顺序（只有头名） */
    this.lastRequestOrder = null;
    /** 最近一次真实交互的事件序列（只有事件类型与数量，不含内容） */
    this.lastUiTrace = null;
    /** 最近一次 403/风控/验证码的脱敏证据 */
    this.lastEvidence = null;
    this.identityCache = null;
    this.loginRequired = false;
    this.reconnect = { attempts: 0, lastAt: null, lastReason: null, lastError: null, totalMs: 0 };
    /** 固定单页面：并发请求排队；超限快速失败，不为并发再开标签 */
    this.queue = new Semaphore(1, Math.max(1, config.hybrid?.queueLimit ?? 8));
    this.idleTimer = null;
    this.idleClosedAt = null;
    this.lastStreamStats = null;
    /** 鼠标当前位置（贝塞尔轨迹的起点） */
    this.mouse = { x: 0, y: 0, known: false };
    /** 最近一次纯输入实验（不发送）的事件统计 */
    this.lastTypingTrace = null;
  }

  get #hybrid() {
    return this.config.hybrid || {};
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  #needsLaunch() {
    if (this.contextClosed) return true;
    if (!this.persistent && this.browser && !this.browser.isConnected?.()) return true;
    if (!this.page || this.page.isClosed()) return true;
    let url = '';
    try {
      url = this.page.url();
    } catch {
      return true;
    }
    if (/\/sign_in|\/login/i.test(url)) {
      this.loginRequired = true;
      throw new AuthExpiredError('hybrid 引擎：页面已跳到登录页，需要重新登录 chat.deepseek.com');
    }
    return !/chat\.deepseek\.com/.test(url);
  }

  async ensureStarted(reason = 'ensure') {
    if (this.closed) throw new UpstreamError('服务正在关闭');
    if (!this.#needsLaunch()) return;
    if (this.launching) return this.launching;
    this.launching = this.#launch(reason).finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  async #launch(reason = 'ensure') {
    const hybrid = this.#hybrid;
    const profileDir = hybrid.profileDir;
    // 只有显式 HYBRID_CDP_URL 才复用外部浏览器；默认永远走独立 profile
    const cdpUrl = hybrid.cdpUrl;
    // 空闲关闭后的唤醒不算故障重连，不写 reconnect 证据
    const recover = reason !== 'initial' && reason !== 'idle-wake' && this.everStarted;
    const startedAt = Date.now();

    if (cdpUrl) {
      await this.#ensureCdp(cdpUrl);
    } else {
      await this.#ensurePersistent(profileDir, hybrid);
    }

    const page = await this.#ensurePage();
    this.page = page;
    await this.#bindPage(page);
    this.everStarted = true;
    this.idleClosedAt = null;

    if (recover) {
      this.reconnect.lastAt = new Date().toISOString();
      this.reconnect.lastReason = reason;
      this.reconnect.totalMs = Date.now() - startedAt;
      this.log.warn('hybrid 自动重连成功（浏览器/页面已恢复，脱敏）', { ...this.reconnect });
    }

    const identity = await this.#identity();
    this.identityCache = identity;
    if (!identity.signedIn) {
      this.loginRequired = true;
      // 即使没登录也要安排空闲回收，避免「登录页一直挂着」占内存
      this.#resetIdleTimer();
      throw new AuthExpiredError(
        cdpUrl
          ? 'hybrid 引擎：登录态已失效（浏览器里没有 userToken），需要重新登录 https://chat.deepseek.com'
          : `hybrid 引擎：独立 profile 里还没有登录态。请运行 npm run auth:hybrid 打开 ${profileDir} 登录一次（登录态会留在该目录，之后可冷启动复用）`,
      );
    }
    this.loginRequired = false;

    this.log.info('hybrid 引擎已就绪', {
      transport: cdpUrl ? 'cdp' : 'persistent-profile',
      recovered: recover,
      deviceId: Boolean(identity.deviceId),
    });
    this.#resetIdleTimer();
  }

  async #withBackoff(label, fn) {
    const maxAttempts = Math.max(1, this.#hybrid.reconnectMaxAttempts ?? 5);
    const totalMs = Math.max(1_000, this.#hybrid.reconnectTotalMs ?? 30_000);
    const startedAt = Date.now();
    let attempt = 0;
    let delay = 500;
    for (;;) {
      attempt += 1;
      this.reconnect.attempts = attempt;
      try {
        const value = await fn();
        this.reconnect.lastError = null;
        return value;
      } catch (err) {
        this.reconnect.lastError = err.message;
        if (attempt >= maxAttempts || Date.now() - startedAt >= totalMs) {
          throw new UpstreamError(
            `hybrid 重连失败（${label}，${attempt} 次 / ${Date.now() - startedAt}ms）：${err.message}`,
            { code: 'hybrid_reconnect_failed' },
          );
        }
        const wait = Math.min(delay, 8_000) + Math.floor(Math.random() * 200);
        this.log.warn(`hybrid ${label} 失败，${wait}ms 后重试`, { attempt, message: err.message });
        await sleep(wait);
        delay = Math.min(delay * 2, 8_000);
      }
    }
  }

  async #ensurePersistent(profileDir, hybrid) {
    let browserAlive = true;
    try {
      browserAlive = this.context?.browser?.()?.isConnected?.() !== false;
    } catch {
      browserAlive = false;
    }
    if (this.context && !this.contextClosed && browserAlive) return;
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.contextClosed = false;

    fs.mkdirSync(profileDir, { recursive: true });
    const state = hybrid.storageState;
    if (state && !fs.existsSync(state)) {
      throw new UpstreamError(`HYBRID_STORAGE_STATE 指向的文件不存在：${state}`);
    }
    this.log.info('启动持久化浏览器（hybrid）…', {
      profileDir,
      headless: hybrid.headless,
      channel: hybrid.channel || '(bundled chromium)',
      storageState: Boolean(state),
    });

    const launchOnce = (options) =>
      chromium.launchPersistentContext(profileDir, {
        headless: hybrid.headless,
        executablePath: hybrid.executablePath || undefined,
        ...options,
        storageState: state || undefined,
        viewport: this.config.browser.viewport,
        locale: this.config.browser.locale,
        timezoneId: process.env.TZ || 'Asia/Shanghai',
        args: hybridLaunchArgs(),
      });

    const context = await this.#withBackoff('persistent-launch', async () => {
      const channel = hybrid.channel;
      if (!hybrid.executablePath && channel) {
        try {
          return await launchOnce({ channel });
        } catch (err) {
          this.log.warn('hybrid：channel 启动失败，回退 Playwright 自带 Chromium', {
            channel,
            message: err.message,
          });
        }
      }
      return launchOnce({});
    });
    this.context = context;
    this.persistent = true;
    context.on('close', () => {
      this.contextClosed = true;
      this.page = null;
      this.cdp = null;
      if (!this.closed) this.log.warn('hybrid：持久化浏览器已退出，下次请求会重启实例');
    });
  }

  async #ensureCdp(cdpUrl) {
    if (this.browser?.isConnected?.() && this.context && !this.contextClosed) return;
    const old = this.browser;
    if (old) await old.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.cdp = null;
    this.contextClosed = false;

    this.log.info('连接已登录浏览器（hybrid）…', { cdpUrl });
    const connected = await this.#withBackoff('cdp-connect', async () => {
      const browser = await chromium.connectOverCDP(cdpUrl);
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.cdp = null;
        if (!this.closed) this.log.warn('hybrid：CDP 连接已断开，下次请求会按退避重连');
      });
      const context = browser.contexts()[0] || (await browser.newContext());
      context.on('close', () => {
        if (this.context !== context) return;
        this.contextClosed = true;
        this.page = null;
        this.cdp = null;
        if (!this.closed) this.log.warn('hybrid：浏览器上下文已关闭，下次请求会重连');
      });
      return { browser, context };
    });
    this.browser = connected.browser;
    this.context = connected.context;
  }

  #findPage() {
    const pages = this.context?.pages?.() || [];
    return (
      pages.find((p) => {
        if (p.isClosed()) return false;
        const url = p.url();
        return /chat\.deepseek\.com/.test(url) && !/\/sign_in|\/login/i.test(url);
      }) || null
    );
  }

  async #ensurePage() {
    const existing = this.#findPage();
    if (existing) {
      // 复用用户自己的 tab 时绝不能把它当成「自己的页面」在关闭时一起关掉
      if (existing !== this.page) this.ownsPage = false;
      // 独立 profile 下强制单标签：清掉遗留的多余页面（自己开的才关）
      if (this.persistent) {
        for (const p of this.context?.pages?.() || []) {
          if (p !== existing && !p.isClosed()) await p.close().catch(() => {});
        }
      }
      return existing;
    }

    if (this.page && !this.page.isClosed() && this.ownsPage) {
      try {
        await this.#navigate(this.page);
        return this.page;
      } catch (err) {
        this.log.warn('hybrid：原页面导航失败，改为新开页面', { message: err.message });
        await this.page.close().catch(() => {});
        this.page = null;
      }
    }
    return this.#openPage();
  }

  async #navigate(page) {
    await page.goto(`${this.baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: this.#hybrid.navigationTimeoutMs,
    });
  }

  async #openPage() {
    if (!this.context) throw new UpstreamError('hybrid：没有可用的浏览器上下文');
    // 持久化 profile 启动时 Chromium 会自带一个空白标签，直接复用，避免「一开就是两个 tab」
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const reusable = this.persistent ? pages[0] : null;
    const page = reusable || (await this.context.newPage());
    this.ownsPage = true;
    page.setDefaultTimeout(30_000);
    if (!reusable) await this.#navigate(page);
    else if (!/chat\.deepseek\.com/.test(page.url())) await this.#navigate(page);
    return page;
  }

  /* ------------------------------------------------------------------ *
   * 空闲回收：到点关浏览器，登录态留在 profile，下个请求冷启动
   * ------------------------------------------------------------------ */

  #resetIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const idleMs = this.#hybrid.idleCloseMs;
    if (!idleMs || this.closed) return;
    this.idleTimer = setTimeout(() => {
      if (this.closed) return;
      if (this.inflight > 0 || this.launching) {
        this.#resetIdleTimer();
        return;
      }
      this.log.info(`hybrid 空闲 ${Math.round(idleMs / 1000)}s，关闭浏览器释放内存（登录态保留在 profile）`);
      void this.#closeIdle();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  async #closeIdle() {
    const page = this.page;
    const context = this.context;
    const persistent = this.persistent;
    try {
      if (page && this.ownsPage && !page.isClosed()) await page.close();
    } catch {
      /* ignore */
    }
    this.page = null;
    this.cdp = null;
    this.identityCache = null;
    try {
      if (persistent) await context?.close();
      else await this.browser?.close(); // connectOverCDP 的 close 只是断开连接，不会杀掉用户的浏览器
    } catch {
      /* ignore */
    }
    this.context = null;
    this.browser = null;
    this.persistent = false;
    this.contextClosed = true;
    this.idleClosedAt = new Date().toISOString();
  }

  async #bindPage(page) {
    if (this.bindings.has(page)) return;
    this.bindings.add(page);

    page.on('close', () => {
      if (this.page !== page) return;
      this.page = null;
      this.cdp = null;
      if (!this.closed) this.log.warn('hybrid：页面已关闭，下次请求会自动重连');
    });
    page.on('crash', () => {
      if (this.page !== page) return;
      this.page = null;
      this.cdp = null;
      if (!this.closed) this.log.warn('hybrid：页面崩溃，下次请求会自动重连');
    });

    await page.evaluate(installHybridHelpers);

    // 一个页面一个 CDP 会话：既用于 Input.* 真实事件，也用于记录 initiator/头顺序
    const cdp = await page.context().newCDPSession(page);
    this.cdp = cdp;

    try {
      await cdp.send('Network.enable');
    } catch (err) {
      this.log.debug('hybrid：Network.enable 不可用（不影响输入/点击）', { message: err.message });
    }

    cdp.on('Network.requestWillBeSent', (event) => {
      const url = event.request?.url || '';
      this.requestUrls.set(event.requestId, url);
      if (!url.includes(COMPLETION_PATH)) return;
      this.lastInitiator = sanitizeInitiator(event.initiator, this.baseUrl);
    });

    cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
      const url = this.requestUrls.get(event.requestId) || '';
      if (!url.includes(COMPLETION_PATH)) return;
      const order = Object.keys(event.headers || {});
      if (order.length) this.lastRequestOrder = order;
      this.requestUrls.delete(event.requestId);
    });
  }

  async #identity() {
    if (!this.page || this.page.isClosed()) {
      throw new UpstreamError('hybrid：页面已关闭', { code: 'hybrid_page_gone' });
    }
    let id;
    try {
      // 不用页面探针，避免用户中途刷新/跳转后探针还没重装时读不到登录态
      id = await this.page.evaluate(() => {
        const read = (key) => {
          try {
            const raw = localStorage.getItem(key);
            if (!raw) return '';
            const parsed = JSON.parse(raw);
            return typeof parsed === 'string' ? parsed : String(parsed?.value || '');
          } catch {
            return '';
          }
        };
        let deviceId = '';
        try {
          deviceId =
            localStorage.getItem('deepseek-device-id:chat') ||
            localStorage.getItem('__ds_remote_feature_did') ||
            '';
        } catch {
          /* ignore */
        }
        return { signedIn: Boolean(read('userToken')), deviceId };
      });
    } catch (err) {
      this.page = null;
      this.cdp = null;
      throw new UpstreamError(`hybrid：页面读取登录态失败：${err.message}`, { code: 'hybrid_page_failed' });
    }
    this.identityCache = id;
    this.loginRequired = !id.signedIn;
    return id;
  }

  async #assertSignedIn() {
    const id = await this.#identity();
    if (!id.signedIn) {
      throw new AuthExpiredError(
        'hybrid 引擎：登录态已失效（userToken 不存在或页面已退出登录），需要重新登录 chat.deepseek.com',
      );
    }
  }

  async warmUp() {
    await this.ensureStarted('initial');
    await this.#assertSignedIn();
    await this.#ensureProbe();
    const st = await this.page.evaluate(() => window.__HYBRID__.composerState());
    if (!st?.inputVisible) {
      this.log.warn('hybrid 预热：输入框还不可见，首次请求会重试页面准备');
    }
  }

  health() {
    let pageUrl = null;
    if (this.page && !this.page.isClosed()) {
      try {
        pageUrl = this.page.url();
      } catch {
        pageUrl = null;
      }
    }
    const browserOnline = this.persistent
      ? Boolean(this.context && !this.contextClosed)
      : Boolean(this.browser?.isConnected?.());
    const pageReady = Boolean(
      pageUrl && /chat\.deepseek\.com/.test(pageUrl) && !/\/sign_in|\/login/i.test(pageUrl),
    );
    return {
      engine: 'hybrid',
      online: browserOnline && pageReady && !this.loginRequired,
      browserOnline,
      pageReady,
      pageUrl,
      loginRequired: this.loginRequired,
      transport: this.#hybrid.cdpUrl ? 'cdp' : 'persistent-profile',
      profileDir: this.#hybrid.cdpUrl ? null : this.#hybrid.profileDir,
      idleCloseMs: this.#hybrid.idleCloseMs ?? null,
      idleClosedAt: this.idleClosedAt,
      reconnect: { ...this.reconnect },
    };
  }

  status() {
    const health = this.health();
    return {
      ...health,
      browser: health.browserOnline,
      pages: health.pageReady ? 1 : 0,
      busy: this.queue.active,
      queued: this.queue.pending,
      queueLimit: this.queue.queueLimit,
      streamMode: this.#hybrid.streamMode || 'incremental',
      lastStream: this.lastStreamStats,
      lastTimings: this.lastTimings || null,
      token: Boolean(this.identityCache?.signedIn),
    };
  }

  async close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.page && this.ownsPage) await this.page.close().catch(() => {});
    this.page = null;
    this.cdp = null;
    if (this.persistent) await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
    this.contextClosed = true;
  }

  /* ------------------------------------------------------------------ *
   * 附件：hybrid 走页面 UI，暂不支持文件注入
   * ------------------------------------------------------------------ */

  async uploadImages() {
    throw new ApiError(400, 'hybrid 引擎暂不支持图片输入：请用 direct / light，或改用纯文本', {
      code: 'image_not_supported',
    });
  }

  async uploadAttachments() {
    throw new PromptTooLongError(
      '上下文超过输入框上限，需要转成附件，但 hybrid 引擎暂不支持附件上传：请用 direct / light，或减少上下文',
    );
  }

  /* ------------------------------------------------------------------ *
   * 对话
   * ------------------------------------------------------------------ */

  async chat({ prompt, thinking = false, search = false, refFileIds = [], signal, onDelta, onThinking, meta = {} }) {
    void meta;
    if (prompt.length > this.config.runtime.maxPromptChars) {
      throw new PromptTooLongError(
        `拼接后的 prompt 有 ${prompt.length} 字符，超过上限 ${this.config.runtime.maxPromptChars}`,
      );
    }
    if (refFileIds?.length) {
      throw new ApiError(400, 'hybrid 引擎暂不支持 ref_file_ids 附件', { code: 'attachment_not_supported' });
    }

    // 固定单页面：请求排队执行，超过 HYBRID_QUEUE_LIMIT 直接 429，不再开标签硬扛
    const release = await this.queue.acquire();
    this.inflight += 1;
    const startedAt = Date.now();
    try {
      await this.ensureStarted();
      await this.#assertSignedIn();
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.#oneRound({ prompt, thinking, search, signal, onDelta, onThinking, startedAt });
        } catch (err) {
          const retriable =
            err?.code === 'hybrid_page_gone' || err?.code === 'hybrid_page_failed';
          if (!retriable || attempt >= 2 || signal?.aborted) throw err;
          this.log.warn('hybrid：页面在执行中丢失，重连后重试一次', { message: err.message });
          await this.ensureStarted('page_lost');
          await this.#assertSignedIn();
        }
      }
    } finally {
      this.inflight -= 1;
      await this.#clearInput().catch(() => {});
      release();
      this.#resetIdleTimer();
    }
  }

  /**
   * 只做「打开页面 → 输入 → 清空」，不发送任何消息。
   * 用于测量行为层事件（IME/节奏/鼠标），不消耗上游请求额度。
   */
  async simulateTyping(prompt, { thinking = false, search = false } = {}) {
    const release = await this.queue.acquire();
    this.inflight += 1;
    const startedAt = Date.now();
    try {
      await this.ensureStarted();
      await this.#assertSignedIn();
      await this.#ensureProbe();
      await this.#prepareComposer({ thinking, search });
      const trace = await this.#typePrompt(prompt, null);
      this.lastTypingTrace = trace;
      return { ...trace, totalMs: Date.now() - startedAt };
    } finally {
      await this.#clearInput().catch(() => {});
      this.inflight -= 1;
      release();
      this.#resetIdleTimer();
    }
  }

  async #oneRound({ prompt, thinking, search, signal, onDelta, onThinking, startedAt }) {
    const page = this.page;
    if (!page || page.isClosed()) {
      throw new UpstreamError('hybrid：页面已关闭', { code: 'hybrid_page_gone' });
    }
    await this.#ensureProbe();
    await this.#prepareComposer({ thinking, search });
    if (signal?.aborted) throw new UpstreamError('客户端已断开', { status: 499, code: 'client_closed' });

    // 清掉上一轮的 initiator，避免把旧证据当成本次请求的
    this.lastInitiator = null;
    this.lastRequestOrder = null;

    const capture = createHybridStreamCapture({
      page,
      cdp: this.cdp,
      mode: this.#hybrid.streamMode === 'batch' ? 'batch' : 'incremental',
      logger: this.log,
      onDelta,
      onThinking,
    });
    let clickedAt = 0;
    try {
      clickedAt = await this.#typeAndSend(prompt, signal);
      const remaining = Math.max(1_000, this.config.runtime.requestTimeoutMs - (Date.now() - startedAt));
      let softChecked = false;
      const collected = await capture.collect({
        signal,
        timeoutMs: remaining,
        clickedAt,
        noResponseGraceMs: NO_RESPONSE_GRACE_MS,
        onTick: (elapsed) => {
          if (!softChecked && !capture.hasResponse() && elapsed > 2_000) {
            softChecked = true;
            // 只是状态检查（验证码/限流提示），不读 DOM 回答文本
            void this.#checkUiBlockers({ soft: true }).catch(() => {});
          }
        },
      });

      if (signal?.aborted) {
        await this.#clickStopIfBusy();
        throw new UpstreamError('客户端已断开，已停止生成', { status: 499, code: 'client_closed' });
      }

      const stream = capture.capture;
      const stats = collected.stats;
      this.lastStreamStats = {
        ...stats,
        responses: collected.responses,
        cdpResponses: collected.cdpResponses,
        timedOut: collected.timedOut,
        captureMs: collected.ms,
      };

      for (const entry of capture.entries) this.#classifyStatus(entry);
      if (stream.trace) this.#recordTraceFromCapture(stream.trace);

      if (collected.noResponse) {
        await this.#checkUiBlockers();
        throw new UpstreamError('hybrid：点击发送后页面没有发出补全请求（可能被风控或按钮未生效）', {
          code: 'send_failed',
        });
      }
      if (collected.timedOut && !collected.bodies.length && !stream.emittedContent) {
        await this.#checkUiBlockers();
        throw new TimeoutError(`等待页面补全流超过 ${Math.round(remaining / 1000)}s`);
      }

      // SSE 里显式的错误 hint（限流/上游错误）优先抛出，与旧回放语义一致
      const hint = stream.hintErrors[0];
      if (hint) {
        if (/rate_limit_reached|频繁|休息/i.test(hint)) throw new RateLimitError(hint);
        throw new UpstreamError(hint, { code: 'upstream_hint' });
      }

      const analysis = collected.bodies.length ? parseCompletionBodies(collected.bodies) : null;
      if (analysis?.rateLimited && !analysis.text && !analysis.reasoning) {
        throw new RateLimitError(this.#hintMessage(analysis) || undefined);
      }

      const streamedContent = stream.emittedContent;
      const streamedReasoning = stream.emittedReasoning;
      const finalText = analysis?.text || streamedContent;
      const finalReasoning = analysis?.reasoning || streamedReasoning;
      if (!finalText && !finalReasoning) {
        if (collected.timedOut) {
          this.log.warn('hybrid：等待补全流超时，没有拿到任何内容', {
            responses: collected.responses,
          });
        }
        await this.#checkUiBlockers();
        throw new UpstreamError('hybrid：页面补全流没有返回任何内容', { code: 'empty_response' });
      }

      // 增量推送已到客户端；只补「严格前缀兼容」的尾巴，避免重复/回退
      if (finalText.length > streamedContent.length && finalText.startsWith(streamedContent)) {
        const delta = finalText.slice(streamedContent.length);
        if (delta) onDelta?.(delta);
      } else if (finalText !== streamedContent && streamedContent) {
        this.log.warn('hybrid：增量文本与权威文本不一致，保留已推送内容', {
          streamed: streamedContent.length,
          authoritative: finalText.length,
        });
      }
      if (finalReasoning.length > streamedReasoning.length && finalReasoning.startsWith(streamedReasoning)) {
        const delta = finalReasoning.slice(streamedReasoning.length);
        if (delta) onThinking?.(delta);
      }

      const finalState = collected.bodies.length ? this.#parseBodyState(chooseBodyForReplay(collected.bodies, analysis)) : null;
      const streamedText = finalText === streamedContent ? streamedContent : finalText;
      const elapsedMs = Date.now() - startedAt;
      this.lastTimings = {
        prepareMs: clickedAt - startedAt,
        typingMs: clickedAt - startedAt,
        firstByteMs: stats.firstByteAt ? stats.firstByteAt - clickedAt : null,
        firstTokenMs: stats.firstTokenAt ? stats.firstTokenAt - clickedAt : null,
        lastTokenMs: stats.lastTokenAt ? stats.lastTokenAt - clickedAt : null,
        captureMs: collected.ms,
        totalMs: elapsedMs,
        streamMode: stats.mode,
        chunks: stats.chunks,
      };

      return {
        text: finalText,
        reasoning: finalReasoning,
        streamed: streamedText,
        streamedReasoning: streamedReasoning,
        elapsedMs,
        timings: this.lastTimings,
        usage: finalState?.usage || null,
      };
    } finally {
      await capture.dispose();
    }
  }

  /* ------------------------------------------------------------------ *
   * 页面准备：上一条生成 / 新对话 / 开关
   * ------------------------------------------------------------------ */

  async #prepareComposer({ thinking, search }) {
    await this.#settleGenerating();

    if (this.#hybrid.newChat !== false) {
      await this.#maybeNewChat();
      // 新对话可能触发路由变化/重渲染，探针需要确保还在
      await this.#ensureProbe();
    }

    if (this.config.deepseek.manageToggles) {
      await this.#maybeToggle('深度思考', Boolean(thinking));
      await this.#maybeToggle('智能搜索', Boolean(search));
    }

    const st = await this.page.evaluate(() => window.__HYBRID__.composerState());
    if (!st?.inputVisible) {
      throw new UpstreamError('hybrid：找不到输入框（页面结构可能变了或还在加载）', { code: 'ui_not_ready' });
    }
  }

  /**
   * 上一条还在生成时按钮会变成「停止」。
   * 这里绝不盲点发送：先按一次停止，再等按钮恢复；等不到就明确报忙。
   */
  async #settleGenerating() {
    let st = await this.#buttonState();
    if (!st?.found || !st.isStop) return;
    this.log.warn('hybrid：上一条回复仍在生成，先点击停止');
    await this.#clickAt(st);
    const deadline = Date.now() + 20_000;
    for (;;) {
      await sleep(120);
      st = await this.#buttonState().catch(() => null);
      if (!st?.found || !st.isStop) return;
      if (Date.now() > deadline) {
        throw new UpstreamError('hybrid：上一条回复仍在生成，停止后按钮没有恢复', { code: 'page_busy' });
      }
    }
  }

  async #maybeNewChat() {
    const st = await this.page.evaluate(() => window.__HYBRID__.conversationState());
    if (!st?.assistantCount) return;

    const clicked = await this.page.evaluate(
      (labels) => window.__HYBRID__.clickByTexts(labels),
      NEW_CHAT_LABELS,
    );
    if (!clicked) {
      this.log.warn('hybrid：没找到「新对话」按钮，继续在当前对话发送（可能混入上一轮上下文）');
      return;
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      await sleep(120);
      const now = await this.page.evaluate(() => window.__HYBRID__.conversationState());
      if (now?.assistantCount === 0 && now?.inputVisible) return;
      if (Date.now() > deadline) {
        this.log.warn('hybrid：点击新对话后页面没有清空，继续发送');
        return;
      }
    }
  }

  async #maybeToggle(label, desired) {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await this.page.evaluate((text) => window.__HYBRID__.toggleState(text), label);
        if (!state?.found) {
          this.log.debug(`hybrid：没有找到开关「${label}」，跳过`);
          return;
        }
        if (state.selected === Boolean(desired)) return;
        const clicked = await this.page.evaluate((text) => window.__HYBRID__.clickToggle(text), label);
        if (!clicked) return;
        this.log.debug(`hybrid：开关 ${label} -> ${desired ? '开' : '关'}`);
        await sleep(120);
      }
      this.log.warn(`hybrid：开关「${label}」没能切到 ${desired ? '开' : '关'}，继续执行`);
    } catch (err) {
      this.log.debug(`hybrid：切换 ${label} 失败（忽略）`, { message: err.message });
    }
  }

  /* ------------------------------------------------------------------ *
   * 真实输入 + 真实点击
   * ------------------------------------------------------------------ */

  async #typeAndSend(prompt, signal) {
    const page = this.page;
    const cdp = this.cdp;
    if (!cdp) throw new UpstreamError('hybrid：CDP 会话不可用', { code: 'hybrid_page_failed' });

    // 账号级发送间隔，避免「发送过于频繁」
    const now = Date.now();
    const wait = Math.max(0, (this.lastSendAt || 0) + this.config.runtime.sendIntervalMs - now);
    if (wait > 0) {
      this.log.debug(`hybrid：等待发送窗口 ${Math.round(wait / 100) / 10}s`);
      await sleep(wait, signal);
    }

    await this.#typePrompt(prompt, signal);

    // 发送前确认：按钮可用（不是停止态、不是 disabled）且输入非空
    const deadline = Date.now() + 10_000;
    let btn = null;
    for (;;) {
      btn = await this.#buttonState();
      if (btn?.found && !btn.disabled && !btn.isStop && btn.value.trim()) break;
      if (Date.now() > deadline) {
        await this.#checkUiBlockers();
        throw new UpstreamError(
          `hybrid：发送按钮状态不符合预期（disabled=${btn?.disabled} stop=${btn?.isStop}）`,
          { code: 'send_button_unavailable' },
        );
      }
      await sleep(100, signal);
    }

    const beforeClicks = await page.evaluate(() => window.__HYBRID__.probe.snapshot());
    await this.#hover(btn);
    await this.#mouseClickAt(btn.x, btn.y);
    this.lastSendAt = Date.now();
    const clickedAt = this.lastSendAt;
    await sleep(120, signal);

    const after = await page.evaluate(() => window.__HYBRID__.probe.snapshot());
    this.lastUiTrace = {
      at: new Date().toISOString(),
      typedChars: prompt.length,
      ...(this.lastTypingTrace || {}),
      before: beforeClicks.counts,
      after: after.counts,
      sequence: after.sequence,
      clickMethod: 'Input.dispatchMouseEvent',
      inputMethod: 'Input.dispatchKeyEvent + Input.insertText + Input.imeSetComposition',
      mouseCurve: this.#hybrid.mouseCurve !== false,
    };
    this.log.info('hybrid 真实交互事件（脱敏，只有类型/数量）', {
      keydown: after.counts.keydown,
      keyup: after.counts.keyup,
      input: after.counts.input,
      click: after.counts.click,
      mousedown: after.counts.mousedown,
      mouseup: after.counts.mouseup,
      mousemove: after.counts.mousemove,
      compositionstart: after.counts.compositionstart,
      compositionupdate: after.counts.compositionupdate,
      compositionend: after.counts.compositionend,
    });

    return clickedAt;
  }

  /**
   * 只做输入（不发送）：鼠标轨迹 → 点击聚焦 → 非线性节奏逐字输入 → 校验 → 返回事件统计。
   * 供 chat 与 simulateTyping 复用。
   */
  async #typePrompt(prompt, signal) {
    const page = this.page;
    const cdp = this.cdp;
    if (!cdp) throw new UpstreamError('hybrid：CDP 会话不可用', { code: 'hybrid_page_failed' });

    const hybrid = this.#hybrid;
    const baseMs = Math.max(0, hybrid.typingDelayMs ?? 45);
    const sampleChars = Math.max(0, hybrid.typeSampleChars ?? 80);
    const rhythm = hybrid.typingRhythm !== false;
    const ime = hybrid.ime !== false;
    const typoRate = Number.isFinite(hybrid.typoRate) ? hybrid.typoRate : 0.015;

    await page.evaluate(() => window.__HYBRID__.probe.reset());
    await page.evaluate(() => window.__HYBRID__.focusInput());
    await this.#clearInput();

    const box = await page.evaluate(() => window.__HYBRID__.inputBox());
    if (!box) throw new UpstreamError('hybrid：输入框不可见', { code: 'ui_not_ready' });
    // 先真实移动鼠标到输入框再按下：click 事件与 focus 都由浏览器产生
    await this.#moveTo(box.x, box.y);
    await sleep(90 + Math.random() * 120, signal);
    await this.#mouseClickAt(box.x, box.y);
    await sleep(50 + Math.random() * 60, signal);

    const sample = prompt.slice(0, sampleChars);
    const actions = planTyping(sample, { baseMs, rhythm, typoRate, ime });
    let keyEventChars = 0;
    let imeWords = 0;
    let typos = 0;
    const typingStartedAt = Date.now();
    for (const action of actions) {
      if (signal?.aborted) throw new UpstreamError('客户端已断开', { status: 499, code: 'client_closed' });
      if (action.kind === 'sleep') {
        await sleep(action.ms, signal);
      } else if (action.kind === 'ime') {
        await this.#typeImeWord(action.word, signal);
        imeWords += 1;
      } else if (action.kind === 'enter') {
        await this.#pressShiftEnter();
        keyEventChars += 1;
      } else if (action.kind === 'backspace') {
        await this.#pressBackspace();
        keyEventChars += 1;
      } else if (action.kind === 'key') {
        await this.#typeChar(action.char);
        keyEventChars += 1;
      }
      if (action.typo) typos += 1;
    }

    const rest = prompt.slice(sampleChars);
    if (rest) {
      // 长 prompt 逐字输入不现实：前 sampleChars 已留下真实键鼠样本，剩余部分用 insertText 批量注入
      for (let i = 0; i < rest.length; i += 2_000) {
        await cdp.send('Input.insertText', { text: rest.slice(i, i + 2_000) });
        await sleep(25, signal);
      }
    }

    await this.#assertInputValue(prompt);

    const snap = await page.evaluate(() => window.__HYBRID__.probe.snapshot());
    this.lastTypingTrace = {
      typedChars: prompt.length,
      sampledChars: sample.length,
      keyEventChars,
      insertTextFallbackChars: Math.max(0, prompt.length - sampleChars),
      imeWords,
      typos,
      typingMs: Date.now() - typingStartedAt,
      counts: snap.counts,
      sequence: snap.sequence,
    };
    return this.lastTypingTrace;
  }

  /** 逐字输入：keyDown 带 text，keyUp 紧跟，保证 keydown/keyup/input 都是真实事件 */
  async #typeChar(ch) {
    const info = keyInfoForChar(ch);
    if (info) {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk,
        modifiers: info.modifiers || 0,
        text: ch,
        unmodifiedText: ch,
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk,
        modifiers: info.modifiers || 0,
      });
      return;
    }
    // 中文/emoji 等没有物理键位：insertText 产生真实 input 事件，再补一对 key 事件留下时序痕迹
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Unidentified',
      code: '',
      windowsVirtualKeyCode: 0,
    });
    await this.cdp.send('Input.insertText', { text: ch });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Unidentified',
      code: '',
      windowsVirtualKeyCode: 0,
    });
  }

  /** 换行用 Shift+Enter：普通 Enter 会直接发送，不能用来输入多行 */
  async #pressShiftEnter() {
    const base = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 8,
    };
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...base,
      text: '\r',
      unmodifiedText: '\r',
    });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /**
   * 输入法输入：拼音候选阶段用 imeSetComposition（产生 compositionstart/update），
   * 提交阶段用 Input.insertText（浏览器会替换候选文本并触发 compositionend）。
   * 全程走 CDP，不伪造 DOM 事件。
   */
  async #typeImeWord(word, signal) {
    const latin = fakePinyin(word);
    if (!latin) {
      await this.cdp.send('Input.insertText', { text: word });
      return;
    }
    const first = latin.slice(0, Math.max(1, Math.ceil(latin.length / 2)));
    await this.cdp.send('Input.imeSetComposition', {
      text: first,
      selectionStart: first.length,
      selectionEnd: first.length,
    });
    await sleep(35 + Math.random() * 70, signal);
    await this.cdp.send('Input.imeSetComposition', {
      text: latin,
      selectionStart: latin.length,
      selectionEnd: latin.length,
    });
    await sleep(45 + Math.random() * 90, signal);
    await this.cdp.send('Input.insertText', { text: word });
  }

  async #pressBackspace() {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      commands: ['deleteBackward'],
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
  }

  async #assertInputValue(prompt) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const st = await this.page.evaluate(() => window.__HYBRID__.inputState());
      if (st?.value === prompt) return;
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    // 兜底：原生 setter + input 事件（React 受控组件也会更新），再校验一次
    this.log.warn('hybrid：键盘输入没有得到预期内容，退回原生 setter + input 事件');
    await this.page.evaluate((text) => window.__HYBRID__.setInputValue(text), prompt);
    const deadline2 = Date.now() + 5_000;
    for (;;) {
      const st = await this.page.evaluate(() => window.__HYBRID__.inputState());
      if (st?.value === prompt) {
        this.log.info('hybrid：输入内容已通过原生 setter 对齐（脱敏）', { chars: prompt.length });
        return;
      }
      if (Date.now() > deadline2) {
        throw new UpstreamError('hybrid：输入内容与 prompt 不一致，已停止发送', { code: 'hybrid_typing_failed' });
      }
      await sleep(100);
    }
  }

  async #buttonState() {
    if (!this.page || this.page.isClosed()) {
      throw new UpstreamError('hybrid：页面已关闭', { code: 'hybrid_page_gone' });
    }
    try {
      return await this.page.evaluate(() => window.__HYBRID__.buttonState());
    } catch (err) {
      this.page = null;
      this.cdp = null;
      throw new UpstreamError(`hybrid：读取发送按钮失败：${err.message}`, { code: 'hybrid_page_failed' });
    }
  }

  async #mouseMove(x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      button: 'none',
      buttons: 0,
    });
  }

  /**
   * 移动鼠标：默认走三次贝塞尔曲线（含加减速与轻微抖动），不是两点直线。
   * HYBRID_MOUSE_CURVE=0 时退回单次跳跃，便于对照。
   */
  async #moveTo(x, y, { steps } = {}) {
    const target = { x: Math.round(x), y: Math.round(y) };
    if (this.#hybrid.mouseCurve === false) {
      await this.#mouseMove(target.x, target.y);
      this.mouse = { ...target, known: true };
      return;
    }
    const start = this.mouse.known
      ? { x: this.mouse.x, y: this.mouse.y }
      : {
          x: target.x + (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 160),
          y: target.y + (Math.random() * 160 - 80),
        };
    const path = bezierPath(start, target, { steps });
    for (const point of path) {
      await this.#mouseMove(point.x, point.y);
      await sleep(point.delay);
    }
    this.mouse = { ...target, known: true };
  }

  async #hover(btn) {
    if (this.#hybrid.mouseCurve === false) {
      // 旧行为：两段直线 + 固定停留
      await this.#mouseMove(btn.x - Math.min(20, btn.w / 2), btn.y);
      await sleep(80);
      await this.#mouseMove(btn.x, btn.y);
      await sleep(120);
      return;
    }
    // 先停在按钮左上方一点（像人先把手移过去），停留后再落到中心
    const approachX = btn.x - 18 - Math.random() * 26;
    const approachY = btn.y + (Math.random() * 14 - 7);
    await this.#moveTo(approachX, approachY);
    await sleep(140 + Math.random() * 180);
    await this.#moveTo(btn.x + (Math.random() * 8 - 4), btn.y + (Math.random() * 6 - 3), { steps: 4 });
    await sleep(70 + Math.random() * 120);
  }

  async #mouseClickAt(x, y) {
    await this.#moveTo(x, y);
    await sleep(40 + Math.random() * 80);
    // 按下前 2-3 像素的微调：真人很少一次就停在正中心
    const px = x + (Math.random() * 4 - 2);
    const py = y + (Math.random() * 4 - 2);
    if (this.#hybrid.mouseCurve !== false) {
      await this.#moveTo(px, py, { steps: 3 });
      await sleep(20 + Math.random() * 40);
    }
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(px),
      y: Math.round(py),
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await sleep(35 + Math.random() * 55);
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(px),
      y: Math.round(py),
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    if (this.#hybrid.mouseCurve !== false) {
      // 松手后的轻微漂移
      await sleep(30 + Math.random() * 40);
      await this.#moveTo(px + (Math.random() * 6 - 3), py + (Math.random() * 6 - 3), { steps: 2 });
    }
  }

  async #clickAt(state) {
    await this.#mouseClickAt(state.x, state.y);
  }

  /** 每轮结束把输入框清空；键盘清不掉时用原生 setter + input 事件兜底 */
  async #clearInput() {
    if (!this.page || this.page.isClosed() || !this.cdp) return;
    try {
      const st = await this.page.evaluate(() => window.__HYBRID__?.inputState?.() || null);
      if (!st?.value) return;
      await this.page.evaluate(() => window.__HYBRID__.focusInput());
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        commands: ['selectAll'],
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        commands: ['deleteBackward'],
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
      });
      await sleep(50);
      const after = await this.page.evaluate(() => window.__HYBRID__?.inputState?.() || null);
      if (after?.value) await this.page.evaluate(() => window.__HYBRID__.setInputValue(''));
    } catch {
      /* 页面可能已经关闭 */
    }
  }

  /* ------------------------------------------------------------------ *
   * 补全流解析辅助（真正的增量捕获在 hybrid/stream-capture.mjs）
   * ------------------------------------------------------------------ */

  /** 把一段完整 body 解析成 stream state，用来取 usage/finish_reason 等元数据 */
  #parseBodyState(body) {
    if (!body) return null;
    const state = createStreamState();
    try {
      const parser = createSseParser((payload, event) => {
        if (event === 'hint') return;
        try {
          applyPatch(state, payload);
        } catch {
          /* 坏补丁忽略 */
        }
      });
      parser.push(body);
      parser.flush();
    } catch {
      return null;
    }
    return state;
  }

  /** 401/403/429 一律按仓库统一语义抛出；403 风控/验证码页立即停 */
  #classifyStatus(entry) {
    if (!entry.status) return;
    if (entry.status === 401 || entry.status === 403) {
      this.#recordEvidence({
        step: 'completion',
        status: entry.status,
        contentType: entry.contentType,
        text: entry.value,
      });
      if (
        entry.status === 403 &&
        (/text\/html/i.test(entry.contentType) || /验证|风控|captcha|challenge/i.test(entry.value))
      ) {
        throw new CaptchaError('DeepSeek 返回了风控/验证码页面（hybrid），已停止且不再重试');
      }
      this.loginRequired = true;
      throw new AuthExpiredError('hybrid：登录态被上游拒绝（401/403），需要重新登录 chat.deepseek.com');
    }
    if (entry.status === 429 || /频繁|rate limit/i.test(entry.value)) {
      this.#recordEvidence({
        step: 'completion',
        status: entry.status,
        contentType: entry.contentType,
        text: entry.value,
      });
      throw new RateLimitError();
    }
  }

  /** 只有失败路径才读页面状态，用来区分「验证码 / 限流提示 / 页面忙」 */
  async #checkUiBlockers({ soft = false } = {}) {
    let probe = null;
    try {
      probe = await this.page?.evaluate(() => ({
        captcha: window.__HYBRID__?.captcha?.() ?? false,
        rateLimited: window.__HYBRID__?.rateLimited?.() ?? false,
        notice: window.__HYBRID__?.notice?.() ?? '',
      }));
    } catch {
      return;
    }
    if (!probe) return;
    if (probe.captcha) throw new CaptchaError();
    if (probe.rateLimited) throw new RateLimitError();
    if (probe.notice && /过长|too long/i.test(probe.notice)) throw new PromptTooLongError(probe.notice);
    if (!soft && probe.notice && /正在生成|稍后再试/i.test(probe.notice)) {
      throw new UpstreamError(`页面提示：${probe.notice}`, { code: 'page_busy' });
    }
  }

  async #clickStopIfBusy() {
    try {
      const st = await this.#buttonState();
      if (st?.found && st.isStop) await this.#clickAt(st);
    } catch {
      /* 页面可能已关闭 */
    }
  }

  /* ------------------------------------------------------------------ *
   * 请求指纹（脱敏）
   * ------------------------------------------------------------------ */

  #recordTraceFromCapture(trace) {
    const requestHeaders = trace.requestHeaders || {};
    const responseHeaders = trace.headers || {};
    const cookieHeader = requestHeaders.cookie || '';
    const cookieNames = cookieHeader
      ? cookieHeader
          .split(';')
          .map((part) => part.trim().split('=')[0])
          .filter(Boolean)
      : [];
    const presence = {};
    for (const name of MUTED_HEADER_NAMES) {
      presence[name] = Boolean(requestHeaders[name]) || Boolean(responseHeaders[name]);
    }
    const ua = requestHeaders['user-agent'] || '';
    const chromeVersion = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || null;
    const headerNames = Object.keys(requestHeaders);

    this.lastTrace = {
      url: trace.url,
      status: trace.status,
      contentType: responseHeaders['content-type'] || '',
      headerNames,
      headerCount: headerNames.length,
      rawOrder: trace.rawOrder || this.lastRequestOrder || null,
      presence,
      cookieNames,
      chromeVersion,
      initiator: this.lastInitiator || null,
      source: trace.source,
    };
    this.log.info('hybrid 请求指纹（脱敏）', {
      status: this.lastTrace.status,
      headerCount: this.lastTrace.headerCount,
      chromeVersion,
      cookie: presence.cookie,
      cookieNames,
      'sec-fetch-site': presence['sec-fetch-site'],
      priority: presence.priority,
      'x-ds-pow-response': presence['x-ds-pow-response'],
      'x-hif-leim': presence['x-hif-leim'],
      initiator: this.lastInitiator?.type || null,
      initiatorUrl: this.lastInitiator?.topUrl || null,
      source: trace.source,
    });
  }

  #recordEvidence({ step, status, contentType, message, text }) {
    this.lastEvidence = {
      step,
      status,
      contentType,
      looksLikeHtml: /text\/html/i.test(contentType) || /^\s*</.test(String(text || '')),
      looksLikeCaptcha:
        /验证|captcha|challenge|风控/i.test(String(text || '')) ||
        /验证|captcha|风控/i.test(String(message || '')),
      message: message || null,
      at: new Date().toISOString(),
    };
    this.log.warn('hybrid 上游拒绝（脱敏证据）', this.lastEvidence);
  }

  #hintMessage(analysis) {
    const hint = analysis?.hints?.find((entry) => entry?.content);
    return hint?.content || '';
  }

  /* ------------------------------------------------------------------ *
   * 页面 SDK（只在浏览器里跑）
   * ------------------------------------------------------------------ */

  async #ensureProbe() {
    if (!this.page || this.page.isClosed()) {
      throw new UpstreamError('hybrid：页面已关闭', { code: 'hybrid_page_gone' });
    }
    try {
      await this.page.evaluate(installHybridHelpers);
    } catch (err) {
      this.page = null;
      this.cdp = null;
      throw new UpstreamError(`hybrid：注入页面探针失败：${err.message}`, { code: 'hybrid_page_failed' });
    }
  }
}

/* -------------------------------------------------------------------- *
 * 行为层的纯函数（可单测，不依赖浏览器）
 * -------------------------------------------------------------------- */

/**
 * hybrid 独立 profile 的启动参数（瘦身版）。
 * 只保留「不改变页面可观测特征」的项：
 *   --disable-gpu                      只影响渲染/合成，UA/navigator/JS API 不变
 *   --no-first-run / --no-default-browser-check  只影响浏览器 UI 首次引导
 *   --disable-blink-features=AutomationControlled 让 navigator.webdriver 与真实浏览器一致（更接近官网）
 * Linux 额外 no-sandbox / disable-dev-shm-usage：只影响沙箱与共享内存，页面不可见。
 * 明确不设置：--user-agent（会改 UA）、--disable-web-security（改 JS 安全特征）、
 *             --disable-extensions（可能影响插件相关特征）。
 */
export function hybridLaunchArgs(platform = process.platform) {
  const args = [
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ];
  if (platform !== 'win32') args.push('--no-sandbox', '--disable-dev-shm-usage');
  return args;
}

export function isCjk(ch) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
}

const PINYIN_SYLLABLES = [
  'ni', 'hao', 'zhong', 'guo', 'shi', 'jie', 'ma', 'qing', 'wen', 'xie',
  'kuai', 'le', 'wo', 'men', 'ta', 'de', 'zai', 'ne', 'ba', 'a',
];

/** 用字码派生一个「看起来像拼音」的候选串：真实 IME 敲的是拼音，这里只关心事件序列 */
export function fakePinyin(word) {
  let out = '';
  for (const ch of word) {
    out += PINYIN_SYLLABLES[(ch.codePointAt(0) || 0) % PINYIN_SYLLABLES.length];
  }
  return out;
}

const KEY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

export function wrongCharFor(ch, rand = Math.random) {
  const lower = String(ch).toLowerCase();
  for (const row of KEY_ROWS) {
    const idx = row.indexOf(lower);
    if (idx >= 0) {
      const next = rand() < 0.5 ? Math.max(0, idx - 1) : Math.min(row.length - 1, idx + 1);
      const wrong = row[next];
      if (wrong !== lower) return wrong;
    }
  }
  return lower === 'x' ? 'z' : 'x';
}

/**
 * 非线性的字间停顿：基础抖动 + 词/句边界停顿 + 偶发连打。
 * rhythm=false 时退化为固定基础间隔（用于对照实验）。
 */
export function charDelayMs({ baseMs = 45, rhythm = true, ch = '', prev = '', rand = Math.random } = {}) {
  if (!rhythm) return baseMs ? Math.round(baseMs + rand() * baseMs * 0.5) : 0;
  let ms = baseMs * (0.45 + rand() * 0.95);
  if (ch === ' ') ms += 80 + rand() * 140;
  if (/[，,。.！!？?；;：:]/.test(ch)) ms += 260 + rand() * 520;
  if (/[，,。.！!？?；;：:]/.test(prev) && /\S/.test(ch)) ms += 80 + rand() * 160;
  if (rand() < 0.12) ms *= 0.45; // 偶发连打
  return Math.max(8, Math.round(ms));
}

/**
 * 把一段文本规划成输入动作序列（纯函数）。
 * 动作：{kind:'key'|'enter'|'backspace'|'ime'|'sleep', ...}
 */
export function planTyping(text, { baseMs = 45, rhythm = true, typoRate = 0.015, ime = true, rand = Math.random } = {}) {
  const actions = [];
  const pushDelay = (ms) => {
    if (ms > 0) actions.push({ kind: 'sleep', ms: Math.round(ms) });
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      actions.push({ kind: 'enter' });
      if (rhythm) pushDelay(280 + rand() * 420);
      i += 1;
      continue;
    }

    if (ime && isCjk(ch)) {
      let j = i;
      while (j < text.length && isCjk(text[j]) && j - i < 3) j += 1;
      const word = text.slice(i, j);
      actions.push({ kind: 'ime', word });
      if (rhythm) pushDelay(80 + word.length * 25 + rand() * 140);
      i = j;
      continue;
    }

    if (rhythm && typoRate > 0 && rand() < typoRate && /[a-z0-9]/i.test(ch)) {
      actions.push({ kind: 'key', char: wrongCharFor(ch, rand), typo: true });
      pushDelay(120 + rand() * 250);
      actions.push({ kind: 'backspace' });
      pushDelay(80 + rand() * 160);
    }

    actions.push({ kind: 'key', char: ch });
    pushDelay(charDelayMs({ baseMs, rhythm, ch, prev: text[i - 1] || '', rand }));
    i += 1;
  }
  return actions;
}

function cubicPoint(start, p1, p2, end, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * start.x + b * p1.x + c * p2.x + d * end.x,
    y: a * start.y + b * p1.y + c * p2.y + d * end.y,
  };
}

/**
 * 三次贝塞尔鼠标轨迹：中途加减速（ease-in-out）、垂直方向弓形、轻微抖动。
 * 返回 [{x,y,delay}]，最后一个点严格等于目标坐标。
 */
export function bezierPath(start, end, { steps, rand = Math.random } = {}) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  const n = steps
    ? Math.max(1, Math.round(steps))
    : Math.min(28, Math.max(8, Math.round(dist / 22)));
  const nx = dist ? -dy / dist : 0;
  const ny = dist ? dx / dist : 0;
  const bow1 = rand() * 80 - 40;
  const bow2 = rand() * 60 - 30;
  const p1 = { x: start.x + dx * 0.3 + nx * bow1, y: start.y + dy * 0.3 + ny * bow1 };
  const p2 = { x: start.x + dx * 0.7 + nx * bow2, y: start.y + dy * 0.7 + ny * bow2 };

  const points = [];
  let px = Math.round(start.x);
  let py = Math.round(start.y);
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * t); // 起步快、收尾慢
    const raw = cubicPoint(start, p1, p2, end, eased);
    const x = i === n ? Math.round(end.x) : Math.round(raw.x + (rand() * 3 - 1.5));
    const y = i === n ? Math.round(end.y) : Math.round(raw.y + (rand() * 3 - 1.5));
    if (i < n && x === px && y === py) continue;
    points.push({ x, y, delay: Math.round(6 + 16 * eased + rand() * 6) });
    px = x;
    py = y;
  }
  if (!points.length || points[points.length - 1].x !== Math.round(end.x) || points[points.length - 1].y !== Math.round(end.y)) {
    points.push({ x: Math.round(end.x), y: Math.round(end.y), delay: 8 });
  }
  return points;
}

/* -------------------------------------------------------------------- *
 * 页面内探针：只读 DOM 状态 + 事件计数，不改值（setInputValue 仅作兜底）
 * -------------------------------------------------------------------- */

function installHybridHelpers() {
  if (window.__HYBRID__ && window.__HYBRID__.version >= 2) return;

  const SEL = { input: 'textarea', send: '.ds-button--primary.ds-button--circle' };
  const STOP_PREFIX = 'M2 4.88';

  const isVisible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const composerRoot = () => {
    const input = document.querySelector(SEL.input);
    if (!input) return null;
    let el = input.parentElement;
    for (let i = 0; i < 6 && el; i += 1, el = el.parentElement) {
      if (el.querySelector('.ds-button--primary.ds-button--circle')) return el;
    }
    return null;
  };

  const sendButton = () => {
    const root = composerRoot() || document;
    return root.querySelector('.ds-button--primary.ds-button--circle');
  };

  const buttonState = () => {
    const btn = sendButton();
    const input = document.querySelector(SEL.input);
    if (!btn) return { found: false, value: input ? input.value : '' };
    const cls = btn.getAttribute('class') || '';
    const disabled =
      Boolean(btn.disabled) ||
      btn.getAttribute('aria-disabled') === 'true' ||
      /ds-button--disabled|disabled/i.test(cls);
    const isStop = Array.from(btn.querySelectorAll('svg path')).some((path) =>
      (path.getAttribute('d') || '').trim().startsWith(STOP_PREFIX),
    );
    const rect = btn.getBoundingClientRect();
    return {
      found: true,
      disabled,
      isStop,
      value: input ? input.value : '',
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      w: rect.width,
      h: rect.height,
    };
  };

  const inputState = () => {
    const input = document.querySelector(SEL.input);
    return input
      ? { value: input.value, focused: document.activeElement === input, visible: isVisible(input) }
      : null;
  };

  const inputBox = () => {
    const input = document.querySelector(SEL.input);
    if (!input || !isVisible(input)) return null;
    const rect = input.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };

  const composerState = () => {
    const state = inputState();
    return { inputVisible: Boolean(state?.visible), inputValue: state?.value || '', url: location.href };
  };

  const conversationState = () => ({
    assistantCount: document.querySelectorAll('.ds-assistant-message-main-content').length,
    inputVisible: Boolean(inputState()?.visible),
  });

  const clickByTexts = (labels) => {
    const nodes = document.querySelectorAll(
      'button, a, [role="button"], [role="menuitem"], [class*="button"], div, span',
    );
    for (const label of labels.map((text) => text.trim())) {
      const matches = [];
      for (const el of nodes) {
        const text = (el.innerText || '').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        if (text !== label && aria !== label) continue;
        if (!isVisible(el)) continue;
        matches.push(el);
      }
      if (!matches.length) continue;
      matches.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      matches[0].click();
      return true;
    }
    return false;
  };

  const toggleState = (label) => {
    for (const el of document.querySelectorAll('.ds-toggle-button')) {
      if (!(el.innerText || '').includes(label)) continue;
      return { found: true, selected: el.classList.contains('ds-toggle-button--selected') };
    }
    return { found: false, selected: false };
  };

  const clickToggle = (label) => {
    for (const el of document.querySelectorAll('.ds-toggle-button')) {
      if ((el.innerText || '').includes(label) && isVisible(el)) {
        el.click();
        return true;
      }
    }
    return false;
  };

  const bodyText = () => (document.body ? document.body.innerText || '' : '');

  const captcha = () =>
    Boolean(document.querySelector('.ds-shumei-captcha-error__message')) ||
    Boolean(document.querySelector('[class*="shumei" i] [class*="captcha" i]')) ||
    /人机验证|请完成验证|请先完成下方验证|拖动滑块|verify you are human/i.test(bodyText());

  const notice = () => {
    for (const node of document.querySelectorAll('[role="alert"], [class*="toast" i], [class*="notification" i]')) {
      const text = (node.innerText || '').trim();
      if (text) return text.slice(0, 300);
    }
    return '';
  };

  const rateLimited = () => /(发送|请求|操作)过于频繁|连续访问次数过多/.test(bodyText());

  const identity = () => {
    const read = (key) => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return '';
        const parsed = JSON.parse(raw);
        return typeof parsed === 'string' ? parsed : String(parsed?.value || '');
      } catch {
        return '';
      }
    };
    let deviceId = '';
    try {
      deviceId =
        localStorage.getItem('deepseek-device-id:chat') ||
        localStorage.getItem('__ds_remote_feature_did') ||
        '';
    } catch {
      /* ignore */
    }
    return { signedIn: Boolean(read('userToken')), deviceId };
  };

  const focusInput = () => {
    const input = document.querySelector(SEL.input);
    if (!input) return false;
    input.focus();
    return document.activeElement === input;
  };

  /** 兜底：原生 setter + input 事件，React 受控组件能感知到 */
  const setInputValue = (text) => {
    const input = document.querySelector(SEL.input);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value === text;
  };

  const EVENTS = [
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'click',
    'mousedown',
    'mouseup',
    'mousemove',
    'pointermove',
    'pointerdown',
    'pointerup',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'select',
    'paste',
  ];
  const counts = {};
  const sequence = [];
  for (const type of EVENTS) {
    counts[type] = 0;
    document.addEventListener(
      type,
      () => {
        counts[type] += 1;
        if (sequence.length < 80) sequence.push(type);
      },
      true,
    );
  }
  const probe = {
    counts,
    sequence,
    reset() {
      for (const type of EVENTS) counts[type] = 0;
      sequence.length = 0;
    },
    snapshot() {
      return { counts: { ...counts }, sequence: sequence.slice() };
    },
  };

  window.__HYBRID__ = {
    version: 2,
    identity,
    composerRoot,
    sendButton,
    buttonState,
    inputState,
    inputBox,
    composerState,
    conversationState,
    clickByTexts,
    toggleState,
    clickToggle,
    captcha,
    notice,
    rateLimited,
    focusInput,
    setInputValue,
    probe,
  };
}

/* -------------------------------------------------------------------- *
 * 纯函数
 * -------------------------------------------------------------------- */

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

/** 只保留 initiator 的类型与脚本位置，去掉查询串（避免带出一次性参数） */
export function sanitizeInitiator(initiator, baseUrl = '') {
  if (!initiator) return null;
  const frames = [];
  const stack = initiator.stack;
  if (stack?.callFrames?.length) {
    for (const frame of stack.callFrames.slice(0, 5)) {
      frames.push({
        functionName: frame.functionName || '',
        url: String(frame.url || '').split('?')[0].split('#')[0],
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
      });
    }
  } else if (stack?.parent) {
    frames.push({
      functionName: '',
      url: String(stack.parent.url || '').split('?')[0],
      lineNumber: stack.parent.lineNumber,
      columnNumber: stack.parent.columnNumber,
    });
  }
  const topUrl = frames[0]?.url || '';
  const pageHost = baseUrl ? safeHost(baseUrl) : 'chat.deepseek.com';
  // 页面自己的脚本可能来自静态域（fe-static.deepseek.com），同一站点也算页面脚本
  const scriptHost = safeHost(topUrl);
  const pageScript = Boolean(
    scriptHost && (scriptHost === pageHost || scriptHost.endsWith('.deepseek.com')),
  );
  return {
    type: initiator.type || 'unknown',
    frames,
    topUrl: topUrl || null,
    pageScript,
  };
}

/**
 * 从多段补全 body 里挑一段用于「逐帧回放」。
 * 权威文本由 parseCompletionBodies 选出；这里挑与它文本一致的那段（同分取后到的）。
 */
export function chooseBodyForReplay(bodies, analysis) {
  if (!bodies?.length) return '';
  const target = analysis?.text || '';
  const targetReasoning = analysis?.reasoning || '';
  let picked = bodies[bodies.length - 1];
  for (const body of bodies) {
    const state = createStreamState();
    try {
      const parser = createSseParser((payload, event) => {
        if (event === 'hint') return;
        try {
          applyPatch(state, payload);
        } catch {
          /* 坏补丁忽略 */
        }
      });
      parser.push(body);
      parser.flush();
    } catch {
      continue;
    }
    if (target ? contentOf(state) === target : reasoningOf(state) === targetReasoning) picked = body;
  }
  return picked;
}

/** 可打印字符 → CDP keyDown 需要的键位信息；中文/emoji 返回 null（走 insertText） */
export function keyInfoForChar(ch) {
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, modifiers: 0 };
  if (ch >= 'a' && ch <= 'z') {
    return { key: ch, code: `Key${ch.toUpperCase()}`, vk: 65 + ch.charCodeAt(0) - 97, modifiers: 0 };
  }
  if (ch >= 'A' && ch <= 'Z') {
    return { key: ch, code: `Key${ch}`, vk: 65 + ch.charCodeAt(0) - 65, modifiers: 8 };
  }
  if (ch >= '0' && ch <= '9') {
    return { key: ch, code: `Digit${ch}`, vk: 48 + ch.charCodeAt(0) - 48, modifiers: 0 };
  }
  const map = {
    '-': ['Minus', 189, 0],
    '=': ['Equal', 187, 0],
    '[': ['BracketLeft', 219, 0],
    ']': ['BracketRight', 221, 0],
    '\\': ['Backslash', 220, 0],
    ';': ['Semicolon', 186, 0],
    "'": ['Quote', 222, 0],
    ',': ['Comma', 188, 0],
    '.': ['Period', 190, 0],
    '/': ['Slash', 191, 0],
    '`': ['Backquote', 192, 0],
    '!': ['Digit1', 49, 8],
    '@': ['Digit2', 50, 8],
    '#': ['Digit3', 51, 8],
    $: ['Digit4', 52, 8],
    '%': ['Digit5', 53, 8],
    '^': ['Digit6', 54, 8],
    '&': ['Digit7', 55, 8],
    '*': ['Digit8', 56, 8],
    '(': ['Digit9', 57, 8],
    ')': ['Digit0', 48, 8],
    _: ['Minus', 189, 8],
    '+': ['Equal', 187, 8],
    '{': ['BracketLeft', 219, 8],
    '}': ['BracketRight', 221, 8],
    '|': ['Backslash', 220, 8],
    ':': ['Semicolon', 186, 8],
    '"': ['Quote', 222, 8],
    '<': ['Comma', 188, 8],
    '>': ['Period', 190, 8],
    '?': ['Slash', 191, 8],
    '~': ['Backquote', 192, 8],
  };
  const entry = map[ch];
  if (!entry) return null;
  return { key: ch, code: entry[0], vk: entry[1], modifiers: entry[2] };
}
