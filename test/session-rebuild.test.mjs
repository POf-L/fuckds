import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DirectEngine } from '../src/direct/client.mjs';

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powBin = path.join(root, 'bin', 'ds-pow');
const TOKEN = 'test-token-0123456789abcdef';

function startFake(state) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/api/v0/chat_session/create') {
        state.creates += 1;
        json(200, { data: { biz_data: { chat_session: { id: `sess-${state.creates}` } } } });
        return;
      }
      if (req.url === '/api/v0/chat/create_pow_challenge') {
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
        const body = JSON.parse(chunks.join('') || '{}');
        state.completions.push({ parent: body.parent_message_id ?? null, session: body.chat_session_id ?? null });
        if (body.parent_message_id) {
          json(422, { code: 422, msg: '会话不存在或已过期' });
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ type: 'RESPONSE', content: '重建成功' }] } } })}\n\n`);
        res.write(`data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' })}\n\n`);
        res.end();
        return;
      }
      json(404, { msg: `未知路径 ${req.url}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('复用会话 422：重建恰好一次，用全量 prompt 建新会话并成功', async (t) => {
  const powReady = fs.existsSync(powBin) || (process.platform === 'win32' && fs.existsSync(`${powBin}.exe`));
  if (!powReady) return t.skip('缺少 bin/ds-pow，先 npm run pow:build');

  const state = { creates: 0, completions: [] };
  const server = await startFake(state);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-rebuild-'));
  const config = {
    dataDir,
    server: {},
    browser: {},
    deepseek: {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      tokens: [TOKEN],
      deviceProfile: 'chrome-win',
      humanTiming: false,
      coldStart: false,
      search: false,
    },
    direct: { powBin },
    runtime: { maxPromptChars: 100_000, accountCooldownMs: 60_000, rateLimitBackoffMs: 4_000, maxCooldownWaitMs: 5_000, requestTimeoutMs: 10_000 },
  };
  const engine = new DirectEngine({ config, logger });
  try {
    let rebuiltWith = null;
    const result = await engine.chat({
      prompt: '增量内容',
      meta: {},
      session: {
        chatSessionId: 'sess-before',
        parentMessageId: 'msg-before',
        accountFingerprint: engine.pool.accounts[0].fingerprint,
        rebuild: async () => {
          rebuiltWith = 'full prompt';
          return { prompt: '全量历史 prompt', refFileIds: [] };
        },
      },
    });
    assert.equal(result.text, '重建成功');
    assert.equal(rebuiltWith, 'full prompt');
    assert.equal(engine.sessionsRebuilt, 1, '重建次数必须恰好 1');
    assert.equal(engine.sessionsCreated, 1, '原会话来自调用方，重建只新建 1 次');
    assert.deepEqual(state.completions, [
      { parent: 'msg-before', session: 'sess-before' },
      { parent: null, session: 'sess-1' },
    ]);
    assert.equal(state.creates, 1);
  } finally {
    engine.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
