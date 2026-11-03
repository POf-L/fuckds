/**
 * hybrid 独立 profile 的登录/引导工具。
 *
 * 用法：
 *   npm run auth:hybrid                 # 打开独立 profile，手动登录（登录态留在 profile 目录）
 *   npm run auth:hybrid -- --from-cdp http://127.0.0.1:9222
 *                                      # 从已登录的外部浏览器复制 storageState 引导一次
 *                                      # （仅用于本机迁移登录态；不打印任何 token/cookie 值）
 *
 * 注意：默认 profile 是 data/hybrid-profile，不会碰用户日常浏览器，也不会默认连 9222。
 */

import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

import { CONFIG_ROOT, loadConfig } from '../src/config.mjs';

const args = process.argv.slice(2);
const fromCdpIdx = args.indexOf('--from-cdp');
const fromCdp = fromCdpIdx >= 0 ? String(args[fromCdpIdx + 1] || '') : '';
const config = loadConfig();
const profileDir = config.hybrid.profileDir;
const channel = config.hybrid.channel;
const executablePath = config.hybrid.executablePath;

fs.mkdirSync(profileDir, { recursive: true });

async function launch(storageState) {
  const options = {
    headless: false,
    viewport: config.browser.viewport,
    locale: config.browser.locale,
    timezoneId: process.env.TZ || 'Asia/Shanghai',
    args: [
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    storageState: storageState || undefined,
  };
  if (executablePath) return chromium.launchPersistentContext(profileDir, { ...options, executablePath });
  try {
    return await chromium.launchPersistentContext(profileDir, { ...options, channel });
  } catch (err) {
    console.warn(`channel=${channel} 启动失败，回退自带 Chromium：${err.message}`);
    return chromium.launchPersistentContext(profileDir, options);
  }
}

const signedIn = (page) =>
  page
    .evaluate(() => {
      try {
        return Boolean(localStorage.getItem('userToken'));
      } catch {
        return false;
      }
    })
    .catch(() => false);

if (fromCdp) {
  console.log(`从外部浏览器复制登录态（仅本机）：${fromCdp}`);
  const browser = await chromium.connectOverCDP(fromCdp);
  const context = browser.contexts()[0];
  if (!context) throw new Error('外部浏览器没有可用的 context');
  const statePath = path.join(CONFIG_ROOT, 'data', '.hybrid-storage-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
  // connectOverCDP 的 close 只断开，不会关掉对方浏览器
  await browser.close();

  const persistent = await launch(statePath);
  try {
    const page = persistent.pages()[0] || (await persistent.newPage());
    await page.goto(`${config.browser.baseUrl || 'https://chat.deepseek.com'}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);
    console.log(`独立 profile 登录态：${(await signedIn(page)) ? '已就绪' : '未就绪（可能复制的会话已过期）'}`);
  } finally {
    await persistent.close();
    fs.rmSync(statePath, { force: true });
  }
} else {
  console.log(`打开独立 profile：${profileDir}`);
  console.log('请在打开的浏览器里登录 https://chat.deepseek.com（脚本会等待登录完成，最多 10 分钟）');
  const persistent = await launch();
  let ok = false;
  try {
    const page = persistent.pages()[0] || (await persistent.newPage());
    await page.goto(`${config.browser.baseUrl || 'https://chat.deepseek.com'}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (await signedIn(page)) {
        ok = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    if (ok) {
      await page.waitForTimeout(3_000); // 给 localStorage/cookie 落盘
      console.log('登录完成，登录态已写入 profile；之后 hybrid 会冷启动复用。');
    } else {
      console.error('等待超时：没有在 localStorage 里检测到 userToken，profile 未就绪。');
    }
  } finally {
    await persistent.close();
  }
  if (!ok) process.exitCode = 1;
}
