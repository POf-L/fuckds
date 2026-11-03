#!/usr/bin/env node
/**
 * light 引擎单条冒烟：只发一条最短消息，确认回复与 usage。
 *
 *   $env:ENGINE='light'
 *   $env:LIGHT_CDP_URL='http://127.0.0.1:9222'
 *   node scripts/smoke-light.mjs
 *
 * 不会重试、不会连发、不会驱动页面 UI。
 */
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { createServer } from '../src/server.mjs';
import { createEngine } from '../src/engine.mjs';

const config = loadConfig();
const logger = createLogger(config.logLevel, 'smoke-light');
const web = createEngine({ config, logger });
const server = createServer({ config, logger, web });

const fail = (message, extra) => {
  logger.error(message, extra || '');
  process.exitCode = 1;
};

try {
  await web.warmUp?.();
  if (web.status().engine !== 'light') throw new Error(`当前引擎不是 light：${web.status().engine}`);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  logger.info('临时服务已启动', { url });

  const started = Date.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '你好' }],
    }),
  });
  const json = await res.json();
  const choice = json.choices?.[0];
  const content = choice?.message?.content ?? '';

  logger.info('冒烟结果', {
    httpStatus: res.status,
    elapsedMs: Date.now() - started,
    finishReason: choice?.finish_reason,
    contentChars: content.length,
    usage: json.usage || null,
    reasoningChars: (choice?.message?.reasoning_content || '').length,
  });
  logger.info('回复正文（截断展示）', JSON.stringify(content.slice(0, 200)));

  // 证明请求来自浏览器网络栈：只看头名/是否存在，不打印任何值
  await new Promise((resolve) => setTimeout(resolve, 300));
  const trace = web.lastTrace || null;
  logger.info('light 传输指纹（脱敏）', trace
    ? {
        status: trace.status,
        headerCount: trace.headerCount,
        chromeVersion: trace.chromeVersion,
        cookie: trace.presence.cookie,
        cookieNames: trace.cookieNames,
        secFetchSite: trace.presence['sec-fetch-site'],
        secFetchMode: trace.presence['sec-fetch-mode'],
        acceptEncoding: trace.presence['accept-encoding'],
        priority: trace.presence.priority,
        authorization: trace.presence.authorization,
        pow: trace.presence['x-ds-pow-response'],
        hifLeim: trace.presence['x-hif-leim'],
        hifDliq: trace.presence['x-hif-dliq'],
      }
    : '没有捕获到 completion 请求');
  if (trace?.rawOrder) logger.info('light 原始头顺序（CDP，只有头名）', trace.rawOrder);
  if (trace && !trace.presence['x-hif-leim'] && !trace.presence['x-hif-dliq']) {
    logger.warn('请求里没有 x-hif-*（页面上暂无可复用的 hif 缓存，或该请求不需要）');
  }

  if (!content.trim()) fail('冒烟失败：回复为空');
  if (!json.usage) logger.warn('响应里没有 usage（接口层面仍算通，usage 可能只对 direct 生效）');
} catch (err) {
  fail('冒烟异常', { message: err.message, code: err.code, evidence: web.lastEvidence || null });
} finally {
  server.close();
  await web.close().catch(() => {});
}
