/**
 * hybrid 增量流集成测试：本地假的 /api/v0/chat/completion SSE，验证
 *   1) CDP Fetch + IO.read 能在 chunk 到达时就推给客户端（首字远早于末字）；
 *   2) 旧「收完再回放」在同一段流上首字时间≈末字时间（对照）。
 * 不访问上游、不使用任何账号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { chromium } from 'playwright';

import { applyPatch, createSseParser, createStreamState } from '../src/direct/stream.mjs';
import { createHybridStreamCapture } from '../src/hybrid/stream-capture.mjs';

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

function startServer({ chunkDelayMs = 150, chunks = ['你', '好', '！'] } = {}) {
  const state = { requests: 0, endedAt: 0, sentAt: [] };
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.includes('/api/v0/chat/completion')) {
      state.requests += 1;
      const t0 = Date.now();
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();
      res.write(frame({ v: { response: { message_id: 'm-1', fragments: [] } } }));
      state.sentAt.push({ kind: 'header', at: Date.now() - t0 });
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write(
            frame({
              p: 'response/fragments',
              o: 'APPEND',
              v: [{ type: 'RESPONSE', content: chunks[i] }],
            }),
          );
          state.sentAt.push({ kind: `chunk${i}`, at: Date.now() - t0 });
          i += 1;
          return;
        }
        clearInterval(timer);
        res.write(frame({ p: 'response/status', o: 'SET', v: 'FINISHED' }));
        state.sentAt.push({ kind: 'end', at: Date.now() - t0 });
        res.end();
        state.endedAt = Date.now();
      }, chunkDelayMs);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>fixture</h1></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port, startedAt }));
  });
}

const trigger = (page) =>
  page.evaluate(() =>
    fetch('/api/v0/chat/completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then((r) => r.text())
      .then(() => true)
      .catch(() => false),
  );

test('hybrid 流式：增量推送首字早于末字，批量回放首字≈末字', async () => {
  const { server, state, port } = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');

    /* ------------------------- 增量模式 ------------------------- */
    const incremental = [];
    const captureA = createHybridStreamCapture({
      page,
      cdp,
      mode: 'incremental',
      onDelta: (delta) => incremental.push({ delta, at: Date.now() }),
    });
    const clickedAt = Date.now();
    await captureA.ready;
    void trigger(page).catch(() => {});
    const resA = await captureA.collect({ timeoutMs: 8_000, clickedAt });
    await captureA.dispose();

    assert.ok(resA.stats.mode === 'incremental', `mode=${resA.stats.mode} reason=${resA.stats.fallbackReason}`);
    assert.equal(incremental.map((d) => d.delta).join(''), '你好！');
    assert.ok(resA.stats.chunks >= 3, `chunks=${resA.stats.chunks}`);
    const firstTokenMs = incremental[0].at - clickedAt;
    const lastTokenMs = incremental.at(-1).at - clickedAt;
    assert.ok(firstTokenMs < 800, `incremental first token too late: ${firstTokenMs}ms`);
    assert.ok(lastTokenMs - firstTokenMs > 200, `incremental looks batched: first=${firstTokenMs} last=${lastTokenMs}`);

    /* ------------------------- 批量模式（旧行为） ------------------------- */
    const batch = [];
    const captureB = createHybridStreamCapture({ page, cdp, mode: 'batch' });
    const clickedAtB = Date.now();
    void trigger(page);
    const resB = await captureB.collect({ timeoutMs: 8_000, clickedAt: clickedAtB });
    await captureB.dispose();
    assert.ok(resB.bodies.length >= 1);
    // 旧行为：body 收完后一次性解析回放
    const stateB = createStreamState();
    const parserB = createSseParser((payload, event) => {
      if (event === 'hint') return;
      applyPatch(stateB, payload);
    });
    parserB.push(resB.bodies.sort((a, b) => a.length - b.length).at(-1));
    parserB.flush();
    batch.push(Date.now());

    const batchFirstTokenMs = batch[0] - clickedAtB;
    console.log(
      `[measure] incremental TTFB=${firstTokenMs}ms lastToken=${lastTokenMs}ms chunks=${resA.stats.chunks}; batch TTFB=${batchFirstTokenMs}ms`,
    );
    assert.ok(
      batchFirstTokenMs > firstTokenMs,
      `batch first token (${batchFirstTokenMs}ms) should be slower than incremental (${firstTokenMs}ms)`,
    );

    /* ---------------------- 增量拆块数统计 ---------------------- */
    assert.ok(state.requests >= 2);
    assert.equal(stateB.status, 'FINISHED');
    await page.close();
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
