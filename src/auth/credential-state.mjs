/**
 * 凭据有效性的统一判定。
 *
 * 目的：/healthz 里的 available 只代表“调度器能派发”，不代表“上游真能用”。
 * 这里把两件事分开：credentialState 描述凭据本身，dispatchable 描述能否发请求。
 *
 * 状态：
 *   valid      —— 结构正确、有登录标记、年龄未超软阈值、没有认证失败记录
 *   stale      —— 结构正确但年龄超过软阈值（默认 6h），仍可派发，只是该尽快换；
 *                 超过硬阈值（默认 8h）也只是 stale + ageWarn=true，**不再拦截派发**
 *   invalid    —— 没有 token / 真实认证失败（401/INVALID_TOKEN 等）
 *   anonymous  —— token 结构不像登录态（如 30 字符访客 token）或缺 hif 登录标记
 *   unknown    —— 无法判定（未提供判断所需的字段）
 *
 * 年龄阈值只作告警：真实上游会话通常能活 13h 左右，本地按 8h 一刀切会把还能用的
 * 凭据判死，造成“每次都要手动登录”。可用性只由真实上游返回（401/INVALID_TOKEN/
 * user is muted）与匿名 token 决定。
 */

export const TOKEN_MAX_AGE_MS_DEFAULT = 8 * 60 * 60 * 1000;
export const TOKEN_STALE_AGE_MS_DEFAULT = 6 * 60 * 60 * 1000;

/** 真实登录态的 userToken 是 64 字符 base64 串（实测含 `/`，故不能只允许 URL-safe 字母表）；匿名访客实测是 30 字符 */
export function looksLikeLoginToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_+/=-]{48,128}$/.test(token);
}

export function evaluateCredentialState({
  token,
  hasLoginMarker = null, // true/false 由调用方给出；null 表示不判断（direct 模式没有 hif）
  harvestedAt = null,
  authFailed = false,
  lastAuthError = null,
  now = Date.now(),
  maxAgeMs = TOKEN_MAX_AGE_MS_DEFAULT,
  staleAgeMs = TOKEN_STALE_AGE_MS_DEFAULT,
} = {}) {
  const ageMs = harvestedAt ? Math.max(0, now - harvestedAt) : null;
  const authError = lastAuthError
    ? { at: lastAuthError.at ?? null, code: lastAuthError.code ?? null }
    : null;

  // 年龄只做告警位：超过硬阈值仍可派发，由真实上游决定是否失效。
  const ageWarn = ageMs !== null && maxAgeMs > 0 && ageMs > maxAgeMs;
  const base = { ageMs, lastAuthError: authError, ageWarn };

  if (!token) return { ...base, credentialState: 'invalid', hasToken: false, reason: 'no-token' };
  if (!looksLikeLoginToken(token)) {
    return { ...base, credentialState: 'anonymous', hasToken: false, reason: 'token-shape' };
  }
  if (hasLoginMarker === false) {
    return { ...base, credentialState: 'anonymous', hasToken: false, reason: 'no-login-marker' };
  }
  if (authFailed) return { ...base, credentialState: 'invalid', hasToken: true, reason: 'auth-failed' };
  if (ageMs !== null && staleAgeMs > 0 && ageMs > staleAgeMs) {
    // 超硬阈值原因保留 age-exceeded，但状态是可派发的 stale
    return { ...base, credentialState: 'stale', hasToken: true, reason: ageWarn ? 'age-exceeded' : 'age-stale' };
  }
  return { ...base, credentialState: 'valid', hasToken: true, reason: null };
}

/** 只有 valid/stale 的凭据才允许派发；冷却另算 */
export function isDispatchableState(state) {
  return state === 'valid' || state === 'stale';
}
