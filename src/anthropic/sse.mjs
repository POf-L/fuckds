import { BaseSse } from '../sse.mjs';

/**
 * Anthropic 的 SSE 格式比 OpenAI 多一个 event: 行：
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta",...}
 *
 * data 里也带一份 type，两边保持一致。
 */
export class AnthropicSse extends BaseSse {
  event(name, payload) {
    if (this.closed) return false;
    return this.writeFrame(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}
