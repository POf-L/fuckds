import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ------------------------------------------------------------------ *
 * 极简 .env 加载（不引入 dotenv，减少依赖）
 * ------------------------------------------------------------------ */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const str = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value).trim());

const num = (value, fallback) => {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/* ------------------------------------------------------------------ *
 * 登录态：环境变量 > data/auth.json
 * ------------------------------------------------------------------ */
function readTokenFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = [];
    if (Array.isArray(parsed?.tokens)) list.push(...parsed.tokens);
    if (typeof parsed?.token === 'string') list.push(parsed.token);
    return list.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    /* 文件不存在或损坏都忽略，交给调用方提示 */
  }
  return [];
}

function resolveTokens(env, authFile) {
  const fromEnv = [];
  for (const key of ['DEEPSEEK_USER_TOKENS', 'DEEPSEEK_USER_TOKEN']) {
    const raw = env[key];
    if (!raw) continue;
    fromEnv.push(
      ...String(raw)
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }
  const list = fromEnv.length ? fromEnv : readTokenFile(authFile);
  return [...new Set(list)];
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(ROOT, expandHome(str(env.DATA_DIR, 'data')));
  fs.mkdirSync(dataDir, { recursive: true });
  const authFile = path.join(dataDir, 'auth.json');

  const tokens = resolveTokens(env, authFile);
  const token = tokens[0] || '';

  const baseUrl = str(env.DEEPSEEK_BASE_URL, 'https://chat.deepseek.com').replace(/\/+$/, '');

  return {
    rootDir: ROOT,
    dataDir,
    authFile,
    logLevel: str(env.LOG_LEVEL, 'info'),
    server: {
      host: str(env.HOST, '127.0.0.1'),
      port: int(env.PORT, 8787),
      apiKey: str(env.API_KEY),
      cors: str(env.CORS_ORIGIN, '*'),
    },
    // 默认 auto：有协议凭据先走 protocol（纯 HTTP，不拉起浏览器），否则 direct / browser
    engine: str(env.ENGINE, 'auto'),
    // 上送 prompt 前的协议标签清洗（网页端会把 XML 协议标签当风控信号）
    sanitize: {
      // 客户端 tools / tool_choice 默认**保留并渲染**进 prompt（纯文本协议，见
      // src/prompt/text-protocol.mjs），这样 agent / 多步工具调用才能闭环。
      // 只有显式 STRIP_CLIENT_TOOLS=true 才丢弃（纯聊天、压缩上下文的实验模式）。
      stripClientTools: bool(env.STRIP_CLIENT_TOOLS, false),
      // 对 system / user / assistant / 工具结果 / 附件名做 XML 协议标签清洗
      markup: bool(env.SANITIZE_MARKUP, true),
      // 上送前自检：拼好的 prompt 里一旦仍有协议标签就拒绝发送（不静默带出）
      rejectOnHit: bool(env.SANITIZE_REJECT_ON_HIT, true),
    },
    direct: {
      powBin: path.resolve(ROOT, expandHome(str(env.POW_BIN, 'bin/ds-pow'))),
    },
    // 协议优先通道（ENGINE=protocol）：Node 直接发 HTTPS，不常驻浏览器。
    // 凭据（cookie / token / x-hif 缓存）从 hybrid profile 采集后落盘，按需刷新。
    protocol: {
      credentialsFile: path.resolve(
        ROOT,
        expandHome(str(env.PROTOCOL_CREDENTIALS_FILE, path.join(dataDir, 'protocol-credentials.json'))),
      ),
      // 多账号：目录下每个 *.json 是一份凭据（= 一个账号，一个独立 DirectEngine）
      accountsDir: path.resolve(ROOT, expandHome(str(env.PROTOCOL_ACCOUNTS_DIR, path.join(dataDir, 'protocol-accounts')))),
      // 请求失败且证据指向凭据失效时，尝试“静默刷新”一次再重试。
      // 默认开启：只复用**已经存在的** profile 浏览器实例（connectOverCDP），绝不新开窗口；
      // 没有活实例时直接返回 401 + nextAction，不会为了刷新拉起浏览器。
      refreshOnAuthFail: bool(env.PROTOCOL_REFRESH_ON_AUTH_FAIL, true),
      // 同一账号刷新节流：默认 60s 内最多刷新一次，避免刷新风暴
      refreshMinIntervalMs: int(env.PROTOCOL_REFRESH_MIN_INTERVAL_MS, 60_000),
      // 刷新后仍失败，是否降级到 hybrid 全浏览器
      // 默认关闭：降级同样会拉起浏览器，失败时直接返回 401 + nextAction
      fallbackToHybrid: bool(env.PROTOCOL_FALLBACK_HYBRID, false),
      // 策略闸门：任何“自动启动浏览器（采集/刷新凭据）”都必须显式授权。
      // 只有用户手动执行 npm run auth:hybrid 才能复用登录 profile。
      allowBrowserRefresh: bool(env.ALLOW_BROWSER_REFRESH, false),
      // 采集凭据时页面停留时间（给风控 SDK 写 hif 缓存的余量）
      harvestWaitMs: int(env.PROTOCOL_HARVEST_WAIT_MS, 2500),
      // token 年龄硬阈值：**仅告警**（credentialAgeWarn=true），不再拦截派发。
      // 真实上游会话实测可活 ~13h，按 8h 一刀切会误杀可用凭据；是否失效以上游 401 为准。
      tokenMaxAgeMs: int(env.PROTOCOL_TOKEN_MAX_AGE_MS, 8 * 60 * 60 * 1000),
      // token 年龄软阈值：超过标 stale（仍可派发，仅提示尽快更新）
      tokenStaleAgeMs: int(env.PROTOCOL_TOKEN_STALE_AGE_MS, 6 * 60 * 60 * 1000),
    },
    // 轻量浏览器传输引擎（ENGINE=light）：网络请求由浏览器自己发出，
    // Node 只负责 PoW 求解与 SSE 补丁渲染。
    light: {
      // 复用一台已经打开 chat.deepseek.com 的浏览器（Chrome/Edge 远程调试端口）
      cdpUrl: str(env.LIGHT_CDP_URL, ''),
      // 或：用持久化用户目录启动 headless Chromium（需先在该目录里登录过一次）
      profileDir: expandHome(str(env.LIGHT_PROFILE_DIR, '')),
      // profile 模式可用 Playwright storageState（cookies + localStorage）注入登录态
      storageState: expandHome(str(env.LIGHT_STORAGE_STATE, '')),
      headless: bool(env.LIGHT_HEADLESS, true),
      executablePath: str(env.LIGHT_EXECUTABLE, '') || str(env.CHROMIUM_EXECUTABLE, ''),
      navigationTimeoutMs: int(env.LIGHT_NAV_TIMEOUT_MS, 60_000),
      // 自动重连：最大尝试次数与总时限（指数退避，避免高频重连）
      reconnectMaxAttempts: int(env.LIGHT_RECONNECT_MAX, 5),
      reconnectTotalMs: int(env.LIGHT_RECONNECT_TOTAL_MS, 30_000),
    },
    // 混合引擎（ENGINE=hybrid）：用真实键鼠事件驱动页面 UI，让页面自己发请求；
    // 回复仍取自页面原生的 completion SSE，不做 DOM 文本轮询。
    //
    // 资源策略：默认使用独立的有头 profile（data/hybrid-profile），不碰用户日常浏览器，
    // 也不默认连 127.0.0.1:9222；只有显式设置 HYBRID_CDP_URL 才复用外部实例。
    // 空闲到点自动关闭浏览器释放内存，登录态留在 profile 目录，下个请求冷启动。
    hybrid: {
      cdpUrl: str(env.HYBRID_CDP_URL, ''),
      profileDir: expandHome(str(env.HYBRID_PROFILE_DIR, '')) || path.join(dataDir, 'hybrid-profile'),
      storageState: expandHome(str(env.HYBRID_STORAGE_STATE, '')),
      // 有头更接近真实用户（页面可观测特征不被 headless 化）；无显示环境可显式关掉
      headless: bool(env.HYBRID_HEADLESS, false),
      // 独立 profile 优先用系统 Edge（UA/JS 特征与用户日常浏览器一致），失败再回退 Playwright Chromium
      channel: str(env.HYBRID_CHANNEL, process.platform === 'win32' ? 'msedge' : ''),
      executablePath: str(env.HYBRID_EXECUTABLE, '') || str(env.CHROMIUM_EXECUTABLE, ''),
      navigationTimeoutMs: int(env.HYBRID_NAV_TIMEOUT_MS, 60_000),
      reconnectMaxAttempts: int(env.HYBRID_RECONNECT_MAX, 5),
      reconnectTotalMs: int(env.HYBRID_RECONNECT_TOTAL_MS, 30_000),
      // 空闲关闭（毫秒）：与 browser 引擎的 15 分钟一致；0 = 不关闭
      idleCloseMs: int(env.HYBRID_IDLE_CLOSE_MS, 15 * 60_000),
      // 固定单页面；并发请求排队，超过上限立即 429（不无限堆积）
      queueLimit: int(env.HYBRID_QUEUE_LIMIT, 8),
      // incremental：CDP Network.streamResourceContent + dataReceived 逐块推送；
      // batch：等 body 收完再整体回放（仅用于对照实验）
      streamMode: /^batch$/i.test(str(env.HYBRID_STREAM_MODE, '')) ? 'batch' : 'incremental',
      // 逐字输入的基础停顿（毫秒）。默认走快速档：仍然逐字产生真实 keydown/keyup/input，
      // 但不再为了「像人」而人为拖慢。
      typingDelayMs: int(env.HYBRID_TYPING_DELAY_MS, 6),
      typeSampleChars: int(env.HYBRID_TYPE_SAMPLE_CHARS, 80),
      // 拟人化装饰：默认全关（没有证据表明这些能降低风控，且会把长 prompt 拖到几十秒）。
      // 代码保留，需要对照实验时显式打开。
      typingRhythm: bool(env.HYBRID_TYPING_RHYTHM, false),
      ime: bool(env.HYBRID_IME, false),
      mouseCurve: bool(env.HYBRID_MOUSE_CURVE, false),
      typoRate: num(env.HYBRID_TYPO_RATE, 0),
      // 每轮是否先点「新对话」（保持「一条请求 = 一次全新对话」的语义）
      newChat: bool(env.HYBRID_NEW_CHAT, true),
      // 两次发送之间的最小间隔复用 runtime.sendIntervalMs
    },
    deepseek: {
      baseUrl,
      token,
      tokens,
      // always: 打开网页上的「深度思考」（默认）；auto: 按模型名；never: 关闭
      thinking: str(env.DEEPSEEK_THINKING, 'always'),
      search: bool(env.DEEPSEEK_SEARCH, false),
      // 是否主动把网页上的「深度思考 / 智能搜索」开关拨到请求要求的状态
      manageToggles: bool(env.DEEPSEEK_MANAGE_TOGGLES, true),
      defaultModel: str(env.DEFAULT_MODEL, 'deepseek-flash'),
      // 设备画像：chrome-win（桌面 Chrome）/ chrome-android（移动 Chrome）。
      // 一旦选定就长期固定，别来回切，否则会被识别成「设备漂移」。
      deviceProfile: str(env.DEEPSEEK_DEVICE_PROFILE, 'chrome-win'),
      // 冷启动序列：拉配置 / 设备校验 / 配置回执，让账号有「网页打开过」的痕迹
      coldStart: bool(env.DEEPSEEK_COLD_START, true),
      // 行为时序伪装：PoW 耗时不那么快、发送前有输入停顿
      humanTiming: bool(env.DEEPSEEK_HUMAN_TIMING, true),
      modelAliases: {
        'deepseek-flash': { thinking: false },
        'deepseek-v3': { thinking: false },
        'deepseek-web': { thinking: false },
        'deepseek-reasoner': { thinking: true },
        'deepseek-r1': { thinking: true },
      },
    },
    browser: {
      headless: bool(env.BROWSER_HEADLESS, true),
      executablePath: str(env.CHROMIUM_EXECUTABLE) || '',
      // 无 root 环境下，把 .deb 解包到本地目录，通过 LD_LIBRARY_PATH 供 Chromium 使用
      depsDir: expandHome(str(env.CHROMIUM_DEPS_DIR, path.join(os.homedir(), '.local', 'chromium-deps'))),
      userAgent: str(
        env.BROWSER_USER_AGENT,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
      viewport: {
        width: int(env.BROWSER_WIDTH, 1440),
        height: int(env.BROWSER_HEIGHT, 900),
      },
      locale: str(env.BROWSER_LOCALE, 'zh-CN'),
      slowMo: int(env.BROWSER_SLOW_MO, 0),
      launchArgs: str(env.BROWSER_ARGS)
        .split(/\s+/)
        .filter(Boolean),
      navigationTimeoutMs: int(env.BROWSER_NAV_TIMEOUT_MS, 60_000),
    },
    runtime: {
      concurrency: Math.max(1, int(env.CONCURRENCY, 1)),
      queueLimit: int(env.QUEUE_LIMIT, 64),
      requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 240_000),
      pollIntervalMs: int(env.POLL_INTERVAL_MS, 60),
      // 文本稳定多久算生成结束（毫秒）
      settleMs: int(env.SETTLE_MS, 800),
      // 两次发送之间的最小间隔：账号级限流，太密会触发「发送过于频繁」
      // 浏览器引擎需要更保守（网页有「发送过于频繁」），直连可以快很多
      sendIntervalMs: int(env.SEND_INTERVAL_MS, 4000),
      // 直连不做发送间隔（限流是「窗口内条数」，靠号池绕），保留开关以便需要时限制
      directSendIntervalMs: int(env.DIRECT_SEND_INTERVAL_MS, 0),
      // 账号被限流后的冷却时间，以及请求最多愿意等多久
      accountCooldownMs: int(env.ACCOUNT_COOLDOWN_MS, 60_000),
      maxCooldownWaitMs: int(env.MAX_COOLDOWN_WAIT_MS, 5_000),
      // 上游「user is muted」的账号冷却。实测 00:30 首次禁言后，00:45（15 分钟）
      // 仍然禁言；10 分钟会过早探测一次，故默认 15 分钟。
      mutedCooldownMs: int(env.MUTED_COOLDOWN_MS, 15 * 60_000),
      // 单账号最小请求间隔（毫秒）：在「单账号串行」之外再加一层节奏限制。
      // 实测 2026-11-04 19:28：间隔中位数 2.2s、峰值 27 条/97s（≈3.6s 平均）时
      // 触发 429。默认 8000 把稳态压到 ≤7.5 条/分钟，约为失败阈值的 1/2；
      // 设 0 可关闭（不建议）。
      accountMinGapMs: int(env.ACCOUNT_MIN_GAP_MS, 8_000),
      // 工具长任务（本次请求带 tools）的单账号最小间隔，独立于普通对话。
      // 8s 节拍下工具轮峰值实测 6 条/分钟；15s 把理论上限压到 4 条/分钟，
      // 与实测 429 阈值（11 条/分钟）留出约 2.75 倍余量。普通对话仍用 accountMinGapMs。
      toolMinGapMs: int(env.ACCOUNT_TOOL_MIN_GAP_MS, 15_000),
      // 首段正文最多等多久思考内容（毫秒），保证 reasoning 一定排在 content 前面
      reasoningHoldMs: int(env.REASONING_HOLD_MS, 900),
      rateLimitBackoffMs: int(env.RATE_LIMIT_BACKOFF_MS, 4000),
      firstTokenTimeoutMs: int(env.FIRST_TOKEN_TIMEOUT_MS, 90_000),
      idleShutdownMs: int(env.IDLE_SHUTDOWN_MS, 15 * 60_000),
      // 启动时就把浏览器拉起来，省掉第一次请求的 2~3 秒
      warmup: bool(env.WARMUP, true),
      saveArtifacts: bool(env.SAVE_ARTIFACTS, true),
      // 网页输入框单次上限；超过就把较早的上下文拆成附件
      maxPromptChars: int(env.MAX_PROMPT_CHARS, 100_000),
      // 附件注入：拆分出去的上下文最多多少字符（按 3 字节/字的 UTF-8 也远小于上传上限）
      maxAttachmentChars: int(env.MAX_ATTACHMENT_CHARS, 2_000_000),
      // 关掉就恢复旧行为：超长直接 413
      overflowToAttachment: bool(env.OVERFLOW_TO_ATTACHMENT, true),
      // 网页会话复用：同一段对话只建一次 chat_session，后续用 parent_message_id 追加
      sessionReuse: bool(env.SESSION_REUSE, true),
      // 映射多久没动过就不再复用（防止「相同开头的新对话」串进旧会话）
      sessionTtlMs: int(env.SESSION_TTL_MS, 6 * 60 * 60_000),
      // 最多保留多少个会话映射（LRU 淘汰）
      maxWebSessions: int(env.MAX_WEB_SESSIONS, 100),
      // 浏览器模式：抓页面自己发出的 /api/v0/chat/completion 原始流，用模型原始输出
      // （含 DO 工具调用 token）作为权威文本，DOM 只负责流式展示。关掉退回纯 DOM 提取。
      browserCapture: bool(env.BROWSER_CAPTURE, true),
      // DOM 提前判定结束时，最多再等原始流收尾多久（毫秒），用来补齐被截断的尾部 token
      browserCaptureWaitMs: int(env.BROWSER_CAPTURE_WAIT_MS, 20_000),
    },
  };
}

export const CONFIG_ROOT = ROOT;
