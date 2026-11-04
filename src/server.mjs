import http from 'node:http';

import { ApiError } from './errors.mjs';
import { createAdminHandler } from './admin/routes.mjs';
import { createChatRunner } from './chat-runner.mjs';
import { WebSessionStore } from './session/store.mjs';
import { createAnthropicHandler } from './anthropic/handler.mjs';
import { anthropicErrorPayload } from './anthropic/response.mjs';
import { normalizeChatRequest, normalizeCompletionRequest } from './openai/request.mjs';
import {
  buildChatChunk,
  buildChatCompletion,
  estimateUsage,
  modelsResponse,
  newCompletionId,
} from './openai/response.mjs';
import { SseWriter } from './openai/sse.mjs';
import { reconcileStreamedText } from './openai/tool-text.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function createServer({ config, logger, web }) {
  const log = logger.child('http');

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('未捕获的请求错误:', err);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message, type: 'server_error' } });
      else res.end();
    });
  });

  /** 网页会话映射（落盘 data/web-sessions.json）：同一段对话复用同一个 chat_session */
  const sessions = new WebSessionStore({
    dataDir: config.dataDir,
    logger: log,
    ttlMs: config.runtime.sessionTtlMs,
    maxEntries: config.runtime.maxWebSessions,
  });
  /** 两个协议共用同一套执行逻辑（防自造结果 / 超长转附件 / 会话复用） */
  const runChat = createChatRunner({ config, log, web, sessions });
  const anthropic = createAnthropicHandler({ config, log, runChat, sendJson });
  /** 网页控制台：/admin 静态页 + /admin/api/* 管理接口 */
  const admin = createAdminHandler({ config, logger, web });

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    /** 出错时按请求的协议回不同格式的错误体 */
    let protocol = url.pathname.startsWith('/v1/messages') ? 'anthropic' : 'openai';

    res.setHeader('Access-Control-Allow-Origin', config.server.cors);
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Requested-With, x-api-key, anthropic-version, anthropic-beta',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    res.on('finish', () => {
      log.info(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });

    try {
      if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
        return sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
          ...web.status(),
          // 会话复用状态：sessionReused / webSessionHash（哈希前缀）/ 建会话/复用/重建计数
          sessions: sessions.status(),
          version: 1,
        });
      }

      if (req.method === 'GET' && url.pathname === '/') {
        return sendHtml(res, 200, landingPage(config));
      }

      // ---- 网页控制台（/admin 静态页，/admin/api/* 管理接口）----
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        // 必须 await：鉴权失败 / 接口异常要以 401 / 4xx 返回，不能被当成未捕获错误变成 500
        return await admin(req, res, url);
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        requireAuth(req, config);
        return sendJson(res, 200, modelsResponse());
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
        requireAuth(req, config);
        const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
        const model = modelsResponse().data.find((m) => m.id === id);
        if (!model) throw new ApiError(404, `模型不存在: ${id}`, { code: 'model_not_found' });
        return sendJson(res, 200, model);
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        requireAuth(req, config);
        const body = await readJson(req);
        const request = normalizeChatRequest(body, config);
        request.conversationId ||= headerConversationId(req);
        return await handleChat(req, res, request);
      }

      if (req.method === 'POST' && url.pathname === '/v1/completions') {
        requireAuth(req, config);
        const body = await readJson(req);
        const request = normalizeCompletionRequest(body, config);
        request.conversationId ||= headerConversationId(req);
        return await handleLegacyCompletion(req, res, request);
      }

      // ---- Anthropic Messages API ----
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        requireAuth(req, config);
        return await anthropic.handleMessages(req, res, await readJson(req));
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        requireAuth(req, config);
        return await anthropic.handleCountTokens(req, res, await readJson(req));
      }

      throw new ApiError(404, `未知路径: ${req.method} ${url.pathname}`, { code: 'not_found' });
    } catch (err) {
      if (res.headersSent) {
        log.error('响应已开始后出错:', err.message);
        res.end();
        return;
      }
      const apiError = err instanceof ApiError ? err : new ApiError(500, err.message);
      if (!(err instanceof ApiError)) log.error('请求处理失败:', err);
      if (apiError.status >= 500 || apiError.status === 429) log.warn('上游失败:', err.message);
      if (apiError.code === 'deepseek_auth_required') {
        log.warn('登录态失效：请运行 `npm run auth:hybrid` 重新登录（使用手册 §6；无需手动复制 token）');
      }
      if (apiError.status === 429) {
        const seconds = Math.ceil((err.retryAfterMs ?? 60_000) / 1000);
        res.setHeader('Retry-After', String(seconds));
      }
      const payload = protocol === 'anthropic' ? anthropicErrorPayload(apiError) : apiError.toJSON();
      sendJson(res, apiError.status, payload);
    }
  }

  /* ------------------------------------------------------------------ *
   * /v1/chat/completions
   * ------------------------------------------------------------------ */

  async function handleChat(req, res, request) {
    const id = newCompletionId();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort(new Error('client disconnected'));
    });

    const onPrompt = (prompt, info) =>
      log.info('转发到网页版', {
        id,
        model: request.model,
        thinking: request.thinking,
        stream: request.stream,
        promptChars: prompt.length,
        originalChars: info.stats?.chars,
        attachmentChars: info.attachment?.chars ?? 0,
        sections: info.stats?.sections,
        tools: info.stats?.tools,
        // 清洗审计：只记数量与标签名，绝不记正文
        toolsDropped: info.sanitize?.stripped?.tools ?? 0,
        toolChoiceDropped: info.sanitize?.stripped?.toolChoice ?? false,
        markupHits: info.sanitize?.markup?.count ?? 0,
        markupTags: info.sanitize?.markup?.byName ?? {},
      });

    if (!request.stream) {
      const result = await runChat(request, { signal: abort.signal, meta: { id }, onPrompt });
      const payload = buildChatCompletion({
        id,
        model: request.model,
        content: result.content,
        reasoning: result.reasoning || undefined,
        toolCalls: result.toolCalls,
        finishReason: result.toolCalls.length ? 'tool_calls' : 'stop',
        usage: estimateUsage(result.prompt, result.text, result.reasoning),
      });
      log.info('完成', {
        id,
        chars: result.content.length,
        ms: result.elapsedMs,
        toolCalls: result.toolCalls.length,
        fabricated: result.fabricated,
        protocol: result.protocol,
        session: result.session,
      });
      return sendJson(res, 200, payload);
    }

    const sse = new SseWriter(res);
    let firstChunk = true;
    // 已经发给客户端的增量：收尾时和权威结果核对，缺尾巴就补发（SSE 不能撤回，只能追加）
    let sentContent = '';
    let sentReasoning = '';

    const ensureRole = () => {
      if (!firstChunk) return;
      firstChunk = false;
      sse.send(buildChatChunk({ id, model: request.model, delta: { role: 'assistant', content: '' } }));
    };

    try {
      const result = await runChat(request, {
        signal: abort.signal,
        meta: { id },
        onPrompt,
        onContent: (text) => {
          if (!text) return;
          sentContent += text;
          ensureRole();
          sse.send(buildChatChunk({ id, model: request.model, delta: { content: text } }));
        },
        onReasoning: (text) => {
          if (!text) return;
          sentReasoning += text;
          ensureRole();
          sse.send(buildChatChunk({ id, model: request.model, delta: { reasoning_content: text } }));
        },
      });

      ensureRole();

      // 兜底校验：chat-runner 已经做过一次收尾补发，这里再对一次账，防止将来改动漏掉尾巴。
      // 只追加、不重发，保证客户端拼接结果 == result.content。
      const contentGap = reconcileStreamedText(sentContent, result.content);
      if (contentGap.delta && contentGap.delta.trim()) {
        log.warn('流式 content 比最终结果短，兜底补发尾部', {
          id,
          sentChars: sentContent.length,
          finalChars: result.content.length,
          tailChars: contentGap.delta.length,
        });
        sse.send(buildChatChunk({ id, model: request.model, delta: { content: contentGap.delta } }));
        sentContent += contentGap.delta;
      }
      const reasoningGap = reconcileStreamedText(sentReasoning, result.reasoning || '');
      if (reasoningGap.delta && reasoningGap.delta.trim()) {
        sse.send(
          buildChatChunk({ id, model: request.model, delta: { reasoning_content: reasoningGap.delta } }),
        );
        sentReasoning += reasoningGap.delta;
      }
      const streamConsistent = contentGap.complete && reasoningGap.complete;

      const { toolCalls } = result;
      if (result.fabricated) {
        log.warn('模型输出了自造的工具结果（RESULT），已从流式 content 中剔除', {
          id,
          toolCalls: toolCalls.length,
        });
      }
      if (!streamConsistent) {
        log.warn('流式增量与最终结果无法完全对齐', {
          id,
          sentChars: sentContent.length,
          finalChars: result.content.length,
        });
      }

      if (toolCalls.length) {
        sse.send(
          buildChatChunk({
            id,
            model: request.model,
            delta: {
              tool_calls: toolCalls.map((call, index) => ({
                index,
                id: `call_${id.slice(-12)}_${index}`,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            },
          }),
        );
      }

      sse.send(
        buildChatChunk({
          id,
          model: request.model,
          delta: {},
          finishReason: toolCalls.length ? 'tool_calls' : 'stop',
        }),
      );

      if (request.streamIncludeUsage) {
        sse.send({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [],
          usage: estimateUsage(result.prompt, result.text, result.reasoning),
        });
      }

      log.info('流式完成', {
        id,
        chars: result.text.length,
        sentChars: sentContent.length,
        finalChars: result.content.length,
        streamConsistent,
        ms: result.elapsedMs,
        toolCalls: toolCalls.length,
        fabricated: result.fabricated,
        protocol: result.protocol,
        session: result.session,
      });
      sse.done();
    } catch (err) {
      if (res.writableEnded || sse.closed) return;
      const apiError = err instanceof ApiError ? err : new ApiError(500, err.message);
      // 还没发出任何 SSE 字节时，按真实 HTTP 状态返回 JSON。
      // 否则 200 + 只有 error 帧的空流会被客户端当成「模型空回答」立刻重试，
      // 限流期间会变成高频空转（实测 opencode 会在 60 秒冷却里连打十几次）。
      if (!res.headersSent) {
        if (apiError.status === 429) {
          const seconds = Math.ceil((err.retryAfterMs ?? 60_000) / 1000);
          res.setHeader('Retry-After', String(seconds));
        }
        if (!(err instanceof ApiError) || apiError.status >= 500) log.warn('流式失败:', err.message);
        return sendJson(res, apiError.status, apiError.toJSON());
      }
      sse.send(apiError.toJSON());
      sse.done();
      if (!(err instanceof ApiError) || apiError.status >= 500) log.warn('流式失败:', err.message);
    }
  }

  async function handleLegacyCompletion(req, res, request) {
    const id = `cmpl-${newCompletionId().slice(-16)}`;

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const result = await runChat(request, { signal: abort.signal, meta: { id } });

    if (!request.stream) {
      return sendJson(res, 200, {
        id,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, text: result.content, finish_reason: 'stop' }],
        usage: estimateUsage(result.prompt, result.text, result.reasoning),
      });
    }
    const sse = new SseWriter(res);
    sse.send({
      id,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{ index: 0, text: result.content, finish_reason: 'stop' }],
    });
    sse.done();
  }

  return server;
}

/* -------------------------------------------------------------------- *
 * 工具函数
 * -------------------------------------------------------------------- */

function requireAuth(req, config) {
  if (!config.server.apiKey) return;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // Anthropic 官方 SDK 用 x-api-key
  const apiKeyHeader = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  if (bearer !== config.server.apiKey && apiKeyHeader !== config.server.apiKey) {
    throw new ApiError(401, 'API Key 无效', { type: 'authentication_error', code: 'invalid_api_key' });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, '请求体过大', { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, '请求体不是合法 JSON', { code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

/** 请求头里的对话标识（可选；没有就用消息前缀哈希） */
function headerConversationId(req) {
  const value = req.headers['x-conversation-id'] || req.headers['x-session-id'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function landingPage(config) {
  const example = `curl http://${config.server.host}:${config.server.port}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${config.server.apiKey || 'any'}" \\
  -d '{
    "model": "deepseek-flash",
    "stream": true,
    "messages": [
      {"role": "system", "content": "你是一个简洁的助手"},
      {"role": "user", "content": "用一句话解释什么是 QUIC"}
    ]
  }'`;
  const anthropicExample = `curl http://${config.server.host}:${config.server.port}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${config.server.apiKey || 'any'}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "deepseek-flash",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "用一句话解释什么是 QUIC"}]
  }'`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>DeepSeek Web → OpenAI / Anthropic API</title>
<style>
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:820px;margin:48px auto;padding:0 20px;color:#1f2328;background:#fff}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;border-radius:6px}
pre{padding:14px;overflow:auto;border:1px solid #e5e7eb;font-size:13px}
h1{font-size:24px}table{border-collapse:collapse;width:100%;margin:12px 0}
td,th{border:1px solid #e5e7eb;padding:6px 10px;text-align:left;font-size:14px}
th{background:#f6f8fa}
</style>
<h1>DeepSeek 网页版 → OpenAI / Anthropic 兼容 API</h1>
<p>服务地址：<code>http://${escapeHtml(config.server.host)}:${config.server.port}/v1</code>
&nbsp;·&nbsp;<a href="/admin/">打开网页控制台 →</a></p>
<table>
<tr><th>接口</th><th>说明</th></tr>
<tr><td><code>POST /v1/chat/completions</code></td><td>OpenAI 聊天补全（支持 stream / tools）</td></tr>
<tr><td><code>POST /v1/completions</code></td><td>OpenAI 旧版补全</td></tr>
<tr><td><code>POST /v1/messages</code></td><td>Anthropic Messages（支持 stream / tools / thinking）</td></tr>
<tr><td><code>POST /v1/messages/count_tokens</code></td><td>Anthropic token 估算</td></tr>
<tr><td><code>GET /v1/models</code></td><td>模型列表</td></tr>
<tr><td><code>GET /healthz</code></td><td>健康检查 / 浏览器状态</td></tr>
</table>
<p>同一段对话复用同一个 DeepSeek 网页会话（全程只 <code>/chat_session/create</code> 一次），后续轮次用 <code>parent_message_id</code> 追加、只提交本轮新增内容；首轮上下文按 <code>## User</code> / <code>## Assistant</code> / <code>## Tool_calls</code> / <code>## Tool_call_result</code> 分段。工具调用走纯文本协议，服务端解析成标准 <code>tool_calls</code>。</p>
<pre>${escapeHtml(example)}</pre>
<pre>${escapeHtml(anthropicExample)}</pre>
<p style="color:#6b7280">登录态：${config.deepseek.token ? '已配置 ✅' : '未配置 ❌ 执行 npm run auth -- &lt;userToken&gt;'}</p>
</html>`;
}
