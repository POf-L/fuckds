/**
 * 极简 SSE writer：只依赖 node:http 的 ServerResponse。
 *
 * 头信息延迟到第一次 send 时才写：首字节之前就失败时，服务端还能改用真实 HTTP 状态
 * （429/5xx）返回 JSON，而不是先占住 200 再塞一个只有 error 帧的空流。
 */
export class SseWriter {
  constructor(res, { keepAliveMs = 15_000 } = {}) {
    this.res = res;
    this.closed = false;
    this.started = false;
    this.keepAliveMs = keepAliveMs;
    this.keepAlive = null;
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.res.flushHeaders?.();
    this.keepAlive = setInterval(() => {
      if (!this.closed) this.res.write(': keep-alive\n\n');
    }, this.keepAliveMs);
    this.keepAlive.unref?.();
  }

  send(payload) {
    if (this.closed) return false;
    this.start();
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return this.res.write(`data: ${data}\n\n`);
  }

  done() {
    if (this.closed) return;
    this.send('[DONE]');
    this.end();
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.res.end();
  }
}
