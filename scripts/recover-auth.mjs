/**
 * 自动恢复凭据探针（按优先级逐级尝试，不打印任何 token/cookie/hif 原值）。
 *
 * 步骤：
 *   1) 复用 CDP 已登录的 Edge（127.0.0.1:9222）
 *   2) 复用 data/hybrid-profile 登录态
 *   3) 只读扫描用户日常 Edge profile 的 Local Storage（leveldb 副本）
 *   4) 复用 LIGHT_PROFILE_DIR
 *
 * 产出：evidence/recover-auth.json（只含存在性/长度/sha256 前缀）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { chromium } from 'playwright';

import { loadConfig } from '../src/config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EVIDENCE = 'C:\\Users\\24494\\Documents\\Trae-CN\\temp_20261103_07\\oc-tool-verify\\evidence';
const OUT = path.join(EVIDENCE, 'recover-auth.json');
const raw = process.argv.slice(2);
const ONLY = raw.find((a) => a.startsWith('--only='))?.slice(7) || '';
const config = loadConfig();
const baseUrl = config.browser.baseUrl || 'https://chat.deepseek.com';

const sha8 = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 8) : null);

const report = {
  startedAt: new Date().toISOString(),
  steps: [],
  recovered: null,
};

function save() {
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
}

const READ_TOKEN = () =>
  (() => {
    const unwrap = (key) => {
      const v = localStorage.getItem(key);
      if (!v) return '';
      try {
        const p = JSON.parse(v);
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && typeof p.value === 'string') return p.value;
        return v;
      } catch {
        return v;
      }
    };
    return {
      userToken: unwrap('userToken'),
      deviceId: localStorage.getItem('deepseek-device-id:chat') || '',
      hifLeim: unwrap('hif_leim_cached'),
      hifDliq: unwrap('hif_dliq_cached'),
      ua: navigator.userAgent,
      languages: navigator.languages,
      platform: navigator.platform,
      brands: navigator.userAgentData?.brands || [],
      mobile: navigator.userAgentData?.mobile ?? false,
    };
  })();

async function snapshotFromContext(ctx, page, label, evidenceDetail) {
  const local = await page.evaluate(READ_TOKEN).catch(() => null);
  const cookies = await ctx.cookies('https://chat.deepseek.com').catch(() => []);
  const token = local?.userToken || '';
  const info = {
    label,
    detail: evidenceDetail,
    pageUrl: page.url().replace(/[?#].*$/, ''),
    signedIn: Boolean(token),
    tokenLen: token.length,
    tokenSha8: sha8(token),
    cookieCount: cookies.length,
    cookieNames: cookies.map((c) => c.name).sort(),
    hasHifLeim: Boolean(local?.hifLeim),
    hasHifDliq: Boolean(local?.hifDliq),
  };
  report.steps.push(info);
  if (!token) return null;

  const record = {
    ...local,
    userAgent: local.ua,
    harvestedAt: Date.now(),
    harvestMs: 0,
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      domain: c.domain,
      expires: c.expires,
    })),
  };
  record.cookieHeader = record.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const credFile = path.join(ROOT, 'data', 'protocol-credentials.json');
  fs.writeFileSync(credFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  report.recovered = { via: label, credFile, tokenLen: token.length, tokenSha8: sha8(token), cookieCount: cookies.length };
  save();
  return record;
}

async function stepCdp() {
  const step = { step: 1, name: 'cdp-9222' };
  let version;
  try {
    version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
    step.ok = true;
    step.browser = String(version.Browser || '').slice(0, 60);
  } catch (err) {
    step.ok = false;
    step.error = `CDP 连接失败：${err.message}`;
    report.steps.push(step);
    return null;
  }
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find((p) => p.url().includes('chat.deepseek.com'));
    const opened = !page;
    if (!page) page = await ctx.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);
    const rec = await snapshotFromContext(ctx, page, 'cdp-9222', { reusedExistingTab: !opened });
    if (opened) await page.close().catch(() => {});
    return rec;
  } catch (err) {
    step.ok = false;
    step.error = `CDP 接管失败：${err.message}`;
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function stepHybridProfile() {
  const step = { step: 2, name: 'hybrid-profile', profileDir: config.hybrid.profileDir };
  if (!fs.existsSync(config.hybrid.profileDir)) {
    step.ok = false;
    step.error = 'hybrid-profile 目录不存在';
    report.steps.push(step);
    return null;
  }
  let ctx;
  try {
    const options = {
      headless: true,
      locale: config.browser.locale,
      timezoneId: process.env.TZ || 'Asia/Shanghai',
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    };
    const ep = config.hybrid.executablePath;
    if (ep) ctx = await chromium.launchPersistentContext(config.hybrid.profileDir, { ...options, executablePath: ep });
    else {
      try {
        ctx = await chromium.launchPersistentContext(config.hybrid.profileDir, { ...options, channel: config.hybrid.channel });
      } catch {
        ctx = await chromium.launchPersistentContext(config.hybrid.profileDir, options);
      }
    }
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);
    step.ok = true;
    return await snapshotFromContext(ctx, page, 'hybrid-profile', {});
  } catch (err) {
    step.ok = false;
    step.error = `hybrid-profile 启动/读取失败：${err.message}`;
    return null;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

function scanLevelDb(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(ldb|log)$/.test(f)) : [];
  const hits = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    for (const needle of ['userToken', 'https://chat.deepseek.com']) {
      let idx = buf.indexOf(needle);
      while (idx >= 0 && hits.length < 3) {
        hits.push({ file: f, needle, at: idx, ascii: buf.subarray(idx, idx + 220).toString('latin1') });
        idx = buf.indexOf(needle, idx + 1);
        if (hits.length >= 3) break;
      }
    }
  }
  return { dir, fileCount: files.length, hits };
}

async function stepEdgeProfile() {
  const step = { step: 3, name: 'edge-user-profile' };
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge Beta', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge Dev', 'User Data'),
  ];
  const dirs = [];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      if (!/^Default|^Profile \d+$/.test(name)) continue;
      const ls = path.join(base, name, 'Local Storage', 'leveldb');
      if (fs.existsSync(ls)) dirs.push(ls);
    }
  }
  step.checkedDirs = dirs;
  if (dirs.length === 0) {
    step.ok = false;
    step.error = '用户日常 Edge profile 目录不存在（%LOCALAPPDATA%\\Microsoft\\Edge\\User Data 未找到）';
    report.steps.push(step);
    return null;
  }
  const scans = dirs.map(scanLevelDb);
  step.scans = scans.map((s) => ({ dir: s.dir, fileCount: s.fileCount, hits: s.hits.length, tokens: s.hits.map((h) => ({ file: h.file, len: h.ascii.length, has64: Boolean(/[A-Za-z0-9_-]{60,80}/.test(h.ascii)) })) }));
  const found = scans.flatMap((s) => s.hits).find((h) => h.needle === 'userToken');
  if (!found) {
    step.ok = false;
    step.error = 'leveldb 副本里未找到 userToken 键（cookie 加密库未解析）';
    report.steps.push(step);
    return null;
  }
  // Edge 的 Local Storage 值在 leveldb 里是可读 UTF-8，直接取紧随其后的可打印串
  const tokenMatch = found.ascii.match(/[A-Za-z0-9_-]{60,90}/);
  step.ok = Boolean(tokenMatch);
  step.tokenLen = tokenMatch ? tokenMatch[0].length : 0;
  step.tokenSha8 = sha8(tokenMatch?.[0] || '');
  step.error = tokenMatch ? undefined : '找到键但未匹配到 token 值';
  report.steps.push(step);
  return null; // 只有 token 没有 cookie，不直接落盘；交由下一步/用户决定
}

async function stepLightProfile() {
  const step = { step: 4, name: 'light-profile', profileDir: config.light.profileDir };
  if (!config.light.profileDir || !fs.existsSync(config.light.profileDir)) {
    step.ok = false;
    step.error = 'LIGHT_PROFILE_DIR 未设置或目录不存在';
    report.steps.push(step);
    return null;
  }
  return stepHybridProfileLike(config.light.profileDir, step);
}

async function stepHybridProfileLike(profileDir, step) {
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      locale: config.browser.locale,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);
    step.ok = true;
    return await snapshotFromContext(ctx, page, 'light-profile', {});
  } catch (err) {
    step.ok = false;
    step.error = `light-profile 启动/读取失败：${err.message}`;
    return null;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

(async () => {
  save();
  if (!ONLY || ONLY === 'cdp') {
    if (await stepCdp()) return finish();
  }
  if (!ONLY || ONLY === 'hybrid') {
    if (await stepHybridProfile()) return finish();
  }
  if (!ONLY || ONLY === 'edge') {
    await stepEdgeProfile();
    if (report.recovered) return finish();
  }
  if (!ONLY || ONLY === 'light') {
    if (await stepLightProfile()) return finish();
  }
  finish();
})();

function finish() {
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ recovered: report.recovered, steps: report.steps.map((s) => ({ step: s.step, name: s.name, ok: s.ok, error: s.error || null, signedIn: s.signedIn ?? null, tokenLen: s.tokenLen ?? null })) }, null, 2));
}
