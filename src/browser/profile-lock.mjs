import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UpstreamError } from '../errors.mjs';

/**
 * 持久化 profile 的单实例锁。
 *
 * 背景（实测 2026-11-05）：同一个 user-data-dir 被启动第二个 Chromium 时，
 * 新进程会把请求转交给已有实例后自己退出，Playwright 侧表现为 Target closed；
 * 而自动重开 profile 又在用户刚登录后触发，看起来像“登录态掉了”。实际上
 * 登录态一直在 profile 里，掉的是我们自己的实例。
 *
 * 规则：
 *   1. 同一 profile 只允许一个浏览器实例；
 *   2. 锁里的进程还活着且 CDP 可达 → 直接 connectOverCDP 复用，绝不启动第二个；
 *   3. 锁里的进程已死（崩溃/被强杀）→ 清掉陈旧锁后自己启动；
 *   4. 关闭浏览器时只释放锁，不删除 profile（登录态留在目录里）。
 *
 * 锁文件：<profileDir>/.gateway-profile.lock，内容是 JSON（pid / port / at）。
 * 端口来源：Chromium 自己写的 <profileDir>/DevToolsActivePort（用 --remote-debugging-port=0 启动）。
 */

export const PROFILE_LOCK_FILE = '.gateway-profile.lock';
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';

export function profileLockPath(profileDir) {
  return path.join(profileDir, PROFILE_LOCK_FILE);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但当前用户没权限发信号（Windows 上常见），仍算活着
    return err?.code === 'EPERM';
  }
}

export function readProfileLock(profileDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(profileLockPath(profileDir), 'utf8'));
    if (!parsed || !Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function releaseProfileLock(profileDir, pid = process.pid) {
  const lock = readProfileLock(profileDir);
  // 只释放自己的锁，避免误删别的实例持有的锁
  if (lock && lock.pid !== pid) return false;
  try {
    fs.rmSync(profileLockPath(profileDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 读取 Chromium 写的 DevTools 端口（--remote-debugging-port=0 时由它决定） */
export function readDevToolsPort(profileDir) {
  try {
    const first = fs.readFileSync(path.join(profileDir, DEVTOOLS_PORT_FILE), 'utf8').split('\n')[0].trim();
    const port = Number(first);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function cdpReachable(port, timeoutMs = 1_500) {
  if (!port) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 是否已有活着的 profile 浏览器实例（只读，不启动任何东西）。
 * 返回端口号或 null。
 */
export async function liveProfilePort(profileDir) {
  if (!profileDir) return null;
  const lock = readProfileLock(profileDir);
  if (lock && lock.pid !== process.pid && isProcessAlive(lock.pid)) {
    const port = readDevToolsPort(profileDir) || lock.port || null;
    return (await cdpReachable(port)) ? port : null;
  }
  // 没有锁也可能是 Chromium 自己起的（例如 Chromium 崩溃后残留）：以端口探测为准
  const port = readDevToolsPort(profileDir);
  return (await cdpReachable(port)) ? port : null;
}

async function waitForDevToolsPort(profileDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const port = readDevToolsPort(profileDir);
    if (port && (await cdpReachable(port))) return port;
    if (Date.now() >= deadline) return port;
    await sleep(300);
  }
}

/**
 * 复用或启动 profile 实例。
 *
 * @param {object} args
 * @param {import('playwright').BrowserType} args.chromium Playwright 的 chromium
 * @param {string} args.profileDir 持久化目录
 * @param {object} [args.log] logger（有 info/warn 即可）
 * @param {number} [args.waitMs] 锁被活进程占用但 CDP 未就绪时的最长等待（默认 20s）
 * @param {(extraArgs: string[]) => Promise<object>} args.launch 真正启动的函数，返回 BrowserContext
 * @returns {Promise<{context, browser, reused, port, release}>}
 */
export async function launchOrReusePersistent({
  chromium,
  profileDir,
  log,
  waitMs = 20_000,
  readyTimeoutMs = 10_000,
  launch,
}) {
  if (!profileDir) throw new UpstreamError('profileDir 为空，无法启动持久化浏览器', { code: 'profile_dir_missing' });
  fs.mkdirSync(profileDir, { recursive: true });
  const deadline = Date.now() + waitMs;

  for (;;) {
    const lock = readProfileLock(profileDir);
    if (lock && lock.pid !== process.pid && isProcessAlive(lock.pid)) {
      const port = readDevToolsPort(profileDir) || lock.port || null;
      if (await cdpReachable(port)) {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0] || (await browser.newContext());
        log?.info?.('复用已在运行的 profile 实例（CDP），不启动第二个浏览器', {
          ownerPid: lock.pid,
          port,
        });
        return { context, browser, reused: true, port, ownerPid: lock.pid, release: async () => {} };
      }
      if (Date.now() >= deadline) {
        throw new UpstreamError(
          `profile 正被进程 ${lock.pid} 占用且 CDP 端口 ${port || '?'} 不可用；拒绝启动第二个实例（会顶掉现有登录态）`,
          { code: 'profile_in_use' },
        );
      }
      await sleep(600);
      continue;
    }

    // 锁的主人已经不在了（或残留锁是自己的），清掉后自己启动
    try {
      fs.rmSync(profileLockPath(profileDir), { force: true });
      fs.rmSync(path.join(profileDir, DEVTOOLS_PORT_FILE), { force: true });
    } catch {
      /* ignore */
    }

    try {
      fs.writeFileSync(
        profileLockPath(profileDir),
        JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname(), port: null }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (err) {
      if (err?.code === 'EEXIST') {
        // 另一个进程刚好抢到锁：等它把 CDP 拉起来后走复用分支
        if (Date.now() >= deadline) {
          throw new UpstreamError('profile 锁被其他进程抢占，拒绝启动第二个实例', { code: 'profile_in_use' });
        }
        await sleep(600);
        continue;
      }
      throw err;
    }

    let context;
    try {
      context = await launch(['--remote-debugging-port=0']);
      const port = await waitForDevToolsPort(profileDir, readyTimeoutMs);
      try {
        fs.writeFileSync(
          profileLockPath(profileDir),
          JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname(), port }),
          { mode: 0o600 },
        );
      } catch {
        /* 锁信息更新失败不影响使用 */
      }
      const release = async () => {
        releaseProfileLock(profileDir);
      };
      context.on?.('close', () => {
        void release();
      });
      log?.info?.('已启动 profile 实例并持有单实例锁', { profileDir, port, pid: process.pid });
      return { context, browser: context.browser?.() ?? null, reused: false, port, ownerPid: process.pid, release };
    } catch (err) {
      releaseProfileLock(profileDir);
      throw err;
    }
  }
}
