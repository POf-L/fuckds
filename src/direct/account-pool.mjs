import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
      fingerprint: crypto.createHash('sha256').update(token).digest('hex').slice(0, 16),
      // 协议通道会注入浏览器 profile 里真实的 deepseek-device-id:chat；
      // 没有注入时沿用按 token 派生的稳定设备 ID。
      deviceId: deviceIds[token] || loadDeviceId(dataDir, token),
      powNext: null,
      cooldownUntil: 0,
      limitedCount: 0,
      errorCount: 0,
      lastError: null,
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

  /** 轮询取一个不在冷却的账号；全都在冷却就返回 null */
  pick(now = Date.now()) {
    for (let i = 0; i < this.accounts.length; i += 1) {
      const account = this.accounts[(this.cursor + i) % this.accounts.length];
      if (account.cooldownUntil <= now) {
        this.cursor = (account.index + 1) % this.accounts.length;
        account.lastUsedAt = now;
        account.requests += 1;
        return account;
      }
    }
    return null;
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
  markUnavailable(account, ms, reason, { authFailed = false } = {}) {
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + ms);
    account.errorCount += 1;
    account.lastError = reason;
    if (authFailed) account.authFailed = true;
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
  }

  status() {
    const now = Date.now();
    return this.accounts.map((a) => ({
      index: a.index + 1,
      token: maskToken(a.token),
      available: a.cooldownUntil <= now,
      cooldownMs: Math.max(0, a.cooldownUntil - now),
      requests: a.requests,
      limited: a.limitedCount,
      errors: a.errorCount,
      lastError: a.lastError,
      authFailed: a.authFailed,
      powReady: Boolean(a.powNext),
    }));
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
