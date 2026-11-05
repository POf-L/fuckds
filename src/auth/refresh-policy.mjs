/**
 * 凭据刷新决策（纯函数，便于单测）。
 *
 * 原则：
 *  - 只在**已经存在的** profile 浏览器实例里静默刷新（connectOverCDP 复用），绝不新开实例；
 *  - 没有活实例时不为刷新而启动浏览器，直接让调用方按 401 + nextAction 返回；
 *  - 同一账号刷新间隔 ≥ minIntervalMs（默认 60s），避免刷新风暴。
 */
export function decideRefresh({
  hasLiveInstance = false,
  allowBrowserRefresh = false,
  lastAttemptAt = null,
  now = Date.now(),
  minIntervalMs = 60_000,
} = {}) {
  const sinceLastMs = lastAttemptAt ? Math.max(0, now - lastAttemptAt) : Infinity;
  if (sinceLastMs < minIntervalMs) {
    return { action: 'throttled', reason: 'refresh-throttled', sinceLastMs };
  }
  if (hasLiveInstance) return { action: 'live', reason: 'live-instance', sinceLastMs };
  if (allowBrowserRefresh === true) return { action: 'launch', reason: 'explicit-allow', sinceLastMs };
  return { action: 'reject', reason: 'no-live-instance', sinceLastMs };
}
