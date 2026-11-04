import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

import { chromium } from 'playwright';

const HOST = 'chat.deepseek.com';
const OUT_DIR = 'data';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';

function read24(buf, p) {
  return (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
}

/** 解析 ClientHello；返回 JA3 组件、ALPN、SNI，不依赖外部库 */
function parseClientHello(buf) {
  try {
    if (buf[0] !== 0x16) return null;
    const recLen = buf.readUInt16BE(3);
    if (buf.length < 5 + recLen) return { incomplete: true, need: 5 + recLen };
    let p = 5;
    if (buf[p] !== 1) return null;
    const hsLen = read24(buf, p + 1);
    p += 4;
    if (hsLen > recLen) return null;
    const legacyVersion = buf.readUInt16BE(p);
    p += 2;
    p += 32;
    const sidLen = buf[p];
    p += 1 + sidLen;
    const csLen = buf.readUInt16BE(p);
    p += 2;
    const ciphers = [];
    for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(p + i));
    p += csLen;
    const compLen = buf[p];
    p += 1 + compLen;
    const extTotal = buf.readUInt16BE(p);
    p += 2;
    const end = Math.min(buf.length, p + extTotal);
    const exts = [];
    const groups = [];
    const pointFormats = [];
    const alpn = [];
    let sni = false;
    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      const d = p + 4;
      exts.push(type);
      if (type === 0x0000) sni = true;
      if (type === 0x000a && len >= 2) {
        const gl = buf.readUInt16BE(d);
        for (let i = 0; i < gl && d + 2 + i + 1 < end; i += 2) groups.push(buf.readUInt16BE(d + 2 + i));
      }
      if (type === 0x000b && len >= 1) {
        const fl = buf[d];
        for (let i = 0; i < fl && d + 1 + i < end; i += 1) pointFormats.push(buf[d + 1 + i]);
      }
      if (type === 0x0010 && len >= 2) {
        const l = buf.readUInt16BE(d);
        let q = d + 2;
        while (q < d + 2 + l && q + 1 < end) {
          const al = buf[q];
          alpn.push(buf.subarray(q + 1, q + 1 + al).toString('utf8'));
          q += 1 + al;
        }
      }
      p = d + len;
    }
    const ja3 = [legacyVersion, ciphers.join('-'), exts.join('-'), groups.join('-'), pointFormats.join('-')].join(',');
    return {
      legacyVersion,
      ciphers,
      exts,
      groups,
      pointFormats,
      alpn,
      sni,
      ja3,
      ja3Hash: crypto.createHash('md5').update(ja3).digest('hex'),
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * 透明 TCP 代理：同时支持
 *   - Node 直连 TLS（首字节 0x16）：固定转发到 HOST:443
 *   - 浏览器 HTTP CONNECT（`CONNECT host:port`）：按目标 host:port 转发；只记录发往 HOST 的 ClientHello
 */
/** 解析明文 ServerHello（TLS1.3 的 ServerHello 仍是明文），拿到协商 cipher */
function parseServerHello(buf) {
  try {
    if (buf[0] !== 0x16) return null;
    const recLen = buf.readUInt16BE(3);
    if (buf.length < 5 + recLen) return { incomplete: true, need: 5 + recLen };
    let p = 5;
    if (buf[p] !== 2) return null;
    p += 4;
    const version = buf.readUInt16BE(p);
    p += 2 + 32;
    const sidLen = buf[p];
    p += 1 + sidLen;
    const cipher = buf.readUInt16BE(p);
    return { version, cipher: cipher.toString(16).padStart(4, '0') };
  } catch (err) {
    return { error: err.message };
  }
}

function startCaptureProxy() {
  const captures = [];
  const serverHellos = [];
  const server = net.createServer((client) => {
    let pending = Buffer.alloc(0);
    let tunneled = false;
    let capBuf = Buffer.alloc(0);
    let captured = null;
    let srvBuf = Buffer.alloc(0);
    let srvCaptured = null;
    let host = HOST;
    let port = 443;
    let remote = null;

    const capture = (chunk) => {
      if (captured || host !== HOST) return;
      capBuf = Buffer.concat([capBuf, chunk]);
      const parsed = parseClientHello(capBuf);
      if (parsed && !parsed.incomplete && !parsed.error) {
        captured = { ...parsed, bytes: capBuf.length, at: Date.now() };
        captures.push(captured);
      }
    };

    const tunnel = (firstChunk) => {
      if (tunneled) return;
      tunneled = true;
      remote = net.connect(port, host);
      remote.on('error', () => client.destroy());
      client.on('error', () => remote.destroy());
      client.on('data', capture);
      remote.on('data', (chunk) => {
        if (srvCaptured || host !== HOST) return;
        srvBuf = Buffer.concat([srvBuf, chunk]);
        const parsed = parseServerHello(srvBuf);
        if (parsed && !parsed.incomplete && !parsed.error) {
          srvCaptured = { ...parsed, bytes: srvBuf.length, at: Date.now() };
          serverHellos.push(srvCaptured);
        }
      });
      client.pipe(remote);
      remote.pipe(client);
      if (firstChunk.length) {
        capture(firstChunk);
        remote.write(firstChunk);
      }
    };

    client.on('data', function onFirst(chunk) {
      if (tunneled) return;
      pending = Buffer.concat([pending, chunk]);
      const head = pending.subarray(0, 8).toString('utf8');
      if (head.startsWith('CONNECT ')) {
        const idx = pending.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const target = pending.subarray(8, pending.indexOf(' ', 8)).toString('utf8');
        const [h, p] = target.split(':');
        host = h;
        port = Number(p || 443);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.removeListener('data', onFirst);
        tunnel(pending.subarray(idx + 4));
        return;
      }
      if (pending[0] === 0x16) {
        client.removeListener('data', onFirst);
        tunnel(pending);
        return;
      }
      // 明文 HTTP / 其他探测：不隧道，直接断开
      client.destroy();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, captures, serverHellos }));
  });
}

async function nodeTls(proxyPort) {
  const result = {};
  await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port: proxyPort,
        servername: HOST,
        ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized: true,
        timeout: 15000,
      },
      () => {
        result.protocol = socket.getProtocol();
        result.alpn = socket.alpnProtocol;
        result.cipher = socket.getCipher();
        result.ephemeralKey = socket.getEphemeralKeyInfo();
        result.authorized = socket.authorized;
        result.ms = Date.now() - startedAt;
        socket.end();
      },
    );
    socket.on('error', reject);
    socket.on('timeout', () => reject(new Error('node tls timeout')));
    socket.on('close', resolve);
  });
  return result;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const proxy = await startCaptureProxy();
  const out = { node: {}, browser: {} };
  try {
    const TLS13_CIPHER = { '1301': 'TLS_AES_128_GCM_SHA256', '1302': 'TLS_AES_256_GCM_SHA384', '1303': 'TLS_CHACHA20_POLY1305_SHA256' };
    const cipherName = (id) => TLS13_CIPHER[id] || id;

    // ---- Node 侧 ----
    out.node.tls = await nodeTls(proxy.port);
    out.node.clientHello = (() => {
      const c = proxy.captures[0];
      if (!c) return null;
      return {
        bytes: c.bytes,
        legacyVersion: c.legacyVersion,
        cipherCount: c.ciphers.length,
        ciphers: c.ciphers.map((x) => x.toString(16).padStart(4, '0')),
        extCount: c.exts.length,
        exts: c.exts.map((x) => x.toString(16).padStart(4, '0')),
        groups: c.groups.map((x) => x.toString(16).padStart(4, '0')),
        pointFormats: c.pointFormats,
        alpn: c.alpn,
        sni: c.sni,
        ja3: c.ja3,
        ja3Hash: c.ja3Hash,
      };
    })();
    out.node.serverHello = proxy.serverHellos[0]
      ? { version: proxy.serverHellos[0].version, cipher: proxy.serverHellos[0].cipher, cipherName: cipherName(proxy.serverHellos[0].cipher) }
      : null;

    // ---- 浏览器侧：临时隔离 profile + 本地 CONNECT 代理 ----
    const before = proxy.captures.length;
    const beforeServer = proxy.serverHellos.length;
    const profileDir = path.resolve(OUT_DIR, 'verify-tls-profile');
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      channel: process.platform === 'win32' ? 'msedge' : undefined,
      // 用命令行而不是 Playwright 的 proxy 选项：proxy 选项会额外加 --proxy-bypass-list=<-loopback>，
      // 在本机代理场景下会让 Edge 启动后立刻退出。
      args: [`--proxy-server=http://127.0.0.1:${proxy.port}`],
      viewport: { width: 1280, height: 800 },
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    const security = [];
    cdp.on('Network.responseReceived', (ev) => {
      security.push({ requestId: ev.requestId, url: ev.response.url, protocol: ev.response.protocol, status: ev.response.status, details: null });
    });
    try {
      await page.goto(`https://${HOST}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      out.browser.navigation = await page.evaluate(() => ({ url: location.href, title: document.title }));
    } catch (err) {
      out.browser.navigation = { error: err.message };
    }
    const picked = security.filter((s) => s.url.startsWith(`https://${HOST}/`)).slice(0, 6);
    for (const s of picked) {
      try {
        s.details = await cdp.send('Network.getSecurityDetails', { requestId: s.requestId });
      } catch (err) {
        s.detailsError = err.message;
      }
      delete s.requestId;
    }
    out.browser.security = picked;
    const bc = proxy.captures[before];
    out.browser.clientHello = bc
      ? {
          bytes: bc.bytes,
          legacyVersion: bc.legacyVersion,
          cipherCount: bc.ciphers.length,
          ciphers: bc.ciphers.map((x) => x.toString(16).padStart(4, '0')),
          extCount: bc.exts.length,
          exts: bc.exts.map((x) => x.toString(16).padStart(4, '0')),
          groups: bc.groups.map((x) => x.toString(16).padStart(4, '0')),
          pointFormats: bc.pointFormats,
          alpn: bc.alpn,
          sni: bc.sni,
          ja3: bc.ja3,
          ja3Hash: bc.ja3Hash,
        }
      : null;
    const bsh = proxy.serverHellos[beforeServer];
    out.browser.serverHello = bsh ? { version: bsh.version, cipher: bsh.cipher, cipherName: cipherName(bsh.cipher) } : null;
    await ctx.close().catch(() => {});
  } finally {
    proxy.server.close();
  }

  // ---- C4：Node 直接 GET / 的响应头特征（不带 cookie） ----
  await new Promise((resolve) => {
    const req = https.request(
      { host: HOST, path: '/', method: 'GET', headers: { 'user-agent': UA, 'accept-language': 'zh-CN' }, timeout: 15000 },
      (res) => {
        out.node.httpGet = {
          status: res.statusCode,
          httpVersion: res.httpVersion,
          headers: Object.fromEntries(
            Object.entries(res.headers).map(([k, v]) => [k, k === 'set-cookie' ? `${Array.isArray(v) ? v.length : 1} cookie(s)` : v]),
          ),
          setCookieNames: Array.isArray(res.headers['set-cookie'])
            ? res.headers['set-cookie'].map((s) => s.split('=')[0])
            : res.headers['set-cookie']
              ? [res.headers['set-cookie'].split('=')[0]]
              : [],
        };
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', (err) => {
      out.node.httpGet = { error: err.message };
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      out.node.httpGet = { error: 'timeout' };
    });
    req.end();
  });

  out.compare = {
    tlsVersion: { node: out.node.tls?.protocol, browser: out.browser.serverHello?.version === 0x0303 ? 'TLSv1.3' : out.browser.serverHello?.version },
    cipher: {
      node: out.node.tls?.cipher && `${out.node.tls.cipher.name} (${out.node.tls.cipher.version})`,
      browser: out.browser.serverHello?.cipherName,
    },
    alpn: { node: out.node.tls?.alpn, browser: out.browser.clientHello?.alpn },
    ja3Hash: { node: out.node.clientHello?.ja3Hash, browser: out.browser.clientHello?.ja3Hash },
    cipherCount: { node: out.node.clientHello?.cipherCount, browser: out.browser.clientHello?.cipherCount },
    extCount: { node: out.node.clientHello?.extCount, browser: out.browser.clientHello?.extCount },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'verify-tls.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }));
  process.exit(1);
});
