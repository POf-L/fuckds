/**
 * 凭据有效性的统一判定。
 *
 * 目的：/healthz 里的 available 只代表“调度器能派发”，不代表“上游真能用”。
 * 这里把两件事分开：credentialState 描述凭据本身，dispatchable 描述能否发请求。
 *
 * 状态：
 *   valid      —— 结构正确、有登录标记、年龄未超软阈值、没有认证失败记录
 *   stale      —— 结构正确但年龄超过软阈值（默认 6h），仍可派发，只是该尽快换
 *   invalid    —— 没有 token / 认证失败 / 年龄超过硬阈值（默认 8h）
 *   anonymous  —— token 结构不像登录态（如 30 字符访客 token）或缺 hif 登录标记
 *   unknown    —— 无法判定（未提供判断所需的字段）
 */

export const TOKEN_MAX_AGE_MS_DEFAULT = 8 * 60 * 60 * 1000;
export const TOKEN_STALE_AGE_MS_DEFAULT = 6 * 60 * 60 * 1000;

/** 真实登录态的 userToken 是 64 字符的 URL-safe 串；匿名访客实测是 30 字符 */
export function looksLikeLoginToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{48,128}$/.test(token);
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

  const base = { ageMs, lastAuthError: authError };

  if (!token) return { ...base, credentialState: 'invalid', hasToken: false, reason: 'no-token' };
  if (!looksLikeLoginToken(token)) {
    return { ...base, credentialState: 'anonymous', hasToken: false, reason: 'token-shape' };
  }
  if (hasLoginMarker === false) {
    return { ...base, credentialState: 'anonymous', hasToken: false, reason: 'no-login-marker' };
  }
  if (authFailed) return { ...base, credentialState: 'invalid', hasToken: true, reason: 'auth-failed' };
  if (ageMs !== null && maxAgeMs > 0 && ageMs > maxAgeMs) {
    return { ...base, credentialState: 'invalid', hasToken: true, reason: 'age-exceeded' };
  }
  if (ageMs !== null && staleAgeMs > 0 && ageMs > staleAgeMs) {
    return { ...base, credentialState: 'stale', hasToken: true, reason: 'age-stale' };
  }
  return { ...base, credentialState: 'valid', hasToken: true, reason: null };
}

/** 只有 valid/stale 的凭据才允许派发；冷却另算 */
export function isDispatchableState(state) {
  return state === 'valid' || state === 'stale';
}
