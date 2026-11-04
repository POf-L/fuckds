import { DirectEngine } from '../direct/client.mjs';
import { HybridEngine } from '../hybrid/client.mjs';
import {
  buildProtocolExtras,
  credentialSummary,
  harvestCredentials,
  loadCredentials,
  saveCredentials,
} from './credentials.mjs';

/**
 * 协议优先通道（ENGINE=protocol）：
 *
 *   1. 默认：用 data/protocol-credentials.json 里的凭据（cookie + token + hif 缓存）
 *      直接发 Node HTTPS，不启动浏览器。
 *   2. 凭据缺失：打开 hybrid profile 采集一次（浏览器只活几秒），落盘后关闭。
 *   3. 请求失败且证据指向凭据失效（401/403/“invalid token”/40003）：
 *      从 profile 刷新一次凭据并重试。
 *   4. 仍失败：降级到 hybrid 全浏览器，并把层级/次数写进 status()（/healthz 可见）。
 *
 * 所有请求构造复用 DirectEngine（同样的 PoW、会话、SSE 解析），
 * 区别只是额外注入 cookie、x-hif 头、浏览器真实 UA / Client Hints。
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
    this.inner = null;
    this.hybrid = null;
    this.creds = null;
    this.credentialSource = 'none';
    this.layer = 'protocol';
    this.degradations = 0;
    this.lastReason = null;
    this.lastRefreshAt = null;
    this.lastHarvestMs = null;
  }

  async ensureStarted() {
    if (this.inner) return;
    await this.#loadOrHarvest(false);
  }

  async warmUp() {
    // 只确保凭据可用；不做 direct 引擎的 check_device 冷启动序列，少发无用请求
    await this.ensureStarted();
  }

  status() {
    return {
      engine: 'protocol',
      layer: this.layer,
      degradations: this.degradations,
      lastReason: this.lastReason,
      credentialSource: this.credentialSource,
      lastRefreshAt: this.lastRefreshAt,
      lastHarvestMs: this.lastHarvestMs,
      credentials: this.creds ? credentialSummary(this.creds) : null,
      browser: this.layer === 'hybrid',
      ...(this.layer === 'hybrid' && this.hybrid ? this.hybrid.health() : {}),
    };
  }

  health() {
    return this.status();
  }

  async close() {
    await this.inner?.close?.().catch?.(() => {});
    await this.hybrid?.close?.().catch?.(() => {});
    this.inner = null;
    this.hybrid = null;
  }

  /* ------------------------------------------------------------------ */

  async #loadOrHarvest(force) {
    let creds = force ? null : loadCredentials(this.credentialsFile);
    if (creds) {
      this.credentialSource = 'cache';
    } else {
      creds = await harvestCredentials({ config: this.config, logger: this.log });
      this.credentialSource = 'harvested';
      this.lastHarvestMs = creds.harvestMs ?? null;
      saveCredentials(this.credentialsFile, creds);
    }
    this.creds = creds;
    this.#buildInner(creds);
  }

  #buildInner(creds) {
    const extras = buildProtocolExtras(creds);
    const deepseek = {
      ...this.config.deepseek,
      token: creds.userToken,
      tokens: [creds.userToken],
      deviceIds: { [creds.userToken]: creds.deviceId },
      protocolExtras: extras,
    };
    this.inner = new DirectEngine({
      config: { ...this.config, deepseek },
      logger: this.log.child('protocol-direct'),
    });
  }

  async #refreshCredentials() {
    this.log.warn('协议通道：凭据疑似失效，从浏览器 profile 刷新一次', {
      reason: this.lastReason,
      source: this.credentialSource,
    });
    const old = this.inner;
    this.inner = null;
    await old?.close?.().catch?.(() => {});
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
        const result = await this.inner.chat(args);
        return result;
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
            this.log.warn('协议通道：凭据刷新失败', { reason: refreshErr.message });
          }
        }
        if (this.config.protocol.fallbackToHybrid === false) throw err;
        this.log.warn('协议通道＋刷新凭据均失败，降级到 hybrid 全浏览器', { reason: this.lastReason });
        this.layer = 'hybrid';
        this.degradations += 1;
        this.hybrid = new HybridEngine({ config: this.config, logger: this.log.child('hybrid') });
        return this.hybrid.chat(args);
      }
    }
  }
}
