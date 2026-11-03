import crypto from 'node:crypto';

/**
 * 浏览器特征模块。
 *
 * 目标：让直连请求在「请求头完整性 / 头间自洽性 / 会话生命周期」上更接近真实 Chrome，
 *       而不是伪装成一个只有 12 个头的裸 HTTP 客户端。
 *
 * 重要：本模块只能补齐「HTTP 语义层」的特征。
 *       TLS/JA3、JA4 指纹由 Node undici 决定，无法在此层修改；
 *       真实设备指纹（Canvas/WebGL/数美 deviceToken）必须执行 JS 才有，
 *       这里做不了，只能保证「同一账号的设备画像长期自洽」。
 */

/* -------------------------------------------------------------------------- */
/* 设备画像：每个账号一套，持久化后长期不变                                     */
/* -------------------------------------------------------------------------- */

export const DEVICE_PROFILES = {
  // 桌面 Chrome（默认，与 client.mjs 原有 UA 一致）
  // 2026-11 线上抓包：chat.deepseek.com 客户端运行在 Chromium 156 上
  // （sec-ch-ua 为 "Not:A-Brand";v="8", "Chromium";v="156", …），
  // 旧版 131 与新 x-client-version 2.7.0 存在明显版本断层，这里同步到 156。
  'chrome-win': {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    platform: 'Windows',
    mobile: false,
    uaFullVersion: '156.0.0.0',
    brands: [
      { brand: 'Google Chrome', version: '156' },
      { brand: 'Chromium', version: '156' },
      { brand: 'Not_A Brand', version: '8' },
    ],
    // 桌面 Chrome 的 sec-ch-ua 用不带空格的形式（Chromium 实际输出就是 Not_A Brand）
    arch: '"x86"',
    bitness: '"64"',
  },
  // Android Chrome（若账号原本来自移动端抓包，用它更自洽）
  'chrome-android': {
    ua: 'Mozilla/5.0 (Linux; Android 14; 24069RA21C Build/UKQ1.230804.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
    platform: 'Android',
    mobile: true,
    uaFullVersion: '156.0.0.0',
    brands: [
      { brand: 'Google Chrome', version: '156' },
      { brand: 'Chromium', version: '156' },
      { brand: 'Not_A Brand', version: '8' },
    ],
    arch: '""',
    bitness: '""',
  },
};

/** 组装 sec-ch-ua 头值：`"Brand";v="X", ...` */
export function buildSecChUa(brands) {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

/**
 * 生成/读取账号的设备画像。
 * 一旦写入 dataDir，后续始终复用，避免 UA/平台在不同时间跳跃被识别为「设备漂移」。
 */
export function resolveProfile(profileName, uaClientHints) {
  const profile = DEVICE_PROFILES[profileName] || DEVICE_PROFILES['chrome-win'];
  const fullVersionList = profile.brands
    .filter((b) => !/not/i.test(b.brand))
    .map((b) => ({ brand: b.brand, version: profile.uaFullVersion }))
    .concat([{ brand: 'Not_A Brand', version: '24.0.0.0' }]);

  return {
    profile,
    secChUa: buildSecChUa(profile.brands),
    fullVersionListHeader: buildSecChUa(fullVersionList),
    uaClientHints,
  };
}

/* -------------------------------------------------------------------------- */
/* 请求头：与真实 Chrome 对齐                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 构造一套「自洽」的浏览器请求头。
 *
 * 与旧版 12 个头的差别：
 *  - 补齐 sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform（Chrome 90+ 必发）
 *  - 补齐 sec-fetch-site / sec-fetch-mode / sec-fetch-dest（Chrome 发起请求必有）
 *  - accept-encoding 带上 br, zstd（undici 默认不含）
 *  - 补 priority: u=1, i（Chrome 对 fetch 请求会发）
 *  - accept-language 与 locale 一致
 *
 * 注意：这里「不」加 sec-ch-ua-full-version-list，因为真实 Chrome 只在
 *       Sec-CH-UA-Full-Version-List 被服务端 Accept-CH 请求时才发，
 *       日常请求里没有。多塞反而异常。
 */
export function buildBrowserHeaders({
  baseUrl,
  token,
  deviceId,
  profileName = 'chrome-win',
  locale = 'zh_CN',
  timezoneOffsetSec,
  withAuthorization = true,
  extra = {},
}) {
  const { profile } = resolveProfile(profileName);

  const headers = {
    // ---- 基础 ----
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    origin: baseUrl,
    referer: `${baseUrl}/`,
    'user-agent': profile.ua,

    // ---- User-Agent Client Hints ----
    'sec-ch-ua': buildSecChUa(profile.brands),
    'sec-ch-ua-mobile': profile.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${profile.platform}"`,

    // ---- Fetch Metadata ----
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    priority: 'u=1, i',
    // 线上抓包里浏览器固定带 dnt（Edge/Chrome 默认隐私设置下为 1）
    dnt: '1',

    // ---- DeepSeek 客户端标识 ----
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': locale,
    'x-client-platform': 'web',
    'x-client-timezone-offset': String(timezoneOffsetSec),
    'x-client-version': '2.7.0',
    'x-device-id': deviceId,
    // 桌面端为空值，但真实浏览器会显式发送这个头（抓包中值为空字符串）
    'x-device-model': '',
  };

  if (withAuthorization && token) headers.authorization = `Bearer ${token}`;

  // 注意：不要在这里加 x-requested-with。
  // 抓包里的 mark.via 是 Via 浏览器的特有标识，普通 Chrome 不会有；
  // 带上它反而暴露「这不是标准浏览器请求」。

  return { ...headers, ...extra };
}

/**
 * 上传类请求的头：multipart 自己带 boundary，
 * 必须移除 content-type，否则 boundary 丢失（沿用原逻辑）。
 */
export function buildUploadHeaders(opts) {
  const { 'content-type': _ignored, ...rest } = buildBrowserHeaders(opts);
  return rest;
}

/* -------------------------------------------------------------------------- */
/* 时序：把「太干净」的节奏打散                                                 */
/* -------------------------------------------------------------------------- */

/** [min, max) 区间随机整数 */
export function jitter(min, max) {
  return min + Math.floor(Math.random() * Math.max(1, max - min));
}

/** 模拟真人输入停顿：发送前随机等一小段 */
export function typingDelay() {
  return jitter(120, 480);
}

/**
 * PoW 求解耗时「伪装」。
 *
 * 真浏览器在 JS 里算 14.4 万次 SHA3 通常 150~800ms，而 Go 只要 20~30ms。
 * 一次 25ms 就完成的 PoW，在服务端看是明显的非 JS 环境特征。
 * 这里把总耗时补到随机区间内（只补不削）。
 */
export function padPowDuration(startedAt, targetMin = 120, targetMax = 520) {
  const target = jitter(targetMin, targetMax);
  const elapsed = Date.now() - startedAt;
  return Math.max(0, target - elapsed);
}

/* -------------------------------------------------------------------------- */
/* 冷启动序列：真浏览器不会「直接打 API」                                       */
/* -------------------------------------------------------------------------- */

/**
 * 真网页一次冷启动的顺序（来自实际抓包）：
 *
 *   GET  /api/v0/client/settings?did=...&scope=banner   拉配置
 *   (GET  风控 SDK smcp.min.js —— 需要执行 JS，这里无法复现)
 *   POST /api/v0/users/auth_token/check_device          校验设备
 *   POST /api/v0/client/settings/report                 配置回执
 *   POST /api/v0/telemetry                              event 上报
 *
 * 一次进程生命周期内只跑一次即可，不需要每次对话都跑。
 * 跑这些**不会**让请求更容易通过限流（限流按消息条数算），
 * 但能降低「账号行为不像网页」的画像分。
 *
 * 返回 did（网页端匿名设备 ID），后续 settings 请求复用它。
 */
export async function runColdStartSequence({
  baseUrl,
  headers,
  deviceId,
  log = { info() {}, warn() {}, debug() {} },
  fetchImpl = fetch,
}) {
  // did：网页端匿名设备 ID，和 x-device-id 是两套。
  // 真网页里它是 localStorage 里的 uuid，这里按 deviceId 派生，保证稳定。
  const did = crypto
    .createHash('sha256')
    .update(`did:${deviceId}`)
    .digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');

  const quiet = async (label, fn) => {
    try {
      const r = await fn();
      log.debug?.(`冷启动 ${label} ok`);
      return r;
    } catch (err) {
      log.warn?.(`冷启动 ${label} 失败（忽略）: ${err.message}`);
      return null;
    }
  };

  // 1) 拉配置
  const settingsUrl = `${baseUrl}/api/v0/client/settings?did=${encodeURIComponent(did)}&scope=banner`;
  const settings = await quiet('settings', async () => {
    const res = await fetchImpl(settingsUrl, {
      method: 'GET',
      headers: { ...headers, accept: 'application/json, text/plain, */*' },
    });
    return res.ok ? res.json() : null;
  });

  // 2) 设备校验
  await quiet('check_device', async () => {
    const res = await fetchImpl(`${baseUrl}/api/v0/users/auth_token/check_device`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ device_id: deviceId, device_model: '' }),
    });
    return res.ok ? res.json() : null;
  });

  // 3) 配置回执：上报本地已知配置项 ID
  const settingsIds = pickSettingsIds(settings);
  if (settingsIds.length) {
    await quiet('settings/report', async () => {
      const res = await fetchImpl(`${baseUrl}/api/v0/client/settings/report`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ settings_ids: settingsIds, did }),
      });
      return res.ok ? res.json() : null;
    });
  }

  // 4) telemetry：真实客户端会发，这里留空事件数组占位。
  //    没有 x-request-encryption-key 就不发，避免发出结构不合法的请求。
  //    （真正的加密遥测需要服务端公钥，属于另一套机制，不在此模块范围内）

  return { did };
}

/** 从 settings 响应里尽量提取配置项 ID */
function pickSettingsIds(settings) {
  const biz = settings?.data?.biz_data;
  if (!biz || typeof biz !== 'object') return [];
  const ids = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'number') ids.push(node.id);
    for (const v of Object.values(node)) walk(v);
  };
  walk(biz.settings);
  return ids.slice(0, 40);
}
