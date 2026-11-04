import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateCredentialState, isDispatchableState } from '../auth/credential-state.mjs';

/** 账号指纹：会话归属、日志、/healthz 都用它，绝不输出 token 原值 */
export function fingerprintOf(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

/**
 * 账号池。
 *
 * DeepSeek 网页是按「窗口内消息条数」限流的，不是按发送间隔，
 * 所以多准备几个 userToken，撞限流就换下一个，比干等冷却快得多。
 *
 * 每个账号有独立的：门禁（冷却）、PoW 预解、设备 ID、会话归属指纹。
 */
export class AccountPool {
  constructor({ tokens, dataDir, logger, deviceIds = {} }) {
    this.log = logger;
    this.dataDir = dataDir;
    this.accounts = tokens.map((token, index) => ({
      index,
      token,
      // 会话属于某个账号：复用会话时按这个指纹把请求钉回原号（不落盘原文）
      fingerprint: fingerprintOf(token),
      // 协议通道会注入浏览器 profile 里真实的 deepseek-device-id:chat；
      // 没有注入时沿用按 token 派生的稳定设备 ID。
      deviceId: deviceIds[token] || loadDeviceId(dataDir, token),
      powNext: null,
      cooldownUntil: 0,
      limitedCount: 0,
      errorCount: 0,
      lastError: null,
      /** 最近一次认证失败的脱敏记录：只存时间与错误码，不存上游原文 */
      lastAuthError: null,
      /** 登录态失效：换 token / 重启进程之前这个号不会再被选中 */
      authFailed: false,
      lastUsedAt: 0,
      requests: 0,
    }));
    this.cursor = 0;
    if (this.accounts.length > 1) this.log.info(`账号池已加载 ${this.accounts.length} 个 token`);
  }

  get size() {
    return this.accounts.length;
  }

  /**
   * 取一个不在冷却的账号；全都在冷却就返回 null。
   * 传入 loadOf 时按「负载最低」优先，并列时按轮询顺序（不同账号才能真正并行）。
   */
  pick(now = Date.now(), loadOf = null) {
    const chosen = this.peek(now, loadOf);
    if (!chosen) return null;
    this.cursor = (chosen.index + 1) % this.accounts.length;
    chosen.lastUsedAt = now;
    chosen.requests += 1;
    return chosen;
  }

  /** 只看不占：预测「下一个会被选中的账号」（会话命名空间/日志用，不消耗轮询游标） */
  peek(now = Date.now(), loadOf = null) {
    const ordered = [];
    for (let i = 0; i < this.accounts.length; i += 1) {
      ordered.push(this.accounts[(this.cursor + i) % this.accounts.length]);
    }
    const available = ordered.filter((account) => account.cooldownUntil <= now && !account.authFailed);
    if (!available.length) return null;
    let chosen = available[0];
    if (loadOf) {
      let best = loadOf(chosen);
      for (const account of available.slice(1)) {
        const load = loadOf(account);
        if (load < best) {
          best = load;
          chosen = account;
        }
      }
    }
    return chosen;
  }

  /** 最近的可用时间 */
  nextAvailableAt() {
    if (!this.accounts.length) return 0;
    return Math.min(...this.accounts.map((a) => a.cooldownUntil));
  }

  /** 池里还有没有立刻能用的账号（只看状态，不消耗轮询游标） */
  hasAvailable(now = Date.now()) {
    return this.accounts.some((a) => a.cooldownUntil <= now);
  }

  /** 是否所有账号都因为登录态失效被停用 */
  allAuthFailed() {
    return this.accounts.length > 0 && this.accounts.every((a) => a.authFailed);
  }

  markLimited(account, ms) {
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + ms);
    account.limitedCount += 1;
    account.lastError = '触发限流';
    const seconds = Math.round(ms / 100) / 10;
    this.log.warn(
      `账号 #${account.index + 1} 触发限流，冷却 ${seconds}s（池内还有 ${
        this.accounts.filter((a) => a !== account && a.cooldownUntil <= Date.now()).length
      } 个可用）`,
    );
  }

  /**
   * 账号级失败（登录态失效 / 上游报错）导致的停用。
   * 冷却期内这个号不会被选中，避免每次请求先撞一次坏号、要靠客户端重发才能换号。
   */
  markUnavailable(account, ms, reason, { authFailed = false, authErrorCode = null } = {}) {
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + ms);
    account.errorCount += 1;
    account.lastError = reason;
    if (authFailed) {
      account.authFailed = true;
      account.lastAuthError = { at: Date.now(), code: authErrorCode || 'auth_failed' };
    }
    const seconds = Math.round(ms / 100) / 10;
    this.log.warn(
      `账号 #${account.index + 1} 不可用（${reason}），停用 ${seconds}s（池内还有 ${
        this.accounts.filter((a) => a !== account && a.cooldownUntil <= Date.now()).length
      } 个可用）`,
    );
  }

  markHealthy(account) {
    account.cooldownUntil = 0;
    account.authFailed = false;
    account.lastError = null;
    account.lastAuthError = null;
  }

  status() {
    const now = Date.now();
    return this.accounts.map((a) => {
      const credential = evaluateCredentialState({
        token: a.token,
        authFailed: a.authFailed,
        lastAuthError: a.lastAuthError,
        now,
      });
      const cooling = a.cooldownUntil > now;
      return {
        index: a.index + 1,
        token: maskToken(a.token),
        // available：队列能否派发（冷却 + 凭据可用）；credentialState：凭据本身的状态
        available: !cooling && isDispatchableState(credential.credentialState),
        dispatchable: !cooling && isDispatchableState(credential.credentialState),
        credentialState: credential.credentialState,
        credentialReason: credential.reason,
        hasToken: credential.hasToken,
        lastAuthError: credential.lastAuthError,
        cooldownMs: Math.max(0, a.cooldownUntil - now),
        requests: a.requests,
        limited: a.limitedCount,
        errors: a.errorCount,
        lastError: a.lastError,
        authFailed: a.authFailed,
        powReady: Boolean(a.powNext),
      };
    });
  }

  close() {
    for (const account of this.accounts) {
      account.powNext = null;
    }
  }
}

export function maskToken(token) {
  if (!token) return '(空)';
  if (token.length <= 12) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function loadDeviceId(dataDir, token) {
  const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 10);
  const file = path.join(dataDir, `device-${id}.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.deviceId === 'string' && saved.deviceId.length > 8) return saved.deviceId;
  } catch {
    /* 新建 */
  }
  const deviceId = crypto.randomUUID();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ deviceId }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* 写不了就算了 */
  }
  return deviceId;
}
