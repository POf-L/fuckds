#!/usr/bin/env node
/**
 * 只读查看持久化 profile 的登录态（不写凭据、不刷新、不启动第二个实例）。
 *
 *   npm run profile:status            # 只读探测：有活实例就复用，没有就什么都不启动
 *   npm run profile:status -- --launch  # 没有活实例时启动一次（唯一实例），看完即关
 *
 * 输出只有 key 名 / 布尔 / 长度，不打印 token、cookie、hif 原值。
 */
import { chromium } from 'playwright';

import { loadConfig } from '../src/config.mjs';
import {
  launchOrReusePersistent,
  liveProfilePort,
  readDevToolsPort,
  readProfileLock,
} from '../src/browser/profile-lock.mjs';

const config = loadConfig();
const profileDir = config.hybrid.profileDir;
const shouldLaunch = process.argv.includes('--launch');

const lock = readProfileLock(profileDir);
const livePort = await liveProfilePort(profileDir);

async function inspect(context) {
  const page = context.pages()[0] || (await context.newPage());
  const navigationError = await page
    .goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .then(() => null)
    .catch((err) => err.message);
  await page.waitForTimeout(2_500);

  const storage = await page.evaluate(() => {
    const keys = [];
    let tokenLength = 0;
    let hasHif = false;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || '';
      keys.push(key);
      const raw = localStorage.getItem(key) || '';
      if (key === 'userToken') tokenLength = raw.length;
      else if (raw.includes('"userToken"') || /userToken/.test(key)) tokenLength = tokenLength || raw.length;
      if (/hif_/i.test(key) || /"hif_/i.test(raw)) hasHif = true;
    }
    return { url: location.href, keys, tokenLength, hasHif };
  });

  const cookies = await context.cookies('https://chat.deepseek.com');
  return {
    url: storage.url,
    signedIn: !/\/sign_in/.test(storage.url) && storage.tokenLength > 0,
    userTokenLength: storage.tokenLength,
    hasHifCache: storage.hasHif,
    localStorageKeys: storage.keys,
    cookieNames: cookies.map((cookie) => cookie.name),
    navigationError,
  };
}

let result = {
    profileDir,
    lock,
    devtoolsPort: readDevToolsPort(profileDir),
    livePort,
    launched: false,
  };

if (livePort) {
  // 已有实例：只连 CDP，不新起浏览器
  const launched = await launchOrReusePersistent({
    chromium,
    profileDir,
    log: { info: () => {}, warn: () => {} },
    launch: async () => {
      throw new Error('不应走到这里：检测到活实例时应只复用');
    },
  });
  result.reused = launched.reused;
  result.instance = await inspect(launched.context);
  await launched.browser?.close?.().catch(() => {});
} else if (shouldLaunch) {
  const launched = await launchOrReusePersistent({
    chromium,
    profileDir,
    log: { info: () => {}, warn: () => {} },
    launch: (extraArgs) =>
      chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: config.browser.viewport,
        locale: config.browser.locale,
        args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', ...extraArgs],
      }),
  });
  result.launched = true;
  result.instance = await inspect(launched.context);
  if (launched.reused) await launched.browser?.close?.().catch(() => {});
  else await launched.context.close().catch(() => {});
} else {
  result.note = '没有活着的 profile 实例；未启动浏览器。需要看登录态请加 --launch（只会启动这一个实例）';
}

console.log(JSON.stringify(result, null, 2));
