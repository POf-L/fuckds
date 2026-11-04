import { ApiError } from '../errors.mjs';
import { countMessagesTokens, normalizeMessagesRequest } from './request.mjs';
import { buildMessageResponse, estimateMessageUsage, newMessageId, parseInput, toolUseId } from './response.mjs';
import { AnthropicSse } from './sse.mjs';

/**
 * Anthropic Messages API 的两个端点：
 *   POST /v1/messages               流式 / 非流式
 *   POST /v1/messages/count_tokens  估算 token
 *
 * 执行逻辑复用 chat-runner，和 OpenAI 端点共享「防自造结果」「超长转附件」。
 * 这里只负责协议差异：块数组、tool_use / tool_result、thinking 块、SSE 事件名。
 */
export function createAnthropicHandler({ config, log, runChat, sendJson }) {
  async function handleMessages(req, res, body) {
    const request = normalizeMessagesRequest(body, config);
    const id = newMessageId();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort(new Error('client disconnected'));
    });

    const onPrompt = (prompt, info) =>
      log.info('转发到网页版（Anthropic）', {
        id,
        model: request.model,
        stream: request.stream,
        promptChars: prompt.length,
        originalChars: info.stats?.chars,
        attachmentChars: info.attachment?.chars ?? 0,
        sections: info.stats?.sections,
        tools: info.stats?.tools,
        toolsDropped: info.sanitize?.stripped?.tools ?? 0,
        toolChoiceDropped: info.sanitize?.stripped?.toolChoice ?? false,
        markupHits: info.sanitize?.markup?.count ?? 0,
        markupTags: info.sanitize?.markup?.byName ?? {},
      });

    if (!request.stream) {
      const result = await runChat(request, { signal: abort.signal, meta: { id }, onPrompt });
      const stopReason = result.toolCalls.length ? 'tool_use' : 'end_turn';
      const payload = buildMessageResponse({
        id,
        model: request.model,
        content: result.content,
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
        stopReason,
        usage: estimateMessageUsage(result.prompt, result.text, result.reasoning),
      });
      log.info('完成（Anthropic）', {
        id,
        chars: result.content.length,
        ms: result.elapsedMs,
        toolCalls: result.toolCalls.length,
        fabricated: result.fabricated,
        protocol: result.protocol,
      });
      return sendJson(res, 200, payload);
    }

    const sse = new AnthropicSse(res);
    let usage = { input_tokens: 0, output_tokens: 0 };
    let started = false;
    let nextIndex = 0;
    /** 当前打开的内容块：{ type: 'thinking' | 'text', index } */
    let open = null;

    const ensureStart = () => {
      if (started) return;
      started = true;
      sse.event('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
        },
      });
    };

    const closeOpen = () => {
      if (!open) return;
      sse.event('content_block_stop', { type: 'content_block_stop', index: open.index });
      open = null;
    };

    const openBlock = (type, block) => {
      closeOpen();
      open = { type, index: nextIndex++ };
      sse.event('content_block_start', {
        type: 'content_block_start',
        index: open.index,
        content_block: block,
      });
    };

    const emitThinking = (text) => {
      ensureStart();
      if (open?.type !== 'thinking') openBlock('thinking', { type: 'thinking', thinking: '' });
      sse.event('content_block_delta', {
        type: 'content_block_delta',
        index: open.index,
        delta: { type: 'thinking_delta', thinking: text },
      });
    };

    const emitText = (text) => {
      ensureStart();
      if (open?.type !== 'text') openBlock('text', { type: 'text', text: '' });
      sse.event('content_block_delta', {
        type: 'content_block_delta',
        index: open.index,
        delta: { type: 'text_delta', text },
      });
    };

    try {
      const result = await runChat(request, {
        signal: abort.signal,
        meta: { id },
        onPrompt: (prompt, info) => {
          onPrompt(prompt, info);
          // 正文/思考可能晚到，先把 message_start 发出去，客户端不至于干等
          usage = estimateMessageUsage(prompt, '');
          ensureStart();
        },
        onContent: emitText,
        onReasoning: emitThinking,
      });

      if (result.fabricated) {
        log.warn('模型输出了自造的工具结果（RESULT），已从流式内容中剔除（Anthropic）', {
          id,
          toolCalls: result.toolCalls.length,
        });
      }

      ensureStart();
      closeOpen();

      for (const [index, call] of result.toolCalls.entries()) {
        const blockIndex = nextIndex++;
        sse.event('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: call.id ?? toolUseId(id, index),
            name: call.name,
            input: {},
          },
        });
        sse.event('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(parseInput(call.arguments)) },
        });
        sse.event('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      }

      // Anthropic 要求至少有一个内容块
      if (nextIndex === 0) {
        openBlock('text', { type: 'text', text: '' });
        closeOpen();
      }

      const stopReason = result.toolCalls.length ? 'tool_use' : 'end_turn';
      const finalUsage = estimateMessageUsage(result.prompt, result.text, result.reasoning);
      sse.event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: finalUsage.output_tokens },
      });
      sse.event('message_stop', { type: 'message_stop' });

      log.info('流式完成（Anthropic）', {
        id,
        chars: result.content.length,
        ms: result.elapsedMs,
        toolCalls: result.toolCalls.length,
        fabricated: result.fabricated,
        protocol: result.protocol,
      });
      sse.end();
    } catch (err) {
      if (res.writableEnded || sse.closed) return;
      const apiError = err instanceof ApiError ? err : new ApiError(500, err.message);
      if (!(err instanceof ApiError) || apiError.status >= 500) log.warn('流式失败:', err.message);
      sse.event('error', {
        type: 'error',
        error: { type: apiError.status >= 500 ? 'api_error' : 'invalid_request_error', message: apiError.message },
      });
      sse.end();
    }
  }

  async function handleCountTokens(req, res, body) {
    return sendJson(res, 200, { input_tokens: countMessagesTokens(body, config) });
  }

  return { handleMessages, handleCountTokens };
}
