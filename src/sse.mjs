/**
 * OpenAI / Anthropic 两份 SSE writer 原来除了帧格式外几乎逐行相同：
 * 响应头、keep-alive、心跳、end 时的清理各写了一遍。
 * 基类只保留这部分公共逻辑，帧格式由子类决定。
 *
 * 头信息延迟到第一次写帧时才发（start）：首字节之前就失败时，服务端还能改用真实
 * HTTP 状态（429/5xx）返回 JSON，而不是先占住 200 再塞一个只有 error 帧的空流。
 */
export class BaseSse {
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

  writeFrame(frame) {
    if (this.closed) return false;
    this.start();
    return this.res.write(frame);
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.res.end();
  }
}
