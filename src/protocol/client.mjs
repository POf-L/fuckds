import fs from 'node:fs';
import path from 'node:path';

import { DirectEngine } from '../direct/client.mjs';
import { AuthExpiredError } from '../errors.mjs';
import { liveProfilePort } from '../browser/profile-lock.mjs';
import { fingerprintOf } from '../direct/account-pool.mjs';
import { HybridEngine } from '../hybrid/client.mjs';
import { evaluateCredentialState, isDispatchableState } from '../auth/credential-state.mjs';
import { decideRefresh } from '../auth/refresh-policy.mjs';
import {
  buildProtocolExtras,
  credentialSummary,
  harvestCredentials,
  hasLoginMarker,
  loadCredentials,
  saveCredentials,
} from './credentials.mjs';

/**
 * 协议优先通道（ENGINE=protocol）：
 *
 *   1. 默认：用 data/protocol-accounts/*.json 里的凭据（cookie + token + hif 缓存）
 *      直接发 Node HTTPS，不启动浏览器。每个凭据文件 = 一个账号 = 一个 DirectEngine
 *      （因此每个账号天然拥有独立的 PoW / 设备 ID / 单账号串行队列）。
 *   2. 凭据缺失：打开 hybrid profile 采集一次（浏览器只活几秒），落盘后关闭。
 *   3. 请求失败且证据指向凭据失效（401/403/“invalid token”/40003）：
 *      从 profile 刷新一次凭据并重试。
 *   4. 仍失败：降级到 hybrid 全浏览器，并把层级/次数写进 status()（/healthz 可见）。
 *
 * 账号调度：
 *   - 一个对话第一次落账号后固定（会话条目里存 accountFingerprint），后续请求钉回原号；
 *   - 新对话选「可用且负载最低」的账号；全都冷却时选冷却结束最早的；
 *   - 单账号串行 + 最小间隔由 DirectEngine 的 AccountScheduler 保证（不同账号并行）。
 */

// 实测补充分支：假 token 调 /chat_session/create 返回 HTTP 502 + code=session_failed +
// message=INVALID_TOKEN（下划线形式，旧正则 /invalid token/ 匹配不到）。
const AUTH_HINTS = [/authorization failed/i, /invalid[_ ]token/i, /token.*expired/i, /40003/, /INVALID_TOKEN/];

export function looksLikeCredentialFailure(err) {
  if (!err) return false;
  if (err.name === 'AuthExpiredError') return true;
  if (err.status === 401 || err.status === 403) return true;
  const text = `${err.message || ''} ${err.code || ''}`;
  return AUTH_HINTS.some((re) => re.test(text));
}

export class ProtocolEngine {
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger;
    this.credentialsFile = config.protocol.credentialsFile;
    this.accountsDir = config.protocol.accountsDir
      || path.join(config.dataDir || '.', 'protocol-accounts');
    /** [{ creds, file, fingerprint, engine }] */
    this.accounts = [];
    this.inner = null;
    this.hybrid = null;
    this.credentialSource = 'none';
    this.layer = 'protocol';
    this.degradations = 0;
    this.lastReason = null;
    this.lastRefreshAt = null;
    this.lastHarvestMs = null;
    this.lastLiveSyncAt = 0;
    /** 最近一次刷新尝试的结果：success / failed / throttled / rejected-no-live / null */
    this.lastRefreshResult = null;
    /** 刷新节流：账号指纹 → 最近一次尝试时间（同一账号 ≥ refreshMinIntervalMs 才允许再试） */
    this.refreshAttempts = new Map();
  }

  /** 该账号最近一次刷新尝试时间（没试过返回 null） */
  #lastRefreshAtOf(fingerprint) {
    return this.refreshAttempts.get(fingerprint || 'default')?.at ?? null;
  }

  #lastRefreshResultOf(fingerprint) {
    return this.refreshAttempts.get(fingerprint || 'default')?.result ?? null;
  }

  async ensureStarted() {
    if (this.accounts.length || this.inner) return;
    await this.#loadOrHarvest(false);
  }

  async warmUp() {
    // 只确保凭据可用；不做 direct 引擎的 check_device 冷启动序列，少发无用请求
    await this.ensureStarted();
  }

  status() {
    const perAccount = this.accounts.map((account) => {
      const snapshot = account.engine.status?.() ?? {};
      const scheduled = snapshot.scheduler?.[0] ?? {};
      const inner = snapshot.accounts?.[0] ?? {};
      const cred = evaluateCredentialState({
        token: account.creds.userToken,
        // 协议通道能拿到 hif：缺 hif 的匿名访客 token 不能当成登录态
        hasLoginMarker: hasLoginMarker(account.creds),
        harvestedAt: account.creds.harvestedAt || null,
        authFailed: inner.authFailed ?? false,
        lastAuthError: inner.lastAuthError ?? null,
        maxAgeMs: this.config.protocol.tokenMaxAgeMs,
        staleAgeMs: this.config.protocol.tokenStaleAgeMs,
      });
      const cooling = (scheduled.cooldownMs ?? 0) > 0;
      // 年龄超硬阈值不再拦截派发：只有真实认证失败 / 匿名 / 无 token 才不可派发
      const dispatchable = !cooling && isDispatchableState(cred.credentialState);
      const nextAction = dispatchable
        ? null
        : cred.credentialState === 'invalid' || cred.credentialState === 'anonymous'
          ? 're-login'
          : 'wait-cooldown';
      return {
        accountHash: account.fingerprint.slice(0, 12),
        // available 保留旧字段名，含义改为“能真正派发”；dispatchable 同义，便于新旧监控兼容
        available: dispatchable,
        dispatchable,
        nextAction,
        credentialState: cred.credentialState,
        credentialReason: cred.reason,
        lastAuthError: cred.lastAuthError,
        credentialAgeMs: cred.ageMs,
        // 仅告警：年龄已超硬阈值，但凭据仍可派发（真失效以上游 401 为准）
        credentialAgeWarn: cred.ageWarn === true,
        lastRefreshAt: this.#lastRefreshAtOf(account.fingerprint),
        lastRefreshResult: this.#lastRefreshResultOf(account.fingerprint),
        hasToken: cred.hasToken,
        inflight: scheduled.inflight ?? 0,
        queued: scheduled.queued ?? 0,
        cooldownMs: scheduled.cooldownMs ?? 0,
        lastStartAt: scheduled.lastStartAt ?? null,
        minGapMs: scheduled.minGapMs ?? 0,
        credentials: {
          ...credentialSummary(account.creds),
          hasToken: cred.hasToken,
          credentialState: cred.credentialState,
        },
      };
    });
    const states = perAccount.map((a) => a.credentialState);
    const dispatchableCount = perAccount.filter((a) => a.dispatchable).length;
    return {
      engine: 'protocol',
      // 运行策略快照（只读，用来核对“默认参数已生效”；不含任何凭据值）
      policy: {
        minGapMs: this.config.runtime?.accountMinGapMs ?? null,
        // 工具长任务专用间隔（默认 15000ms；普通对话仍用 minGapMs）
        toolMinGapMs: this.config.runtime?.toolMinGapMs ?? null,
        mutedCooldownMs: this.config.runtime?.mutedCooldownMs ?? null,
        accountCooldownMs: this.config.runtime?.accountCooldownMs ?? null,
        concurrency: this.config.runtime?.concurrency ?? null,
        sessionReuse: this.config.runtime?.sessionReuse ?? null,
        allowBrowserRefresh: this.config.protocol?.allowBrowserRefresh ?? null,
        refreshOnAuthFail: this.config.protocol?.refreshOnAuthFail ?? null,
        refreshMinIntervalMs: this.config.protocol?.refreshMinIntervalMs ?? null,
        fallbackToHybrid: this.config.protocol?.fallbackToHybrid ?? null,
      },
      layer: this.layer,
      degradations: this.degradations,
      lastReason: this.lastReason,
      credentialSource: this.credentialSource,
      lastRefreshAt: this.lastRefreshAt,
      // 最近一次刷新结果（success / failed / throttled / rejected-no-live / null）
      lastRefreshResult: this.lastRefreshResult,
      lastHarvestMs: this.lastHarvestMs,
      // 多账号：每个账号独立的 in-flight / 队列长度 / 冷却（只给哈希前缀）
      accounts: perAccount,
      accountsTotal: perAccount.length,
      credentialState: perAccount.length === 0 ? 'unknown' : dispatchableCount > 0 ? (states.includes('stale') ? 'stale' : 'valid') : states[0],
      // 年龄超阈值只告警，不影响 dispatchable / nextAction
      credentialAgeWarn: perAccount.some((account) => account.credentialAgeWarn === true),
      nextAction: dispatchableCount > 0 ? null : perAccount.length === 0 || states.some((s) => s === 'invalid' || s === 'anonymous') ? 're-login' : 'wait-cooldown',
      credentials: this.accounts[0] ? { ...credentialSummary(this.accounts[0].creds), hasToken: perAccount[0]?.hasToken ?? false, credentialState: perAccount[0]?.credentialState } : null,
      // 网页会话复用状态：只暴露布尔与哈希前缀，绝不输出原始会话 id
      ...(this.inner?.sessionStatus?.() ?? {}),
      browser: this.layer === 'hybrid',
      ...(this.layer === 'hybrid' && this.hybrid ? this.hybrid.health() : {}),
    };
  }

  health() {
    return this.status();
  }

  /**
   * 预测这次请求会落在哪个账号（只读，不发请求）。
   * 已绑定的对话钉回原账号；新对话按「可用 + 负载最低 → 冷却结束最早」选择。
   */
  planAccount(preferredFingerprint = null) {
    const selected = this.#selectAccount(preferredFingerprint);
    if (!selected) return null;
    const described = selected.engine.describeAccount?.() ?? {};
    return { ...described, fingerprint: selected.fingerprint };
  }

  /**
   * 图片上传：与文本附件走同一个 `/api/v0/file/upload_file`，
   * 上传成功后同样把返回的 id 放进 `ref_file_ids`（bundle 中 completion 的
   * `ref_file_ids` 对文件/图片是同一个字段，响应里的 `is_image` 只用于前端渲染）。
   */
  async uploadImages(images = [], options = {}) {
    if (!images.length) return [];
    await this.ensureStarted();
    const selected = this.#selectAccount(options.accountFingerprint ?? null);
    const engine = selected?.engine || this.inner;
    if (!engine) throw new Error('协议通道没有可用账号');
    if (typeof engine.uploadImages !== 'function') {
      throw new Error('当前协议账号的引擎不支持图片上传');
    }
    return engine.uploadImages(images);
  }

  /**
   * 附件上传：委托给所选账号的 DirectEngine（每个账号自带独立调度队列）。
   * 传入 accountFingerprint 可保持「上传与补全落在同一账号」，避免 ref_file_id 跨号失效。
   * 未传时按负载选号（与 planAccount 相同的只读选择逻辑）。
   */
  async uploadAttachments(files = [], options = {}) {
    if (!files.length) return [];
    await this.ensureStarted();
    const selected = this.#selectAccount(options.accountFingerprint ?? null);
    const engine = selected?.engine || this.inner;
    if (!engine) throw new Error('协议通道没有可用账号');
    if (typeof engine.uploadAttachments !== 'function') {
      throw new Error('当前协议账号的引擎不支持附件上传');
    }
    return engine.uploadAttachments(files);
  }

  async close() {
    for (const account of this.accounts) {
      await account.engine?.close?.().catch?.(() => {});
    }
    await this.hybrid?.close?.().catch?.(() => {});
    this.accounts = [];
    this.inner = null;
    this.hybrid = null;
  }

  /* ------------------------------------------------------------------ */

  /** 读 accountsDir 下所有凭据；兼容旧的单文件配置；按 token 指纹去重 */
  #loadAllCredentials() {
    const found = [];
    try {
      for (const name of fs.readdirSync(this.accountsDir)) {
        if (!name.endsWith('.json')) continue;
        const creds = loadCredentials(path.join(this.accountsDir, name));
        if (creds) found.push({ creds, file: path.join(this.accountsDir, name) });
      }
    } catch {
      /* 目录不存在：继续看旧的单文件 */
    }
    const legacy = loadCredentials(this.credentialsFile);
    if (legacy) found.push({ creds: legacy, file: this.credentialsFile });
    const seen = new Set();
    return found.filter(({ creds }) => {
      const fingerprint = fingerprintOf(creds.userToken);
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
  }

  #saveCredential(creds) {
    fs.mkdirSync(this.accountsDir, { recursive: true });
    const file = path.join(this.accountsDir, `account-${fingerprintOf(creds.userToken)}.json`);
    saveCredentials(file, creds);
    return file;
  }

  #assertBrowserRefreshAllowed(context) {
    // 策略闸门：浏览器只能由用户显式命令打开（npm run auth:hybrid）。
    // 自动刷新/降级重开用户 profile 实测会让已登录会话失效，所以默认拒绝。
    if (this.config.protocol.allowBrowserRefresh === true) return;
    const err = new Error(
      `refresh_blocked_by_policy：自动打开浏览器已被策略禁止（ALLOW_BROWSER_REFRESH=false，${context}）。` +
        '请手动运行 npm run auth:hybrid 重新登录。',
    );
    err.code = 'refresh_blocked_by_policy';
    this.log.warn?.('refresh_blocked_by_policy', { context, reason: this.lastReason });
    throw err;
  }

  /**
   * 从“已经在运行的 profile 实例”读当前 cookie/token/hif。
   * 没有实例就返回 null —— 绝不为了刷新凭据自己启动第二个浏览器。
   */
  async #harvestLiveCredentials() {
    const profileDir = this.config.hybrid?.profileDir;
    if (!profileDir || !(await liveProfilePort(profileDir))) return null;
    try {
      return await harvestCredentials({
        config: this.config,
        logger: this.log,
        reuseOnly: true,
        waitMs: 0,
      });
    } catch (err) {
      this.log.warn?.('从活的 profile 同步凭据失败，沿用最近快照', { message: err.message });
      return null;
    }
  }

  /** 把活 profile 的最新凭据同步到内存（同 token 只更新 cookie/hif，不重建引擎） */
  #applyLiveCredentials(creds) {
    const fingerprint = fingerprintOf(creds.userToken);
    const found = this.accounts.find((account) => account.fingerprint === fingerprint);
    if (found) {
      found.creds = creds;
      if (found.engine?.config?.deepseek) {
        found.engine.config.deepseek.protocolExtras = buildProtocolExtras(creds);
      }
      this.credentialSource = 'live-profile';
      this.log.info?.('已从活的 profile 同步凭据（cookie/hif 更新，未启动浏览器）');
      return;
    }
    // token 变了（用户在同一个 profile 里重新登录过一次）：落盘并重建引擎
    const old = this.accounts.map((account) => account.engine);
    const file = this.#saveCredential(creds);
    this.#buildEngines([{ creds, file }]);
    this.credentialSource = 'live-profile';
    this.log.info?.('活的 profile 里是另一个登录态，已切换账号');
    for (const engine of old) void engine?.close?.().catch?.(() => {});
  }

  /** 每 60s 最多同步一次，避免每个请求都去读页面 */
  async #syncFromLiveProfile() {
    if (Date.now() - this.lastLiveSyncAt < 60_000) return false;
    const profileDir = this.config.hybrid?.profileDir;
    if (!profileDir || !(await liveProfilePort(profileDir))) return false;
    this.lastLiveSyncAt = Date.now();
    const creds = await this.#harvestLiveCredentials();
    if (!creds) return false;
    this.#applyLiveCredentials(creds);
    return true;
  }

  async #loadOrHarvest(force) {
    let loaded = force ? [] : this.#loadAllCredentials();
    if (loaded.length) {
      this.credentialSource = loaded.length > 1 ? `cache:${loaded.length}-accounts` : 'cache';
    } else {
      // 没有缓存凭据：先从“已经存在的” profile 实例读（复用，不新开窗口）。
      const live = await this.#harvestLiveCredentials();
      if (live) {
        const file = this.#saveCredential(live);
        this.credentialSource = 'live-profile';
        this.lastHarvestMs = live.harvestMs ?? null;
        loaded = [{ creds: live, file }];
      } else if (this.config.protocol.allowBrowserRefresh === true) {
        // 只有用户显式打开策略闸门，才允许为了首次采集启动浏览器
        this.#assertBrowserRefreshAllowed(force ? 'auth-refresh' : 'startup-harvest');
        const creds = await harvestCredentials({ config: this.config, logger: this.log });
        const file = this.#saveCredential(creds);
        this.credentialSource = 'harvested';
        this.lastHarvestMs = creds.harvestMs ?? null;
        loaded = [{ creds, file }];
      } else {
        // 没有活实例、也没有凭据：不自动开浏览器，直接按 401 让用户手动登录一次
        throw new AuthExpiredError(
          '还没有可用凭据：请手动运行 npm run auth:hybrid 登录一次（网关不会自动打开浏览器）',
        );
      }
    }
    this.#buildEngines(loaded);
  }

  #buildEngines(loaded) {
    this.accounts = loaded.map(({ creds, file }) => {
      const fingerprint = fingerprintOf(creds.userToken);
      const deepseek = {
        ...this.config.deepseek,
        token: creds.userToken,
        tokens: [creds.userToken],
        deviceIds: { [creds.userToken]: creds.deviceId },
        protocolExtras: buildProtocolExtras(creds),
      };
      const engine = new DirectEngine({
        config: { ...this.config, deepseek },
        logger: this.log.child('protocol-direct'),
      });
      return { creds, file, fingerprint, engine };
    });
    this.inner = this.accounts[0]?.engine ?? null;
    this.log.info?.(`协议通道已加载 ${this.accounts.length} 个账号`, {
      accounts: this.accounts.map((account) => account.fingerprint.slice(0, 12)),
    });
  }

  /**
   * 选一个账号：绑定的优先（即使冷却也钉住，不把对话漂到别的账号）；
   * 新对话在可用账号里选负载最低的，全冷却则选最早恢复的。
   */
  #selectAccount(preferredFingerprint = null) {
    if (!this.accounts.length) return null;
    if (preferredFingerprint) {
      const bound = this.accounts.find((account) => account.fingerprint === preferredFingerprint);
      if (bound) return bound;
    }
    const described = this.accounts.map((account) => ({
      account,
      info: account.engine.describeAccount?.() ?? { available: true, cooldownMs: 0, load: 0 },
    }));
    const available = described.filter((item) => item.info.available);
    const pool = available.length ? available : described;
    return pool.reduce((best, item) => {
      if (available.length) return item.info.load < best.info.load ? item : best;
      return item.info.cooldownMs < best.info.cooldownMs ? item : best;
    }).account;
  }

  /**
   * 真实认证失败（401 / INVALID_TOKEN / user is muted）才改变可用性：
   * 把该账号在号池里标记为 authFailed，/healthz 立即变成 dispatchable=false + nextAction=re-login。
   * 刷新成功后会 markHealthy 清掉这个标记。
   */
  #markAuthFailed(fingerprint = null) {
    const target = (fingerprint && this.accounts.find((account) => account.fingerprint === fingerprint))
      || this.accounts[0];
    const pool = target?.engine?.pool;
    if (!pool?.accounts?.length) return;
    for (const inner of pool.accounts) {
      pool.markUnavailable(inner, 0, '登录态失效', { authFailed: true, authErrorCode: 'INVALID_TOKEN' });
    }
  }

  /**
   * 刷新凭据（静默、节流、不新开浏览器）：
   *   - 有活 profile 实例 → 经 profile 锁 connectOverCDP 复用，读最新 cookie/hif；
   *   - 没有活实例 → 拒绝（不启动浏览器），交给调用方按 401 + nextAction 返回；
   *   - 同一账号 ≥ refreshMinIntervalMs（默认 60s）才允许再次刷新。
   */
  async #refreshCredentials(fingerprint = null) {
    const key = fingerprint || 'default';
    const profileDir = this.config.hybrid?.profileDir;
    const livePort = profileDir ? await liveProfilePort(profileDir) : null;
    const minIntervalMs = this.config.protocol.refreshMinIntervalMs ?? 60_000;
    const decision = decideRefresh({
      hasLiveInstance: Boolean(livePort),
      allowBrowserRefresh: this.config.protocol.allowBrowserRefresh === true,
      lastAttemptAt: this.#lastRefreshAtOf(key),
      now: Date.now(),
      minIntervalMs,
    });

    if (decision.action === 'throttled') {
      this.lastRefreshResult = 'throttled';
      const err = new Error(`刷新节流：同一账号 ${minIntervalMs}ms 内最多刷新一次（上次 ${Math.round(decision.sinceLastMs)}ms 前）`);
      err.code = 'refresh_throttled';
      this.log.warn?.('协议通道：刷新被节流', { sinceLastMs: decision.sinceLastMs, minIntervalMs });
      throw err;
    }

    this.lastRefreshAt = Date.now();
    if (decision.action === 'reject') {
      this.refreshAttempts.set(key, { at: this.lastRefreshAt, result: 'rejected-no-live' });
      this.lastRefreshResult = 'rejected-no-live';
      const err = new Error(
        '没有活的 profile 实例：按策略不自动开浏览器刷新凭据；请在已登录的窗口里重新登录，或手动运行 npm run auth:hybrid',
      );
      err.code = 'refresh_unavailable';
      this.log.warn?.('协议通道：无活实例，不自动开浏览器', { reason: this.lastReason });
      throw err;
    }

    this.log.warn('协议通道：凭据疑似失效，从浏览器 profile 刷新一次', {
      reason: this.lastReason,
      source: this.credentialSource,
      action: decision.action,
    });
    this.refreshAttempts.set(key, { at: this.lastRefreshAt, result: 'failed' });

    if (decision.action === 'live') {
      const live = await this.#harvestLiveCredentials();
      if (!live) {
        this.lastRefreshResult = 'failed';
        const err = new Error('从活的 profile 实例读取凭据失败');
        err.code = 'refresh_failed';
        throw err;
      }
      // 同一 token：原地更新 cookie/hif（引擎不重建）；token 变了：落盘并重建
      this.#applyLiveCredentials(live);
      // 刷新成功即清除上一次 401 留下的 authFailed 停用标记，否则重试会被号池直接拒掉
      for (const account of this.accounts) {
        const pool = account.engine?.pool;
        if (!pool) continue;
        for (const inner of pool.accounts ?? []) pool.markHealthy(inner);
      }
      this.refreshAttempts.set(key, { at: this.lastRefreshAt, result: 'success' });
      this.lastRefreshResult = 'success';
      this.degradations += 1;
      return true;
    }

    // 仅当 ALLOW_BROWSER_REFRESH=true（用户显式授权）才启动浏览器
    const old = this.accounts.map((account) => account.engine);
    this.accounts = [];
    this.inner = null;
    for (const engine of old) await engine?.close?.().catch?.(() => {});
    await this.#loadOrHarvest(true);
    this.refreshAttempts.set(key, { at: this.lastRefreshAt, result: 'success' });
    this.lastRefreshResult = 'success';
    this.degradations += 1;
    return true;
  }

  async chat(args) {
    if (this.layer === 'hybrid' && this.hybrid) return this.hybrid.chat(args);
    let refreshed = false;
    for (;;) {
      let selected = null;
      try {
        await this.ensureStarted();
        // 活 profile 优先：每 60s 从已运行的实例同步 cookie/hif（绝不为此新开浏览器）
        await this.#syncFromLiveProfile();
        const preferred = args.session?.accountFingerprint ?? args.accountFingerprint ?? null;
        selected = this.#selectAccount(preferred);
        const engine = selected?.engine || this.inner;
        if (!engine) throw new Error('协议通道没有可用账号');
        // 钉住账号：把本次选中的账号指纹交给引擎，避免它在内部又换号
        const sessionArgs = args.session
          ? { ...args.session, accountFingerprint: args.session.accountFingerprint || selected?.fingerprint }
          : selected
            ? { accountFingerprint: selected.fingerprint }
            : null;
        return await engine.chat({ ...args, session: sessionArgs });
      } catch (err) {
        if (!looksLikeCredentialFailure(err)) throw err;
        this.lastReason = `${err.name || 'Error'}: ${err.message}`;
        // 真实失败的账号指纹：优先会话钉住的号，否则用本次实际选中的号
        const preferred = args.session?.accountFingerprint ?? args.accountFingerprint
          ?? selected?.fingerprint ?? null;
        // 上游真实拒绝（401/INVALID_TOKEN）才把账号判为失效；年龄超阈值不算
        this.#markAuthFailed(preferred);
        if (!refreshed && this.config.protocol.refreshOnAuthFail !== false) {
          refreshed = true;
          try {
            // 静默刷新：只复用已有活实例；无活实例时直接抛错，不启动浏览器
            await this.#refreshCredentials(preferred);
            continue;
          } catch (refreshErr) {
            this.lastReason = `凭据刷新失败: ${refreshErr.message}`;
            this.log.warn?.('协议通道：凭据刷新失败', { reason: refreshErr.message, code: refreshErr.code });
            // 刷新失败不重试、不降级：直接 401 + nextAction，客户端据此提示登录
            throw err.name === 'AuthExpiredError'
              ? err
              : new AuthExpiredError(`协议凭据失效：${err.message}（刷新未成功：${refreshErr.message}）`);
          }
        }
        if (this.config.protocol.fallbackToHybrid === false) {
          // 只有「已经有活的 profile 实例」才允许经 CDP 降级；否则明确报凭据失效，
          // 绝不为了降级自己启动第二个浏览器（会顶掉用户登录态）。
          const livePort = await liveProfilePort(this.config.hybrid?.profileDir);
          if (!livePort) {
            throw err.name === 'AuthExpiredError' ? err : new AuthExpiredError(`协议凭据失效：${err.message}`);
          }
          this.log.warn('协议凭据失效，但 profile 实例已在运行：经 CDP 降级到 hybrid（不新开浏览器）', {
            port: livePort,
            reason: this.lastReason,
          });
        } else {
          this.log.warn('协议通道＋刷新凭据均失败，降级到 hybrid 全浏览器', { reason: this.lastReason });
        }
        this.layer = 'hybrid';
        this.degradations += 1;
        this.hybrid = new HybridEngine({ config: this.config, logger: this.log.child('hybrid') });
        return this.hybrid.chat(args);
      }
    }
  }
}
