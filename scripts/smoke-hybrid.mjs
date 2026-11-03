#!/usr/bin/env node
/**
 * hybrid 引擎单条冒烟：只发一条最短消息（"你好"），确认回复来自页面原生补全流。
 *
 *   $env:ENGINE='hybrid'
 *   node scripts/smoke-hybrid.mjs          # 用独立 profile（npm run auth:hybrid 登录一次）
 *   # 可选：显式复用已登录浏览器
 *   $env:HYBRID_CDP_URL='http://127.0.0.1:9222'; node scripts/smoke-hybrid.mjs
 *
 * 不会重试、不会连发；事件记录只有类型与数量，不记录输入/回复内容。
 */
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { createServer } from '../src/server.mjs';
import { createEngine } from '../src/engine.mjs';

const config = loadConfig();
const logger = createLogger(config.logLevel, 'smoke-hybrid');
const web = createEngine({ config, logger });
const server = createServer({ config, logger, web });

const fail = (message, extra) => {
  logger.error(message, extra || '');
  process.exitCode = 1;
};

try {
  await web.warmUp?.();
  if (web.status().engine !== 'hybrid') throw new Error(`当前引擎不是 hybrid：${web.status().engine}`);

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

  // 流式模式与耗时：确认走的是真增量（chunk 数、首字/末字相对点击的时间）
  const status = web.status();
  logger.info('流式与耗时', {
    streamMode: status.streamMode,
    lastStream: status.lastStream,
    timings: status.lastTimings,
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  // 证明请求由页面自身发起：initiator 来自页面脚本
  const initiator = web.lastInitiator || web.lastTrace?.initiator || null;
  logger.info('hybrid completion 请求 initiator（脱敏）', initiator
    ? {
        type: initiator.type,
        pageScript: initiator.pageScript,
        topUrl: initiator.topUrl,
        frames: initiator.frames.map((f) => `${f.url}:${f.lineNumber}`),
      }
    : '没有捕获到 initiator');

  // 证明真实键鼠事件：只有事件类型与数量
  const ui = web.lastUiTrace || null;
  logger.info('hybrid 真实交互事件（脱敏）', ui
    ? {
        typedChars: ui.typedChars,
        keyEventChars: ui.keyEventChars,
        insertTextFallbackChars: ui.insertTextFallbackChars,
        counts: ui.after,
        sequence: ui.sequence,
      }
    : '没有记录到交互事件');

  const trace = web.lastTrace || null;
  logger.info('hybrid 传输指纹（脱敏）', trace
    ? {
        status: trace.status,
        headerCount: trace.headerCount,
        chromeVersion: trace.chromeVersion,
        cookie: trace.presence.cookie,
        cookieNames: trace.cookieNames,
        secFetchSite: trace.presence['sec-fetch-site'],
        priority: trace.presence.priority,
        pow: trace.presence['x-ds-pow-response'],
        hifLeim: trace.presence['x-hif-leim'],
        hifDliq: trace.presence['x-hif-dliq'],
      }
    : '没有捕获到 completion 请求');

  const events = ui?.after || {};
  if (!events.keydown || !events.keyup || !events.input || !events.click) {
    logger.warn('事件序列不完整（keydown/keyup/input/click 缺项）', events);
  }
  if (!initiator?.pageScript) {
    logger.warn('initiator 不是页面脚本：退化为「头信息 + 页面上下文」证据', {
      pageUrl: web.health().pageUrl,
      hasCookie: Boolean(trace?.presence?.cookie),
      hasClientVersion: Boolean(trace?.presence?.['x-client-version']),
    });
  }

  if (!content.trim()) fail('冒烟失败：回复为空');
  if (!json.usage) logger.warn('响应里没有 usage（接口层面仍算通，usage 可能只对 direct 生效）');
} catch (err) {
  fail('冒烟异常', { message: err.message, code: err.code, evidence: web.lastEvidence || null });
} finally {
  server.close();
  await web.close().catch(() => {});
}
