import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { ProtocolEngine } from '../src/protocol/client.mjs';
import { cookieHeaderFrom } from '../src/protocol/credentials.mjs';

const BAD_FILE = 'data/verify-bad-creds.json';
const OUT_FILE = 'data/verify-degradation.json';
const ISOLATED_PROFILE = 'data/verify-isolated-profile';

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function makeLogger(events) {
  const logger = {
    info: (msg, data) => events.push({ level: 'info', msg, data }),
    warn: (msg, data) => events.push({ level: 'warn', msg, data }),
    error: (msg, data) => events.push({ level: 'error', msg, data }),
    debug: () => {},
  };
  logger.child = () => logger;
  return logger;
}

async function main() {
  // 假凭据：绝不包含真实账号材料。cookie 值也显式写成无效占位。
  const fakeCookies = [
    { name: 'smidV2', value: 'verify-invalid-smid', httpOnly: false, secure: true, sameSite: 'Lax', domain: '.deepseek.com', expires: Date.now() + 60_000 },
    { name: 'HWWAFSESID', value: 'verify-invalid-waf', httpOnly: true, secure: true, sameSite: 'Lax', domain: '.deepseek.com', expires: -1 },
    { name: 'ds_session_id', value: 'verify-invalid-session', httpOnly: true, secure: true, sameSite: 'Strict', domain: '.deepseek.com', expires: -1 },
  ];
  const badCreds = {
    userToken: 'verify-invalid-token-do-not-use',
    deviceId: 'verify-invalid-device',
    hifLeim: 'verify-invalid-hif-leim',
    hifDliq: 'verify-invalid-hif-dliq',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
    languages: ['zh-CN'],
    platform: 'Win32',
    brands: [],
    mobile: false,
    cookies: fakeCookies,
    cookieHeader: cookieHeaderFrom(fakeCookies),
    harvestedAt: Date.now(),
    harvestMs: 0,
  };
  fs.writeFileSync(BAD_FILE, `${JSON.stringify(badCreds, null, 2)}\n`, { mode: 0o600 });

  const config = loadConfig(process.env);
  config.protocol.credentialsFile = path.resolve(BAD_FILE);
  config.protocol.refreshOnAuthFail = true;
  config.protocol.fallbackToHybrid = true;
  config.protocol.harvestWaitMs = 2500;
  config.hybrid.profileDir = path.resolve(ISOLATED_PROFILE);
  // 关键：不用 msedge channel。Windows 上已有 Edge 进程时，Edge 会复用现有实例/忽略
  // --user-data-dir，隔离 profile 会意外读到真实登录态。这里强制用 Playwright 自带 Chromium。
  config.hybrid.channel = null;
  config.hybrid.headless = true;
  config.hybrid.idleCloseMs = 60_000;
  config.hybrid.navigationTimeoutMs = 20_000;
  config.hybrid.reconnectMaxAttempts = 1;
  config.deepseek.coldStart = false;
  config.deepseek.timeoutMs = 60_000;

  const events = [];
  const logger = makeLogger(events);
  const badHashBefore = sha256(BAD_FILE);
  const realHashBefore = sha256(config.protocol.credentialsFile === path.resolve(BAD_FILE) ? 'data/protocol-credentials.json' : 'data/protocol-credentials.json');
  const engine = new ProtocolEngine({ config, logger });
  const stages = [];
  const snap = (label) => {
    const s = engine.status();
    stages.push({
      label,
      layer: s.layer,
      degradations: s.degradations,
      lastReason: s.lastReason,
      credentialSource: s.credentialSource,
      lastRefreshAt: s.lastRefreshAt,
      credentials: s.credentials ? { hasToken: s.credentials.hasToken, cookieCount: s.credentials.cookieCount } : null,
    });
  };

  const startedAt = Date.now();
  let error = null;
  try {
    await engine.ensureStarted();
    snap('after-ensureStarted');
    await engine.chat({ prompt: '你好' });
  } catch (err) {
    error = { name: err.name, status: err.status ?? null, code: err.code ?? null, message: err.message };
  }
  snap('after-chat');
  const totalMs = Date.now() - startedAt;
  await engine.close().catch(() => {});

  const badHashAfter = sha256(BAD_FILE);
  const realHashAfter = sha256('data/protocol-credentials.json');
  const out = {
    startedIso: new Date(startedAt).toISOString(),
    totalMs,
    error,
    stages,
    events,
    files: {
      badCreds: { path: BAD_FILE, hashBefore: badHashBefore, hashAfter: badHashAfter, unchanged: badHashBefore === badHashAfter },
      realCreds: { path: 'data/protocol-credentials.json', hashBefore: realHashBefore, hashAfter: realHashAfter, unchanged: realHashBefore === realHashAfter },
      isolatedProfile: path.resolve(ISOLATED_PROFILE),
    },
  };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }));
  process.exit(1);
});
