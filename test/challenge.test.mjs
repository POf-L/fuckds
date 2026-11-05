import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { anthropicErrorPayload } from '../src/anthropic/response.mjs';
import { CHALLENGE_GATE_MS, DirectEngine, isAccountScopedFailure, isChallengeRequired } from '../src/direct/client.mjs';
import { ChallengeRequiredError, UpstreamError } from '../src/errors.mjs';
import { createLogger } from '../src/logger.mjs';
import { createServer } from '../src/server.mjs';
import { makeConfig } from './helpers/browser.mjs';

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const serverLogger = createLogger('error');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powBin = path.join(root, 'bin', 'ds-pow');

// 真实登录 token 是 64 字符；用同形状的假值，保证凭据状态是 valid（可派发）
const TOKEN = `good-token-${'a'.repeat(53)}`;

/* ------------------------------------------------------------------ *
 * 1) 错误归类：40303 是「挑战/需人工」，不是可重试的上游错误
 * ------------------------------------------------------------------ */

test('isChallengeRequired：业务码 40303 / 文案 CHALLENGE_REQUIRED 都命中', () => {
  assert.equal(isChallengeRequired(40303, ''), true);
  assert.equal(isChallengeRequired('40303', ''), true);
  assert.equal(isChallengeRequired(undefined, 'CHALLENGE_REQUIRED'), true);
  assert.equal(isChallengeRequired(40303, 'anything'), true);
  // 其它业务码 / 文案不误判
  assert.equal(isChallengeRequired(40301, 'POW response invalid'), false);
  assert.equal(isChallengeRequired(401, '登录态已失效'), false);
  assert.equal(isChallengeRequired(undefined, 'user is muted'), false);
});

test('ChallengeRequiredError：429 + challenge_required + 不可重试 + nextAction', () => {
  const err = new ChallengeRequiredError();
  assert.equal(err.status, 429, '必须用 4xx 语义，不能是 503/502 这类可重试 5xx');
  assert.equal(err.code, 'challenge_required');
  assert.equal(err.type, 'upstream_error');
  assert.equal(err.retryable, false);
  assert.equal(err.retryAfterMs, 60_000);
  assert.equal(err.nextAction.action, 'complete-challenge');
  assert.equal(err.nextAction.command, 'npm run recover:challenge');

  const body = err.toJSON();
  assert.equal(body.error.code, 'challenge_required');
  assert.equal(body.error.retryable, false);
  assert.equal(body.error.nextAction.command, 'npm run recover:challenge');
  assert.match(body.error.message, /recover:challenge/);

  // 换号也没用：挑战不能触发账号轮换，更不能停用账号
  assert.equal(isAccountScopedFailure(err), false);
  assert.equal(isAccountScopedFailure(new UpstreamError('普通上游错误')), true);
});

test('闸门常量：同一会话 60s 内只允许 1 次上游尝试', () => {
  assert.equal(CHALLENGE_GATE_MS, 60_000);
});

test('Anthropic 错误体同样带 nextAction / retryable', () => {
  const payload = anthropicErrorPayload(new ChallengeRequiredError());
  assert.equal(payload.type, 'error');
  // 429 在 Anthropic 侧映射为 rate_limit_error；不可重试靠 retryable/nextAction + 网关硬闸
  assert.equal(payload.error.type, 'rate_limit_error');
  assert.equal(payload.error.retryable, false);
  assert.equal(payload.error.nextAction.command, 'npm run recover:challenge');
});

/* ------------------------------------------------------------------ *
 * 2) DirectEngine：40303 只打 1 次上游；同指纹 60s 内被硬闸拦截
 * ------------------------------------------------------------------ */

function startFakeChallenge(state) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/api/v0/chat_session/create') {
        state.sessions += 1;
        json(200, { data: { biz_data: { chat_session: { id: `sess-${state.sessions}` } } } });
        return;
      }

      if (req.url === '/api/v0/chat/create_pow_challenge') {
        // 已知可解的官方 WASM 测试向量：salt=testsalt / answer=42
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
        state.completions += 1;
        json(200, { code: 40303, msg: 'CHALLENGE_REQUIRED' });
        return;
      }

      json(404, { msg: `未知路径 ${req.url}` });
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function makeDirectConfig(baseUrl, dataDir) {
  return {
    dataDir,
    server: {},
    browser: {},
    deepseek: {
      baseUrl,
      tokens: [TOKEN],
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

test('40303：不重试、不停用账号；同指纹第二次在 60s 闸门内被拦截', async (t) => {
  const powReady = fs.existsSync(powBin) || (process.platform === 'win32' && fs.existsSync(`${powBin}.exe`));
  if (!powReady) return t.skip('缺少 bin/ds-pow，先 npm run pow:build');

  const state = { completions: 0, sessions: 0 };
  const server = await startFakeChallenge(state);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-challenge-'));
  const engine = new DirectEngine({ config: makeDirectConfig(`http://127.0.0.1:${server.address().port}`, dataDir), logger });

  try {
    // 第一次：上游 40303，客户端必须立刻拿到 ChallengeRequiredError，且只打 1 次 completion
    await assert.rejects(() => engine.chat({ prompt: '触发挑战', meta: {} }), ChallengeRequiredError);
    assert.equal(state.completions, 1, '40303 不允许走通用 3 次重试');

    // 账号没有被停用（挑战是会话/风控级，不是凭据失效）
    const [account] = engine.pool.status();
    assert.equal(account.available, true);
    assert.equal(account.authFailed, false);

    // 第二次：同一 prompt（无会话 id，用 prompt 哈希）——闸门直接拒绝，上游计数不增长
    await assert.rejects(
      () => engine.chat({ prompt: '触发挑战', meta: {} }),
      (err) => err instanceof ChallengeRequiredError && err.retryAfterMs > 0,
    );
    assert.equal(state.completions, 1, '闸门生效：60s 内不再触达上游');
    assert.equal(state.sessions, 1, '也不该再创建会话');
  } finally {
    engine.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3) HTTP 层：429 + Retry-After + x-should-retry:false + 明确错误体
 * ------------------------------------------------------------------ */

function fakeChallengeWeb() {
  return {
    calls: 0,
    status: () => ({ browser: true, token: true }),
    async uploadAttachments(files = []) {
      return files.map((_, i) => `file_${i}`);
    },
    async chat() {
      this.calls += 1;
      throw new ChallengeRequiredError();
    },
  };
}

async function withServer(web, fn) {
  const config = makeConfig({ API_KEY: '' });
  const server = createServer({ config, logger: serverLogger, web });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

const chatBody = (extra = {}) => ({
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: '你好' }],
  ...extra,
});

for (const stream of [false, true]) {
  test(`HTTP ${stream ? '流式' : '非流式'}：40303 返回 429 + 明确错误体（不可重试）`, async () => {
    const web = fakeChallengeWeb();
    await withServer(web, async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody(stream ? { stream: true } : {})),
      });

      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '60');
      assert.equal(res.headers.get('x-should-retry'), 'false');
      assert.equal(web.calls, 1, '网关只能打一次上游，不能内部重试');

      const json = await res.json();
      assert.equal(json.error.type, 'upstream_error');
      assert.equal(json.error.code, 'challenge_required');
      assert.equal(json.error.retryable, false);
      assert.equal(json.error.nextAction.action, 'complete-challenge');
      assert.equal(json.error.nextAction.command, 'npm run recover:challenge');
      assert.match(json.error.message, /人机挑战/);
      assert.match(json.error.message, /recover:challenge/);
    });
  });
}
