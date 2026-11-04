import crypto from 'node:crypto';
import fs from 'node:fs';

import { loadConfig } from '../src/config.mjs';
import { DirectEngine } from '../src/direct/client.mjs';
import { buildProtocolExtras } from '../src/protocol/credentials.mjs';

const CREDS_FILE = 'data/verify-creds.t0.json';
const LOG_FILE = 'data/verify-lifetime.jsonl';
const OUT_FILE = 'data/verify-lifetime.json';

const log = { info() {}, warn() {}, debug() {}, error() {} };

function digest(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseAges() {
  const raw = process.env.PROBE_AGES_MIN || '1,10,30';
  return raw
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x >= 0)
    .sort((a, b) => a - b);
}

function append(entry) {
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
}

async function main() {
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  const config = loadConfig(process.env);
  config.deepseek.token = creds.userToken;
  config.deepseek.tokens = [creds.userToken];
  config.deepseek.deviceIds = { [creds.userToken]: creds.deviceId };
  config.deepseek.protocolExtras = buildProtocolExtras(creds);
  config.deepseek.coldStart = false;
  config.deepseek.timeoutMs = 120000;

  const t0 = creds.harvestedAt;
  const ages = parseAges();
  const probes = [];

  // 记录服务端是否刷新 cookie：只留名字/长度/hash，不打印值
  const initialCookieHash = Object.fromEntries(creds.cookies.map((c) => [c.name, digest(c.value)]));
  const responses = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const res = await origFetch(url, opts);
    if (String(url).includes('/api/v0/')) {
      const setCookies = res.headers.getSetCookie
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')]
          : [];
      responses.push({
        at: Date.now(),
        ageMs: Date.now() - t0,
        path: new URL(url).pathname,
        status: res.status,
        contentType: res.headers.get('content-type'),
        setCookie: setCookies.map((s) => {
          const name = s.split('=')[0];
          const value = s.slice(name.length + 1).split(';')[0];
          return {
            name,
            valueLen: value.length,
            changedVsT0: initialCookieHash[name] ? initialCookieHash[name] !== digest(value) : 'new',
          };
        }),
      });
    }
    return res;
  };
  fs.writeFileSync(LOG_FILE, '');
  append({ event: 'start', t0Iso: new Date(t0).toISOString(), agesMin: ages });

  const engine = new DirectEngine({ config, logger: log });
  try {
    for (const ageMin of ages) {
      const target = t0 + ageMin * 60_000;
      const waitMs = target - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      const startedAt = Date.now();
      const beforeResponseCount = responses.length;
      const entry = {
        event: 'probe',
        ageMin,
        ageMs: startedAt - t0,
        startedIso: new Date(startedAt).toISOString(),
      };
      try {
        const res = await engine.chat({ prompt: '你好', thinking: false, search: false });
        Object.assign(entry, {
          result: 'OK',
          elapsedMs: Date.now() - startedAt,
          textChars: (res.text || '').length,
          text: res.text,
          deltas: null,
          timings: res.timings,
          usage: res.usage,
        });
      } catch (err) {
        Object.assign(entry, {
          result: 'FAIL',
          elapsedMs: Date.now() - startedAt,
          errorName: err.name,
          status: err.status ?? null,
          code: err.code ?? null,
          message: err.message,
          retryAfter: err.retryAfter ?? null,
        });
      }
      entry.responses = responses.slice(beforeResponseCount);
      probes.push(entry);
      append(entry);
      console.log(JSON.stringify({ probe: { ageMin, result: entry.result, elapsedMs: entry.elapsedMs, errorName: entry.errorName || null, status: entry.status ?? null, code: entry.code ?? null, textChars: entry.textChars ?? null } }));
    }
  } finally {
    await engine.close().catch(() => {});
    globalThis.fetch = origFetch;
  }

  const out = {
    t0Iso: new Date(t0).toISOString(),
    finishedIso: new Date().toISOString(),
    agesMin: ages,
    probes,
    responses,
    credentials: {
      cookieCount: creds.cookies.length,
      cookieNames: creds.cookies.map((c) => c.name),
      expires: creds.cookies.map((c) => ({ name: c.name, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })),
    },
  };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  append({ event: 'done', ok: probes.filter((p) => p.result === 'OK').length, fail: probes.filter((p) => p.result === 'FAIL').length });
  console.log(JSON.stringify({ done: true, probes: probes.map((p) => ({ ageMin: p.ageMin, result: p.result })) }));
}

main().catch((err) => {
  append({ event: 'error', message: err.message, stack: err.stack });
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
