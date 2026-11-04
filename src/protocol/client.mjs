import fs from 'node:fs';
import path from 'node:path';

import { DirectEngine } from '../direct/client.mjs';
import { AuthExpiredError } from '../errors.mjs';
import { fingerprintOf } from '../direct/account-pool.mjs';
import { HybridEngine } from '../hybrid/client.mjs';
import { evaluateCredentialState, isDispatchableState } from '../auth/credential-state.mjs';
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
      const dispatchable = !cooling && isDispatchableState(cred.credentialState);
      return {
        accountHash: account.fingerprint.slice(0, 12),
        // available 保留旧字段名，含义改为“能真正派发”；dispatchable 同义，便于新旧监控兼容
        available: dispatchable,
        dispatchable,
        credentialState: cred.credentialState,
        credentialReason: cred.reason,
        lastAuthError: cred.lastAuthError,
        credentialAgeMs: cred.ageMs,
        hasToken: cred.hasToken,
        inflight: scheduled.inflight ?? 0,
        queued: scheduled.queued ?? 0,
        cooldownMs: scheduled.cooldownMs ?? 0,
        lastStartAt: scheduled.lastStartAt ?? null,
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
      layer: this.layer,
      degradations: this.degradations,
      lastReason: this.lastReason,
      credentialSource: this.credentialSource,
      lastRefreshAt: this.lastRefreshAt,
      lastHarvestMs: this.lastHarvestMs,
      // 多账号：每个账号独立的 in-flight / 队列长度 / 冷却（只给哈希前缀）
      accounts: perAccount,
      accountsTotal: perAccount.length,
      credentialState: perAccount.length === 0 ? 'unknown' : dispatchableCount > 0 ? (states.includes('stale') ? 'stale' : 'valid') : states[0],
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

  async #loadOrHarvest(force) {
    let loaded = force ? [] : this.#loadAllCredentials();
    if (loaded.length) {
      this.credentialSource = loaded.length > 1 ? `cache:${loaded.length}-accounts` : 'cache';
    } else {
      this.#assertBrowserRefreshAllowed(force ? 'auth-refresh' : 'startup-harvest');
      const creds = await harvestCredentials({ config: this.config, logger: this.log });
      const file = this.#saveCredential(creds);
      this.credentialSource = 'harvested';
      this.lastHarvestMs = creds.harvestMs ?? null;
      loaded = [{ creds, file }];
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

  async #refreshCredentials() {
    // 先过策略闸门，再关旧引擎：避免“已经关掉账号、浏览器又起不来”的半死状态
    this.#assertBrowserRefreshAllowed('auth-refresh');
    this.log.warn('协议通道：凭据疑似失效，从浏览器 profile 刷新一次', {
      reason: this.lastReason,
      source: this.credentialSource,
    });
    const old = this.accounts.map((account) => account.engine);
    this.accounts = [];
    this.inner = null;
    for (const engine of old) await engine?.close?.().catch?.(() => {});
    this.lastRefreshAt = Date.now();
    await this.#loadOrHarvest(true);
    this.degradations += 1;
  }

  async chat(args) {
    if (this.layer === 'hybrid' && this.hybrid) return this.hybrid.chat(args);

    let refreshed = false;
    for (;;) {
      try {
        await this.ensureStarted();
        const preferred = args.session?.accountFingerprint ?? args.accountFingerprint ?? null;
        const selected = this.#selectAccount(preferred);
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
        if (!refreshed && this.config.protocol.refreshOnAuthFail !== false) {
          refreshed = true;
          try {
            await this.#refreshCredentials();
            continue;
          } catch (refreshErr) {
            // 采集失败（profile 未登录 / 浏览器起不来）本身就是降级理由
            this.lastReason = `凭据刷新失败: ${refreshErr.message}`;
            this.log.warn?.('协议通道：凭据刷新失败', { reason: refreshErr.message, code: refreshErr.code });
            // 策略拒绝：不再降级（降级同样要起浏览器），直接把可执行错误抛给客户端
            if (refreshErr.code === 'refresh_blocked_by_policy') throw refreshErr;
          }
        }
        if (this.config.protocol.fallbackToHybrid === false) {
          // 明确告诉客户端「是凭据失效」，不要伪装成上游 5xx
          throw err.name === 'AuthExpiredError' ? err : new AuthExpiredError(`协议凭据失效：${err.message}`);
        }
        this.log.warn('协议通道＋刷新凭据均失败，降级到 hybrid 全浏览器', { reason: this.lastReason });
        this.layer = 'hybrid';
        this.degradations += 1;
        this.hybrid = new HybridEngine({ config: this.config, logger: this.log.child('hybrid') });
        return this.hybrid.chat(args);
      }
    }
  }
}
