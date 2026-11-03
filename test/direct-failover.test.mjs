import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTH_INVALID_COOLDOWN_MS, DirectEngine, isAccountScopedFailure } from '../src/direct/client.mjs';
import {
  AuthExpiredError,
  CaptchaError,
  PromptTooLongError,
  RateLimitError,
  TimeoutError,
  UpstreamError,
} from '../src/errors.mjs';

const logger = { info() {}, warn() {}, debug() {}, error() {} };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powBin = path.join(root, 'bin', 'ds-pow');

const BAD_TOKEN = 'bad-token-0123456789abcdef';
const GOOD_TOKEN = 'good-token-0123456789abcdef';

test('账号级失败：限流 / 登录态失效 / 上游报错可以在同一请求里换号重试', () => {
  assert.equal(isAccountScopedFailure(new RateLimitError()), true);
  assert.equal(isAccountScopedFailure(new AuthExpiredError()), true);
  assert.equal(isAccountScopedFailure(new UpstreamError('网页接口返回错误')), true);
  assert.equal(isAccountScopedFailure(new CaptchaError()), true);
});

test('非账号级失败：超时 / 参数错误 / 客户端断开不换号', () => {
  assert.equal(isAccountScopedFailure(new TimeoutError()), false);
  assert.equal(isAccountScopedFailure(new PromptTooLongError()), false);
  assert.equal(
    isAccountScopedFailure(new UpstreamError('客户端已断开', { status: 499, code: 'client_closed' })),
    false,
  );
  assert.equal(isAccountScopedFailure(new Error('未知错误')), false);
});

test('登录态失效的停用时长足够覆盖整个进程生命周期', () => {
  assert.ok(AUTH_INVALID_COOLDOWN_MS >= 60 * 60_000, '至少停用 1 小时');
});

function startFakeDeepSeek(state) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/api/v0/chat_session/create') {
        if (token === BAD_TOKEN) {
          json(401, { code: 401, msg: '登录态已失效' });
          return;
        }
        json(200, { data: { biz_data: { chat_session: { id: `sess-${state.sessionSeq++}` } } } });
        return;
      }

      if (req.url === '/api/v0/chat/create_pow_challenge') {
        // 已知可解的官方 WASM 测试向量：salt=testsalt / expire_at=1700000000 / answer=42
        json(200, {
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09',
                salt: 'testsalt',
                expire_at: 1700000000,
                difficulty: 1000,
                signature: 'sig',
                target_path: '/api/v0/chat/completion',
              },
            },
          },
        });
        return;
      }

      if (req.url === '/api/v0/chat/completion') {
        state.completionTokens.push(token);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ type: 'RESPONSE', content: '来自' }] } } })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ v: '好号' })}\n\n`);
        res.write(`data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' })}\n\n`);
        res.end();
        return;
      }

      json(404, { msg: `未知路径 ${req.url}` });
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function makeConfig(baseUrl, dataDir) {
  return {
    dataDir,
    server: {},
    browser: {},
    deepseek: {
      baseUrl,
      tokens: [BAD_TOKEN, GOOD_TOKEN],
      deviceProfile: 'chrome-win',
      humanTiming: false,
      coldStart: false,
      search: false,
    },
    direct: { powBin },
    runtime: {
      maxPromptChars: 100_000,
      accountCooldownMs: 60_000,
      rateLimitBackoffMs: 4_000,
      maxCooldownWaitMs: 5_000,
      requestTimeoutMs: 10_000,
    },
  };
}

test('坏号 401：同一个请求内自动换到好号，并把坏号停用（不用客户端重发）', async (t) => {
  const powReady = fs.existsSync(powBin) || (process.platform === 'win32' && fs.existsSync(`${powBin}.exe`));
  if (!powReady) return t.skip('缺少 bin/ds-pow，先 npm run pow:build');

  const state = { completionTokens: [], sessionSeq: 0 };
  const server = await startFakeDeepSeek(state);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-failover-'));
  const config = makeConfig(`http://127.0.0.1:${server.address().port}`, dataDir);
  const engine = new DirectEngine({ config, logger });

  try {
    // 第一次请求：坏号在前，必须自动换到好号并成功，而不是把 401 抛给客户端
    const first = await engine.chat({ prompt: '你好', meta: {} });
    assert.equal(first.text, '来自好号');
    assert.deepEqual(state.completionTokens, [GOOD_TOKEN], '第一次请求就应该直接用上第二个号');

    const [bad, good] = engine.pool.status();
    assert.equal(bad.authFailed, true);
    assert.equal(bad.available, false);
    assert.match(bad.lastError, /登录态失效/);
    assert.equal(good.authFailed, false);

    // 第二次请求：坏号已经被停用，直接轮到好号（不会再先撞一次坏号）
    const second = await engine.chat({ prompt: '再来一次', meta: {} });
    assert.equal(second.text, '来自好号');
    assert.deepEqual(state.completionTokens, [GOOD_TOKEN, GOOD_TOKEN]);
  } finally {
    engine.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
