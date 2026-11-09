import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseEnvText } from './util.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ------------------------------------------------------------------ *
 * 极简 .env 加载（不引入 dotenv，减少依赖）
 * ------------------------------------------------------------------ */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnvText(fs.readFileSync(file, 'utf8')))) {
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
    engine: str(env.ENGINE, 'direct'),
    direct: {
      powBin: path.resolve(ROOT, expandHome(str(env.POW_BIN, 'bin/ds-pow'))),
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
      /**
       * 工具声明形态：
       *   auto（默认） 完整声明放得下就用完整，需要拆分时改用压缩索引
       *   full         始终完整 JSON 声明
       *   compact      始终压缩索引（一行一个工具）
       * 工具声明永远不会被挪进附件，放不下会直接报错。
       */
      toolDeclMode: (() => {
        const value = str(env.TOOL_DECL_MODE, 'auto').toLowerCase();
        return ['auto', 'full', 'compact'].includes(value) ? value : 'auto';
      })(),
      // 浏览器模式：抓页面自己发出的 /api/v0/chat/completion 原始流，用模型原始输出
      // （含 DO 工具调用 token）作为权威文本，DOM 只负责流式展示。关掉退回纯 DOM 提取。
      browserCapture: bool(env.BROWSER_CAPTURE, true),
      // DOM 提前判定结束时，最多再等原始流收尾多久（毫秒），用来补齐被截断的尾部 token
      browserCaptureWaitMs: int(env.BROWSER_CAPTURE_WAIT_MS, 20_000),
    },
  };
}

export const CONFIG_ROOT = ROOT;
