/**
 * hybrid 引擎的补全流捕获：CDP Network 流式增量（页面完全不受影响）。
 *
 * 页面自己发出 /api/v0/chat/completion（SSE）时：
 *   1. Network.requestWillBeSent 命中后立刻 Network.streamResourceContent(requestId)；
 *   2. 返回的 bufferedData + 后续 Network.dataReceived(data) 就是真·增量 chunk；
 *   3. 每块都喂 createSseParser + applyPatch，并立刻用 onDelta / onThinking 推给客户端。
 *
 * 和 Fetch 拦截相比：不暂停请求、不 continueRequest，页面自己的 fetch/渲染照常进行，
 * 因此页面可观测行为与官网一致；首字时间=第一个 network chunk 到达时间。
 *
 * 同时保留 page.on('response') 的整段 body 作为兜底：
 *   - streamResourceContent 不可用/没拿到 data → 退回旧的「收完再回放」；
 *   - 最终权威文本仍用 parseCompletionBodies 做多段择优，避免页面重试造成重复。
 *
 * 本模块不抛业务错误（限流/验证码语义在 client 统一处理），
 * 只把状态、头名、hints 与耗时统计交给调用方。
 */

import {
  applyPatch,
  contentOf,
  createSseParser,
  createStreamState,
  reasoningOf,
} from '../direct/stream.mjs';

export const COMPLETION_PATH = '/api/v0/chat/completion';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function headerValue(headers, name) {
  if (Array.isArray(headers)) {
    const hit = headers.find((entry) => String(entry?.name || '').toLowerCase() === name);
    return String(hit?.value || '');
  }
  if (headers && typeof headers === 'object') {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? String(headers[key]) : '';
  }
  return '';
}

function headerNames(headers) {
  if (Array.isArray(headers)) return headers.map((entry) => entry?.name).filter(Boolean);
  if (headers && typeof headers === 'object') return Object.keys(headers);
  return [];
}

function hdrsToObject(headers) {
  const out = {};
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (entry?.name) out[String(entry.name).toLowerCase()] = String(entry.value ?? '');
    }
  } else if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v ?? '');
  }
  return out;
}

/** Network.dataReceived / bufferedData 都是 base64 编码的 chunk */
function decodeChunk(data) {
  if (typeof data !== 'string' || !data) return '';
  try {
    return Buffer.from(data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * @param {object} options
 * @param {import('playwright').Page} options.page
 * @param {import('playwright').CDPSession} options.cdp
 * @param {'incremental'|'batch'} [options.mode]
 * @param {string} [options.requestPath]
 * @param {object} [options.logger]
 * @param {(text: string) => void} [options.onDelta]
 * @param {(text: string) => void} [options.onThinking]
 */
export function createHybridStreamCapture({
  page,
  cdp,
  mode = 'incremental',
  requestPath = COMPLETION_PATH,
  logger,
  onDelta,
  onThinking,
} = {}) {
  const log = logger || { debug() {}, warn() {}, info() {} };
  /** @type {any[]} */
  const entries = [];
  const byRequestId = new Map();
  const stats = {
    mode: mode === 'batch' ? 'batch' : 'incremental',
    streamingEnabled: false,
    chunks: 0,
    bytes: 0,
    firstByteAt: 0,
    firstTokenAt: 0,
    lastTokenAt: 0,
    fallbackReason: null,
    cdpBodies: 0,
    dataEvents: 0,
  };
  const capture = {
    entries,
    stats,
    emittedContent: '',
    emittedReasoning: '',
    hints: [],
    hintErrors: [],
    trace: null,
  };

  let disposed = false;
  let emitter = null;
  let responseHandler = null;
  const networkHandlers = [];
  const streamPromises = [];

  const matches = (url) => typeof url === 'string' && url.includes(requestPath);

  const createEmitter = () => {
    const state = createStreamState();
    const out = { state, content: '', reasoning: '' };
    const emit = () => {
      const content = contentOf(state);
      if (content.length > out.content.length && content.startsWith(out.content)) {
        const delta = content.slice(out.content.length);
        out.content = content;
        capture.emittedContent = content;
        if (delta) {
          const now = Date.now();
          if (!stats.firstTokenAt) stats.firstTokenAt = now;
          stats.lastTokenAt = now;
          onDelta?.(delta);
        }
      }
      const reasoning = reasoningOf(state);
      if (reasoning.length > out.reasoning.length && reasoning.startsWith(out.reasoning)) {
        const delta = reasoning.slice(out.reasoning.length);
        out.reasoning = reasoning;
        capture.emittedReasoning = reasoning;
        if (delta) {
          const now = Date.now();
          if (!stats.firstTokenAt) stats.firstTokenAt = now;
          stats.lastTokenAt = now;
          onThinking?.(delta);
        }
      }
    };
    const parser = createSseParser((payload, event) => {
      if (event === 'hint' && payload && payload.type === 'error') {
        capture.hints.push({ content: String(payload.content || ''), finishReason: payload.finish_reason ?? null });
        capture.hintErrors.push(String(payload.content || ''));
        return;
      }
      try {
        applyPatch(state, payload);
      } catch {
        /* 坏补丁忽略 */
      }
      emit();
    });
    return { parser, out, emit, state };
  };

  const ensureEmitter = (entry) => {
    if (
      entry.status >= 200 &&
      entry.status < 300 &&
      !emitter &&
      capture.emittedContent === '' &&
      capture.emittedReasoning === ''
    ) {
      emitter = createEmitter();
      entry.emitter = true;
      return emitter;
    }
    if (entry.emitter) return emitter;
    return null;
  };

  const feedEntry = (entry, chunk) => {
    if (!chunk) return;
    const parserRef = ensureEmitter(entry);
    entry.value += chunk;
    stats.chunks += 1;
    stats.bytes += chunk.length;
    if (!stats.firstByteAt) stats.firstByteAt = Date.now();
    if (!parserRef) return;
    try {
      parserRef.parser.push(chunk);
      parserRef.emit();
    } catch (err) {
      entry.parseError = err.message;
    }
  };

  const finishEntry = (entry) => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.emitter && emitter) {
      try {
        emitter.parser.flush();
        emitter.emit();
      } catch (err) {
        entry.parseError = err.message;
      }
    }
    if (entry.value) stats.cdpBodies += 1;
  };

  /* ------------------------------------------------------------------ *
   * 兜底：Playwright 的整段 body（Network 流不可用时仍然可用）
   * ------------------------------------------------------------------ */

  responseHandler = (res) => {
    if (disposed) return;
    let url = '';
    try {
      url = String(res.url());
    } catch {
      return;
    }
    if (!matches(url)) return;

    let status = 0;
    let headers = {};
    try {
      status = res.status();
      headers = hdrsToObject(res.headers());
    } catch {
      /* ignore */
    }

    const entry = {
      source: 'playwright',
      url: url.split('?')[0],
      status,
      contentType: headerValue(headers, 'content-type'),
      headers,
      at: Date.now(),
      value: '',
      settled: false,
      failed: false,
    };
    entries.push(entry);
    if (!capture.trace) {
      capture.trace = {
        source: 'playwright',
        url: entry.url,
        status,
        headers,
        requestHeaders: null,
        rawOrder: headerNames(headers),
      };
    }

    Promise.resolve()
      .then(() => res.text())
      .then(
        (text) => {
          entry.value = typeof text === 'string' ? text : '';
          entry.settled = true;
          log.debug('hybrid：已抓到页面补全 body（兜底）', { bytes: entry.value.length });
        },
        (err) => {
          entry.failed = true;
          entry.settled = true;
          log.warn('hybrid：兜底读取补全 body 失败', { message: err?.message });
        },
      );
  };
  try {
    page.on('response', responseHandler);
  } catch (err) {
    log.warn('hybrid：无法监听页面响应，增量流不可用', { message: err?.message });
  }

  /* ------------------------------------------------------------------ *
   * 增量：Network.streamResourceContent + Network.dataReceived
   * ------------------------------------------------------------------ */

  const streamReady = (async () => {
    if (stats.mode !== 'incremental') return;
    if (!cdp) {
      stats.mode = 'batch';
      stats.fallbackReason = 'no cdp session';
      return;
    }

    // Network.requestWillBeSentExtraInfo 里有浏览器网络层真正附加的头
    // （Cookie、sec-fetch-*、priority 等），requestWillBeSent 里看不到。
    const extraById = new Map();
    const onExtra = (event) => {
      if (disposed) return;
      const extra = hdrsToObject(event.headers);
      extraById.set(event.requestId, extra);
      const entry = byRequestId.get(event.requestId);
      if (entry) {
        entry.requestHeaders = { ...entry.requestHeaders, ...extra };
        entry.requestHeaderOrder = [...new Set([...entry.requestHeaderOrder, ...Object.keys(extra)])];
        if (capture.trace?.requestId === event.requestId) {
          capture.trace.requestHeaders = entry.requestHeaders;
          capture.trace.rawOrder = entry.requestHeaderOrder;
        }
      }
      if (entry && Array.isArray(event.associatedCookies) && event.associatedCookies.length) {
        entry.cookieNames = event.associatedCookies
          .map((c) => c?.cookie?.name)
          .filter(Boolean);
      }
    };

    const onRequest = (event) => {
      if (disposed) return;
      const url = String(event.request?.url || '');
      if (!matches(url)) return;

      const extra = extraById.get(event.requestId) || {};
      const requestHeaders = { ...hdrsToObject(event.request.headers), ...extra };
      const entry = {
        source: 'network',
        requestId: event.requestId,
        url: url.split('?')[0],
        status: 0,
        contentType: '',
        headers: {},
        requestHeaders,
        requestHeaderOrder: Object.keys(event.request.headers || {}),
        at: Date.now(),
        value: '',
        settled: false,
        failed: false,
      };
      entries.push(entry);
      byRequestId.set(event.requestId, entry);
      if (!capture.trace) {
        capture.trace = {
          source: 'network',
          requestId: event.requestId,
          url: entry.url,
          status: 0,
          headers: {},
          requestHeaders,
          rawOrder: entry.requestHeaderOrder,
        };
      }

      // 立刻开启流式：返回已经到达的 bufferedData，之后每个 chunk 走 dataReceived
      streamPromises.push(
        cdp
          .send('Network.streamResourceContent', { requestId: event.requestId })
          .then((res) => {
            if (disposed) return;
            stats.streamingEnabled = true;
            const buffered = decodeChunk(res?.bufferedData);
            if (buffered) {
              stats.dataEvents += 1;
              feedEntry(entry, buffered);
            }
            log.debug('hybrid：已开启 CDP 流式补全', { bufferedBytes: buffered.length });
          })
          .catch((err) => {
            entry.failed = false;
            stats.fallbackReason = `streamResourceContent: ${err.message}`;
            log.warn('hybrid：Network 流式不可用，改用整段兜底', { message: err.message });
          }),
      );
    };

    const onResponse = (event) => {
      if (disposed) return;
      const entry = byRequestId.get(event.requestId);
      if (!entry) return;
      entry.status = Number(event.response?.status || 0);
      entry.contentType = String(event.response?.mimeType || '');
      entry.headers = hdrsToObject(event.response?.headers);
      if (capture.trace) {
        capture.trace.status = entry.status;
        capture.trace.headers = entry.headers;
      }
    };

    const onData = (event) => {
      if (disposed) return;
      const entry = byRequestId.get(event.requestId);
      if (!entry) return;
      stats.dataEvents += 1;
      const chunk = decodeChunk(event.data);
      if (chunk) feedEntry(entry, chunk);
    };

    const onFinished = (event) => {
      if (disposed) return;
      const entry = byRequestId.get(event.requestId);
      if (!entry) return;
      finishEntry(entry);
    };

    const onFailed = (event) => {
      if (disposed) return;
      const entry = byRequestId.get(event.requestId);
      if (!entry) return;
      entry.failed = true;
      entry.settled = true;
      stats.fallbackReason = `network: ${event.errorText || 'failed'}`;
    };

    const pairs = [
      ['Network.requestWillBeSent', onRequest],
      ['Network.requestWillBeSentExtraInfo', onExtra],
      ['Network.responseReceived', onResponse],
      ['Network.dataReceived', onData],
      ['Network.loadingFinished', onFinished],
      ['Network.loadingFailed', onFailed],
    ];
    for (const [name, handler] of pairs) {
      cdp.on(name, handler);
      networkHandlers.push([name, handler]);
    }
  })();

  /* ------------------------------------------------------------------ *
   * 收集
   * ------------------------------------------------------------------ */

  async function collect({
    timeoutMs = 20_000,
    clickedAt = 0,
    noResponseGraceMs = 15_000,
    signal,
    onTick,
  } = {}) {
    await streamReady;
    const begun = Date.now();
    const deadline = begun + Math.max(1_000, timeoutMs);
    let timedOut = false;
    let noResponse = false;

    for (;;) {
      if (disposed) break;
      if (signal?.aborted) break;
      const pending = entries.filter((entry) => !entry.settled);
      if (entries.length && !pending.length) break;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      if (!entries.length) {
        const silentFor = Date.now() - (clickedAt || begun);
        if (silentFor > noResponseGraceMs) {
          noResponse = true;
          break;
        }
      }
      onTick?.(Date.now() - begun);
      await sleep(50);
    }

    // 等 streamResourceContent 的 bufferedData 落地（最多 300ms）
    await Promise.race([Promise.allSettled(streamPromises), sleep(300)]);

    const bodies = [];
    for (const entry of entries) {
      if (!entry.settled || entry.failed) continue;
      if (typeof entry.value === 'string' && entry.value) bodies.push(entry.value);
    }
    const unique = [...new Set(bodies)];
    const sawResponse = entries.length > 0;
    if (!stats.firstByteAt && stats.firstTokenAt) stats.firstByteAt = stats.firstTokenAt;
    if (stats.mode === 'incremental' && !stats.chunks) {
      stats.mode = sawResponse ? 'batch-fallback' : 'incremental';
    }

    return {
      bodies: unique,
      responses: entries.length,
      cdpResponses: entries.filter((entry) => entry.source === 'network').length,
      sawResponse,
      noResponse,
      timedOut,
      pending: entries.filter((entry) => !entry.settled).length,
      ms: Date.now() - begun,
      stats: { ...stats },
    };
  }

  function hasResponse() {
    return entries.length > 0;
  }

  function pendingCount() {
    return entries.filter((entry) => !entry.settled).length;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      page?.off?.('response', responseHandler);
    } catch {
      /* ignore */
    }
    for (const [name, handler] of networkHandlers) {
      try {
        cdp.off(name, handler);
      } catch {
        /* ignore */
      }
    }
    networkHandlers.length = 0;
  }

  return { collect, dispose, hasResponse, pendingCount, entries, stats, capture, ready: streamReady };
}
