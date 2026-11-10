import { BaseSse } from '../sse.mjs';

/**
 * 极简 SSE writer：只依赖 node:http 的 ServerResponse。
 *
 * 头信息由 BaseSse 延迟到第一次 send 时才写：首字节之前就失败时，服务端还能改用
 * 真实 HTTP 状态（429/5xx）返回 JSON，而不是先占住 200 再塞一个只有 error 帧的空流。
 */
export class SseWriter extends BaseSse {
  send(payload) {
    if (this.closed) return false;
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return this.writeFrame(`data: ${data}\n\n`);
  }

  done() {
    if (this.closed) return;
    this.send('[DONE]');
    this.end();
  }
}
