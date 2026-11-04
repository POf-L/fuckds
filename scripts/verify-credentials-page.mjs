import crypto from 'node:crypto';
import fs from 'node:fs';

import { chromium } from 'playwright';

import { loadConfig } from '../src/config.mjs';
import { hybridLaunchArgs } from '../src/hybrid/client.mjs';
import { cookieHeaderFrom } from '../src/protocol/credentials.mjs';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const out = {};

function digest(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

function inspectValue(raw) {
  if (raw == null) return { type: 'null' };
  let parsed;
  let outer;
  try {
    parsed = JSON.parse(raw);
    outer = Array.isArray(parsed) ? 'array' : typeof parsed;
  } catch {
    return { rawLen: String(raw).length, outer: 'raw', sha8: digest(raw) };
  }
  const info = { rawLen: String(raw).length, outer, sha8: digest(raw) };
  if (typeof parsed === 'string') {
    info.inner = 'string';
    info.innerLen = parsed.length;
    info.innerSha8 = digest(parsed);
    try {
      const deep = JSON.parse(parsed);
      info.deepType = Array.isArray(deep) ? 'array' : typeof deep;
      if (deep && typeof deep === 'object' && !Array.isArray(deep)) {
        info.deepKeys = Object.keys(deep);
        for (const [k, v] of Object.entries(deep)) {
          if (typeof v === 'number') {
            info.deepNumbers = { ...(info.deepNumbers || {}), [k]: v };
            if (v > 1e9 && v < 1e13) {
              info.deepTimes = {
                ...(info.deepTimes || {}),
                [k]: { raw: v, iso: new Date(v > 1e12 ? v : v * 1000).toISOString() },
              };
            }
          }
        }
      }
    } catch {
      info.deepType = 'not-json';
    }
  } else if (parsed && typeof parsed === 'object') {
    info.keys = Object.keys(parsed);
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number') {
        info.numbers = { ...(info.numbers || {}), [k]: v };
        if (v > 1e9 && v < 1e13) {
          info.times = {
            ...(info.times || {}),
            [k]: { raw: v, iso: new Date(v > 1e12 ? v : v * 1000).toISOString() },
          };
        }
      } else if (typeof v === 'string') {
        info.stringLens = { ...(info.stringLens || {}), [k]: v.length };
      }
    }
  }
  return info;
}

const HINTS = ['hif_leim_cached', 'hif_dliq_cached', 'hif_leim', 'hif_dliq'];
const KEYWORDS = ['ttl', 'refresh', 'interval', 'expire', 'cached', 'setInterval'];

function scanText(text) {
  const hits = [];
  for (const hint of HINTS) {
    let idx = text.indexOf(hint);
    let n = 0;
    while (idx >= 0 && n < 8) {
      hits.push({
        needle: hint,
        offset: idx,
        snippet: text.slice(Math.max(0, idx - 240), idx + 320).replace(/\s+/g, ' '),
      });
      idx = text.indexOf(hint, idx + hint.length);
      n += 1;
    }
  }
  return hits;
}

function scanKeywords(text) {
  const res = {};
  for (const kw of KEYWORDS) {
    const i = text.indexOf(kw);
    if (i >= 0) res[kw] = { offset: i, snippet: text.slice(Math.max(0, i - 120), i + 180).replace(/\s+/g, ' ') };
  }
  return res;
}

async function main() {
  const observeSec = Number(process.env.OBSERVE_SEC || 300);
  const config = loadConfig(process.env);
  const ctx = await chromium.launchPersistentContext(config.hybrid.profileDir, {
    headless: false,
    channel: config.hybrid.channel || undefined,
    args: hybridLaunchArgs(),
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(localStorage.getItem('userToken')), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // ---- A1 静态：页面加载了哪些 JS，抓 body 搜 hif 相关 ----
    const scripts = await page.evaluate(() => {
      const urls = new Set();
      for (const s of performance.getEntriesByType('resource')) {
        if (/\.js(\?|$)/.test(s.name) || s.initiatorType === 'script') urls.add(s.name);
      }
      for (const el of document.querySelectorAll('script[src]')) urls.add(el.src);
      return [...urls];
    });
    out.scripts = { count: scripts.length, urls: scripts.slice(0, 40) };
    const scanned = [];
    for (const url of scripts) {
      let body = '';
      try {
        const res = await ctx.request.get(url, { timeout: 20000 });
        if (!res.ok()) continue;
        body = await res.text();
      } catch {
        continue;
      }
      const hits = scanText(body);
      if (!hits.length) continue;
      scanned.push({
        url,
        bytes: body.length,
        hits: hits.slice(0, 6),
        keywords: scanKeywords(body),
      });
      if (scanned.length >= 6) break;
    }
    out.bundle = { scannedFiles: scanned.length, files: scanned };

    // ---- A1 / B：localStorage 结构与 cookie 属性 ----
    const storage = await page.evaluate(() => {
      const rows = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        const raw = localStorage.getItem(key);
        rows.push({ key, raw: raw == null ? null : String(raw) });
      }
      return rows;
    });
    out.localStorageKeys = storage.map(({ key, raw }) => ({ key, ...inspectValue(raw) }));

    const cookies = await ctx.cookies('https://chat.deepseek.com');
    out.cookies = cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      expires: c.expires,
      expiresIso: c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session',
      valueLen: c.value.length,
    }));
    const wafTime = cookies.find((c) => c.name === 'HWWAFSESTIME');
    if (wafTime) {
      const dec = Number(wafTime.value);
      const hex = Number.parseInt(wafTime.value, 16);
      for (const [kind, n] of [['decimal', dec], ['hex', hex]]) {
        if (Number.isFinite(n) && n > 1e9 && n < 1e13) {
          out.hwwafTime = { kind, raw: n, iso: new Date(n > 1e12 ? n : n * 1000).toISOString() };
          break;
        }
      }
      if (!out.hwwafTime) out.hwwafTime = { kind: 'unrecognized', valueLen: wafTime.value.length };
    }

    // ---- A2 被动观察：只轮询 localStorage，不发请求 ----
    const pollMs = 1000;
    const startedAt = Date.now();
    const samples = [];
    let prev = null;
    while (Date.now() - startedAt < observeSec * 1000) {
      const snap = await page.evaluate(() => ({
        leim: localStorage.getItem('hif_leim_cached'),
        dliq: localStorage.getItem('hif_dliq_cached'),
      }));
      const cur = { leim: snap.leim || '', dliq: snap.dliq || '' };
      if (prev && (cur.leim !== prev.leim || cur.dliq !== prev.dliq)) {
        samples.push({
          at: Date.now(),
          elapsedMs: Date.now() - startedAt,
          leimChanged: cur.leim !== prev.leim,
          dliqChanged: cur.dliq !== prev.dliq,
          leimSha8: digest(cur.leim),
          dliqSha8: digest(cur.dliq),
        });
      }
      prev = cur;
      await page.waitForTimeout(pollMs);
    }
    out.observation = {
      durationMs: Date.now() - startedAt,
      pollMs,
      changes: samples,
      changeCount: samples.length,
    };

    // ---- 用当前页面直接生成凭据快照（不再开第二个浏览器） ----
    const local = await page.evaluate(() => {
      const unwrap = (key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return '';
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed === 'string') return parsed;
          if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string') return parsed.value;
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
      harvestMs: 0,
    };
    record.cookieHeader = cookieHeaderFrom(record.cookies);
    fs.writeFileSync(config.protocol.credentialsFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync('data/verify-creds.t0.json', `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    out.snapshot = {
      file: 'data/verify-creds.t0.json',
      harvestedAt: record.harvestedAt,
      cookieCount: record.cookies.length,
      hasToken: Boolean(record.userToken),
      hasHifLeim: Boolean(record.hifLeim),
      hasHifDliq: Boolean(record.hifDliq),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
  fs.writeFileSync('data/verify-page.json', `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }));
  process.exit(1);
});
