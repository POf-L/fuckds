import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

import { hybridLaunchArgs } from '../hybrid/client.mjs';
import { launchOrReusePersistent, liveProfilePort } from '../browser/profile-lock.mjs';
import { looksLikeLoginToken } from '../auth/credential-state.mjs';

/**
 * 协议通道的凭据采集。
 *
 * 浏览器只在这里出现：打开已登录的 hybrid profile，读一次 cookie / localStorage，
 * 然后立刻关闭。之后所有请求都由 Node 直接发 HTTPS，不再需要浏览器进程。
 *
 * 采集到的都是敏感值（token、cookie、hif 签名），只落盘到 data/（已 gitignore），
 * 日志和 /healthz 只输出数量/是否存在，不输出值。
 */

/** localStorage 里的值可能是 "abc"，也可能是 { value: "abc" }，统一解包 */
export function unwrapStorageValue(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string') return parsed.value;
    return raw;
  } catch {
    return raw;
  }
}

export function cookieHeaderFrom(cookies) {
  return (cookies || [])
    .filter((c) => c && c.name && typeof c.value === 'string')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function platformLabel(platform) {
  if (platform === 'Win32') return 'Windows';
  if (platform === 'MacIntel') return 'macOS';
  if (platform === 'Linux x86_64') return 'Linux';
  return platform || 'Windows';
}

/** buildBrowserHeaders 的 extra：把实测到的浏览器特征带进协议请求 */
export function buildProtocolExtras(creds) {
  const extra = {};
  if (creds.cookieHeader) extra.cookie = creds.cookieHeader;
  if (creds.hifLeim) extra['x-hif-leim'] = creds.hifLeim;
  if (creds.hifDliq) extra['x-hif-dliq'] = creds.hifDliq;
  if (creds.userAgent) extra['user-agent'] = creds.userAgent;
  if (Array.isArray(creds.brands) && creds.brands.length) {
    extra['sec-ch-ua'] = creds.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  }
  if (typeof creds.mobile === 'boolean') extra['sec-ch-ua-mobile'] = creds.mobile ? '?1' : '?0';
  if (creds.platform) extra['sec-ch-ua-platform'] = `"${platformLabel(creds.platform)}"`;
  if (Array.isArray(creds.languages) && creds.languages.length) {
    extra['accept-language'] = creds.languages.join(',');
  }
  return extra;
}

export function credentialSummary(creds) {
  const loginToken = looksLikeLoginToken(creds.userToken) && hasLoginMarker(creds);
  return {
    harvestedAt: creds.harvestedAt || null,
    ageMs: creds.harvestedAt ? Date.now() - creds.harvestedAt : null,
    cookieCount: creds.cookies?.length || 0,
    cookieNames: (creds.cookies || []).map((c) => c.name),
    // hasToken 表示“有可用于登录态的 token”；匿名访客 token（30 字符、无 hif）不再报 true
    hasToken: loginToken,
    hasDeviceId: Boolean(creds.deviceId),
    hasHifLeim: Boolean(creds.hifLeim),
    hasHifDliq: Boolean(creds.hifDliq),
    userAgent: creds.userAgent || null,
  };
}

/**
 * 判断采集到的凭据是否真的属于登录态。
 *
 * 隔离 profile（没有登录）打开 chat.deepseek.com 时，前端会自动领一个匿名 guest
 * userToken，看起来和真实 token 一样，但不具备账号能力。实测证据（D 项）：
 * guest 凭据 cookie 只有 HWWAFSESID/HWWAFSESTIME/ds_session_id/smidV2，
 * 没有 hif 缓存（hasHifLeim/hasHifDliq 均为 false），用它发消息返回
 * Authorization Failed (invalid token)。注意 smidV2 匿名访客也会下发，不能当登录标记。
 * 真实登录态采集到的记录里 hif_leim / hif_dliq 均有值。
 */
export function hasLoginMarker(creds) {
  return Boolean(creds?.hifLeim) || Boolean(creds?.hifDliq);
}

export function loadCredentials(file) {
  try {
    const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
    return creds?.userToken ? creds : null;
  } catch {
    return null;
  }
}

export function saveCredentials(file, creds) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}

/**
 * 从已经打开的页面/上下文提取协议凭据（不发请求、不导航）。
 * 同时供 harvestCredentials 与 scripts/login-hybrid.mjs 复用，避免两套解析逻辑漂移。
 */
export async function extractCredentialsFromContext(ctx, page, startedAt = Date.now()) {
  const local = await page.evaluate(() => {
    const unwrap = (key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return '';
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return parsed;
        if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string') {
          return parsed.value;
        }
        return raw;
      } catch {
        return raw;
      }
    };
    return {
      userToken: unwrap('userToken'),
      deviceId: localStorage.getItem('deepseek-device-id:chat') || '',
      hifLeim: unwrap('hif_leim_cached'),
      hifDliq: unwrap('hif_dliq_cached'),
      userAgent: navigator.userAgent,
      languages: navigator.languages,
      platform: navigator.platform,
      brands: navigator.userAgentData?.brands || [],
      mobile: navigator.userAgentData?.mobile ?? false,
    };
  });
  const cookies = await ctx.cookies('https://chat.deepseek.com');
  const record = {
    ...local,
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      domain: c.domain,
      expires: c.expires,
    })),
    harvestedAt: Date.now(),
    harvestMs: Date.now() - startedAt,
  };
  record.cookieHeader = cookieHeaderFrom(record.cookies);
  return record;
}

export async function harvestCredentials({
  config,
  logger,
  waitMs = config.protocol?.harvestWaitMs ?? 2500,
  reuseOnly = false,
}) {
  const startedAt = Date.now();
  const profileDir = config.hybrid.profileDir;
  // reuseOnly：只允许从“已经在跑的 profile 实例”读，读不到就返回 null（绝不新开浏览器）
  if (reuseOnly && !(await liveProfilePort(profileDir))) return null;
  const launched = await launchOrReusePersistent({
    chromium,
    profileDir,
    log: logger,
    launch: (extraArgs) =>
      chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel: config.hybrid.channel || undefined,
        args: [...hybridLaunchArgs(), ...extraArgs],
      }),
  });
  const ctx = launched.context;
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction(() => Boolean(localStorage.getItem('userToken')), { timeout: 15000 })
      .catch(() => {});
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const record = await extractCredentialsFromContext(ctx, page, startedAt);
    if (!record.userToken) throw new Error('profile 里没有 userToken');
    if (!hasLoginMarker(record)) {
      throw new Error('profile 里只有匿名 guest token（缺 hif 缓存），不是登录态，拒绝缓存');
    }
    logger?.info?.('协议凭据已采集', credentialSummary(record));
    return record;
  } finally {
    if (launched.reused) {
      // 只断开 CDP，不关掉别人（服务/登录窗口）的浏览器
      await launched.browser?.close?.().catch(() => {});
    } else {
      await ctx.close().catch(() => {});
    }
  }
}
